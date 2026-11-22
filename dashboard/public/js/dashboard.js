document.addEventListener('DOMContentLoaded', () => {
    const MAX_STALE_MS = 30000;
    const PRIMARY_DEVICE_ID = 'HYDRO_ESP32_01';
    const TABLE_PREVIEW_LIMIT = 25;

    let activeConfig = {
        minPh: 6.5,
        maxPh: 8.5,
        maxTds: 500,
        maxTurb: 5.0,
        telegramEnabled: true
    };
    let currentData = {
        device_id: PRIMARY_DEVICE_ID,
        temp: null,
        ph: null,
        tds: null,
        turb: null,
        turbidity: null,
        status: 'WAITING',
        timestampMs: null,
        timestamp: null,
        data_source: '--',
        ip_address: null,
        wifi_ssid: null,
        wifi_rssi: null
    };
    let detectedDevices = [PRIMARY_DEVICE_ID];
    let historyCache = [];
    let lastProcessedTimestamp = null;
    let currentCsvPreset = '7D';
    let customStartDate = null;
    let customEndDate = null;
    let showSsidUnmasked = false;
    let captchaExpectedAnswer = 0;

    const yearEl = document.getElementById('copyrightYear');
    if (yearEl) {
        yearEl.innerText = String(new Date().getFullYear());
    }

    // 1. Mobile Menu Toggle
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');
    if (mobileBtn && sidebar) {
        mobileBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && !sidebar.contains(e.target) && !mobileBtn.contains(e.target)) {
                sidebar.classList.remove('open');
            }
        });
    }

    // 2. View Switching Helper
    function openView(targetId) {
        const navItems = document.querySelectorAll('.nav-item');
        const viewSections = document.querySelectorAll('.view-section');

        navItems.forEach(nav => {
            nav.classList.toggle('active', nav.getAttribute('data-target') === targetId);
        });

        const activeNav = Array.from(navItems).find(nav => nav.getAttribute('data-target') === targetId);
        const tabName = activeNav ? activeNav.innerText.trim() : 'Dashboard';
        const isOnlineNow = isDeviceOnline();
        const badgeClass = isOnlineNow ? 'badge' : 'badge offline-badge';
        const badgeText = isOnlineNow ? 'Live' : 'Offline';
        const titleHtml = tabName.includes('Dashboard')
            ? `${tabName} <span class="${badgeClass}" id="liveBadge">${badgeText}</span>`
            : tabName;

        const pageTitleEl = document.getElementById('pageTitle');
        if (pageTitleEl) pageTitleEl.innerHTML = titleHtml;

        viewSections.forEach(view => {
            view.classList.toggle('active-view', view.id === targetId);
            view.classList.toggle('hidden-view', view.id !== targetId);
        });

        if (targetId === 'trends-view') renderTrendsAndLogs();
        if (targetId === 'workflow-view') renderLiveWorkflow();

        [mainChart, historyChart].forEach(c => { if (c) c.resize(); });
        if (window.innerWidth <= 768 && sidebar) sidebar.classList.remove('open');
    }

    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = item.getAttribute('data-target');
            if (targetId) openView(targetId);
        });
    });

    document.getElementById('clearTerminalBtn')?.addEventListener('click', () => {
        const term = document.getElementById('terminalBox');
        if (term) {
            term.innerHTML = '<p class="term-line system">> Terminal cleared. Waiting for live Firebase telemetry...</p>';
        }
    });

    // 3. Live Clock
    const dateTimeEl = document.getElementById('currentDateTime');
    if (dateTimeEl) {
        const updateDateTime = () => {
            const now = new Date();
            const options = { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
            dateTimeEl.innerHTML = `<i class="fas fa-calendar-alt"></i> ${now.toLocaleDateString('en-US', options)}`;
        };
        setInterval(updateDateTime, 1000);
        updateDateTime();
    }

    // 4. Theme Toggle Logic
    const html = document.documentElement;
    const toggle = document.getElementById('themeToggle');
    const toggleIcon = toggle.querySelector('i');

    function applyTheme(theme) {
        html.setAttribute('data-theme', theme);
        if (theme === 'dark') {
            toggleIcon.className = 'fas fa-sun';
            Chart.defaults.color = '#94a3b8';
            Chart.defaults.borderColor = '#334155';
        } else {
            toggleIcon.className = 'fas fa-moon';
            Chart.defaults.color = '#64748b';
            Chart.defaults.borderColor = '#cbd5e1';
        }
    }
    applyTheme(localStorage.getItem('hs_theme') || 'dark');

    toggle.addEventListener('click', () => {
        const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        localStorage.setItem('hs_theme', next);
        applyTheme(next);
        [mainChart, wqiDoughnut, miniTemp, miniPh, miniTds, miniTurb, historyChart].forEach(c => { if (c) c.update(); });
    });

    // 5. Operator Console Modal (Houses Device Mgt, Alerts Log, Dynamic Settings & Guarded Cleanup)
    function generateNewCaptcha() {
        const a = Math.floor(Math.random() * 8) + 2;
        const b = Math.floor(Math.random() * 8) + 1;
        captchaExpectedAnswer = a + b;
        const qEl = document.getElementById('opCaptchaQuestion');
        if (qEl) qEl.innerText = `${a} + ${b} = ?`;
        const ansEl = document.getElementById('opCaptchaInput');
        if (ansEl) ansEl.value = '';
    }

    function formatMaskedSsid(ssid) {
        if (!ssid) return 'Not reported in payload';
        if (showSsidUnmasked) return ssid;
        if (ssid.length <= 2) return `${ssid[0]}*`;
        return `${ssid.slice(0, 2)}${'*'.repeat(Math.min(8, ssid.length - 2))}`;
    }

    function buildOperatorModal() {
        if (document.getElementById('operatorModalOverlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'operatorModalOverlay';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'background:rgba(2,6,23,0.76)',
            'display:none', 'align-items:center', 'justify-content:center',
            'z-index:2500', 'padding:16px'
        ].join(';');

        overlay.innerHTML = `
            <div style="background:var(--bg-panel);color:var(--text-main);border:1px solid var(--border-color);border-radius:12px;max-width:760px;width:100%;max-height:90vh;overflow-y:auto;padding:22px;box-shadow:0 20px 50px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-color);padding-bottom:12px;">
                    <div>
                        <h3 style="font-size:1.15rem;font-weight:700;">Operator Control Console</h3>
                        <p style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">Device Management, Alerts Log, BIS Thresholds &amp; Database Maintenance</p>
                    </div>
                    <button type="button" id="closeOperatorModalBtn" class="icon-btn" aria-label="Close"><i class="fas fa-times"></i></button>
                </div>

                <!-- Operator Sub-Tabs -->
                <div style="display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border-color);padding-bottom:10px;">
                    <button type="button" class="btn-filter active" data-op-tab="op-tab-device"><i class="fas fa-microchip"></i> Device Mgt.</button>
                    <button type="button" class="btn-filter" data-op-tab="op-tab-alerts"><i class="fas fa-exclamation-triangle"></i> Alerts Log</button>
                    <button type="button" class="btn-filter" data-op-tab="op-tab-settings"><i class="fas fa-sliders-h"></i> Settings</button>
                    <button type="button" class="btn-filter" data-op-tab="op-tab-cleanup"><i class="fas fa-broom"></i> Clear Data</button>
                </div>

                <!-- TAB 1: DEVICE MGT -->
                <div id="op-tab-device" class="op-tab-panel" style="display:flex;flex-direction:column;gap:12px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
                        <strong>ESP32-WROOM Node A (${PRIMARY_DEVICE_ID})</strong>
                        <span class="status-badge bg-danger" id="opDeviceStatusBadge">Offline</span>
                    </div>
                    <div class="device-stats device-stats-3">
                        <div class="d-stat"><span>Architecture</span><strong>ESP32-WROOM-32</strong></div>
                        <div class="d-stat"><span>Detected Nodes</span><strong id="opDetectedDevices">${PRIMARY_DEVICE_ID}</strong></div>
                        <div class="d-stat"><span>Data Source</span><strong id="opDeviceSource">--</strong></div>
                        <div class="d-stat"><span>IP Address</span><strong id="opDeviceIp">Not reported</strong></div>
                        <div class="d-stat">
                            <span>Wi-Fi SSID</span>
                            <div class="inline-secret-row">
                                <strong id="opDeviceSsid">Not reported</strong>
                                <button type="button" class="btn-outline btn-xs" id="opToggleSsidBtn">Show/Mask</button>
                            </div>
                        </div>
                        <div class="d-stat"><span>Wi-Fi Password</span><strong>Hidden for Security</strong></div>
                        <div class="d-stat"><span>Signal (RSSI)</span><strong id="opDeviceRssi">--</strong></div>
                        <div class="d-stat"><span>Last Telemetry Seen</span><strong id="opDeviceLastSeen">Never</strong></div>
                        <div class="d-stat"><span>Connection State</span><strong id="opDeviceConnNote">No recent data</strong></div>
                    </div>
                </div>

                <!-- TAB 2: ALERTS LOG -->
                <div id="op-tab-alerts" class="op-tab-panel" style="display:none;flex-direction:column;gap:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                        <span style="font-size:0.88rem;color:var(--text-muted);">Recent threshold &amp; status violations (latest 30)</span>
                        <span style="font-size:0.85rem;">Telegram Bot: <strong id="opAlertsBotStatus">Checking...</strong></span>
                    </div>
                    <div class="table-responsive" style="max-height:320px;overflow-y:auto;">
                        <table class="data-table">
                            <thead>
                                <tr>
                                    <th>Timestamp</th>
                                    <th>Trigger</th>
                                    <th>Reading vs Limit</th>
                                    <th>Log</th>
                                </tr>
                            </thead>
                            <tbody id="opAlertsTableBody">
                                <tr><td colspan="4">Loading alerts...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- TAB 3: DYNAMIC SETTINGS -->
                <div id="op-tab-settings" class="op-tab-panel" style="display:none;">
                    <form class="settings-form" id="opSettingsForm">
                        <div class="form-group">
                            <label for="opTelegramSelect">Telegram Bot Notifications (Unsafe + Device Offline)</label>
                            <select id="opTelegramSelect" class="form-control">
                                <option value="true">Enabled</option>
                                <option value="false">Disabled</option>
                            </select>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label for="opMinPhInput">Min Safe pH</label>
                                <input type="number" step="0.1" id="opMinPhInput" class="form-control" value="6.5" required>
                            </div>
                            <div class="form-group">
                                <label for="opMaxPhInput">Max Safe pH</label>
                                <input type="number" step="0.1" id="opMaxPhInput" class="form-control" value="8.5" required>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label for="opMaxTdsInput">Max Safe TDS (ppm)</label>
                                <input type="number" step="1" id="opMaxTdsInput" class="form-control" value="500" required>
                            </div>
                            <div class="form-group">
                                <label for="opMaxTurbInput">Max Safe Turbidity (NTU)</label>
                                <input type="number" step="0.1" id="opMaxTurbInput" class="form-control" value="5.0" required>
                            </div>
                        </div>
                        <div class="form-actions-row">
                            <button class="btn-primary btn-sm" type="submit"><i class="fas fa-save"></i> Save Configurations</button>
                            <span id="opSettingsStatus" class="form-status"></span>
                        </div>
                    </form>
                </div>

                <!-- TAB 4: GUARDED CLEAR STORED LOGS -->
                <div id="op-tab-cleanup" class="op-tab-panel" style="display:none;flex-direction:column;gap:10px;">
                    <div style="font-size:0.9rem;font-weight:700;color:var(--accent-danger);">
                        <i class="fas fa-trash-alt"></i> Clear Stored Telemetry Logs
                    </div>
                    <p style="font-size:0.8rem;color:var(--text-muted);line-height:1.45;">
                        Use this before connecting calibrated physical sensors to clear simulated/test logs from Firebase. Enter exact Device ID (<strong>${PRIMARY_DEVICE_ID}</strong>) and solve the verification check.
                    </p>
                    <div class="form-row">
                        <div class="form-group">
                            <label for="opConfirmDeviceInput">Confirm Device ID</label>
                            <input type="text" id="opConfirmDeviceInput" class="form-control" placeholder="Type ${PRIMARY_DEVICE_ID}" autocomplete="off">
                        </div>
                        <div class="form-group">
                            <label for="opCaptchaInput">Verification (<span id="opCaptchaQuestion"></span>)</label>
                            <input type="number" id="opCaptchaInput" class="form-control" placeholder="Enter sum">
                        </div>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;font-size:0.8rem;color:var(--text-muted);cursor:pointer;">
                        <input type="checkbox" id="opClearLatestChk"> Also reset current latest reading snapshot
                    </label>
                    <div class="form-actions-row">
                        <button type="button" id="opExecuteClearBtn" class="btn-primary btn-sm" style="background:var(--accent-danger);"><i class="fas fa-broom"></i> Clear Stored Logs</button>
                        <span id="opActionStatus" class="form-status"></span>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const closeModal = () => {
            overlay.style.display = 'none';
            const st = document.getElementById('opActionStatus');
            if (st) st.innerText = '';
            const setSt = document.getElementById('opSettingsStatus');
            if (setSt) setSt.innerText = '';
        };

        document.getElementById('closeOperatorModalBtn')?.addEventListener('click', closeModal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        overlay.querySelectorAll('[data-op-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('[data-op-tab]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const targetPanel = btn.getAttribute('data-op-tab');
                overlay.querySelectorAll('.op-tab-panel').forEach(p => {
                    p.style.display = p.id === targetPanel ? 'flex' : 'none';
                });
                if (targetPanel === 'op-tab-alerts') renderOperatorAlerts();
                if (targetPanel === 'op-tab-device') syncDevicePresenceUI();
            });
        });

        document.getElementById('opToggleSsidBtn')?.addEventListener('click', () => {
            showSsidUnmasked = !showSsidUnmasked;
            syncDevicePresenceUI();
        });

        // Settings Form inside Operator Modal
        document.getElementById('opSettingsForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const statusEl = document.getElementById('opSettingsStatus');
            const minPh = Number(document.getElementById('opMinPhInput').value);
            const maxPh = Number(document.getElementById('opMaxPhInput').value);
            const maxTds = Number(document.getElementById('opMaxTdsInput').value);
            const maxTurb = Number(document.getElementById('opMaxTurbInput').value);
            const telegramEnabled = document.getElementById('opTelegramSelect').value === 'true';

            if (Number.isNaN(minPh) || Number.isNaN(maxPh) || minPh < 0 || maxPh > 14 || minPh >= maxPh) {
                if (statusEl) {
                    statusEl.style.color = 'var(--accent-danger)';
                    statusEl.innerText = 'Invalid pH range (0 <= Min < Max <= 14).';
                }
                return;
            }
            if (Number.isNaN(maxTds) || maxTds <= 0 || Number.isNaN(maxTurb) || maxTurb <= 0) {
                if (statusEl) {
                    statusEl.style.color = 'var(--accent-danger)';
                    statusEl.innerText = 'TDS and Turbidity limits must be positive.';
                }
                return;
            }

            try {
                if (statusEl) {
                    statusEl.style.color = 'var(--text-muted)';
                    statusEl.innerText = 'Saving to Firebase...';
                }
                await window.saveHydroSenseConfig({ minPh, maxPh, maxTds, maxTurb, telegramEnabled });
                activeConfig = { minPh, maxPh, maxTds, maxTurb, telegramEnabled };
                renderOperatorAlerts();
                if (currentData.timestampMs) applyReadingToUI(currentData, false);
                if (statusEl) {
                    statusEl.style.color = 'var(--accent-success)';
                    statusEl.innerText = 'Saved & synced!';
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.style.color = 'var(--accent-danger)';
                    statusEl.innerText = `Save failed: ${err.message}`;
                }
            }
        });

        // Guarded Clear Logs
        document.getElementById('opExecuteClearBtn')?.addEventListener('click', async () => {
            const st = document.getElementById('opActionStatus');
            const typedId = (document.getElementById('opConfirmDeviceInput')?.value || '').trim();
            const captchaVal = Number(document.getElementById('opCaptchaInput')?.value);
            const alsoLatest = Boolean(document.getElementById('opClearLatestChk')?.checked);

            if (typedId !== PRIMARY_DEVICE_ID) {
                if (st) {
                    st.style.color = 'var(--accent-danger)';
                    st.innerText = `Type exact Device ID: ${PRIMARY_DEVICE_ID}`;
                }
                return;
            }

            if (Number.isNaN(captchaVal) || captchaVal !== captchaExpectedAnswer) {
                if (st) {
                    st.style.color = 'var(--accent-danger)';
                    st.innerText = 'Incorrect verification answer.';
                }
                generateNewCaptcha();
                return;
            }

            try {
                if (st) {
                    st.style.color = 'var(--text-muted)';
                    st.innerText = 'Clearing stored logs...';
                }
                await window.clearHydroSenseStoredLogs(PRIMARY_DEVICE_ID, alsoLatest);
                historyCache = [];
                if (alsoLatest) {
                    currentData = {
                        ...currentData,
                        temp: null,
                        ph: null,
                        tds: null,
                        turb: null,
                        turbidity: null,
                        status: 'WAITING',
                        timestampMs: null,
                        timestamp: null
                    };
                    lastProcessedTimestamp = null;
                    document.getElementById('val-temp').innerText = '--';
                    document.getElementById('val-ph').innerText = '--';
                    document.getElementById('val-tds').innerText = '--';
                    document.getElementById('val-turb').innerText = '--';
                    document.getElementById('wqiLabelTxt').innerText = 'WAITING';
                    syncDevicePresenceUI();
                }
                renderTrendsAndLogs();
                renderOperatorAlerts();
                const devInput = document.getElementById('opConfirmDeviceInput');
                if (devInput) devInput.value = '';
                generateNewCaptcha();
                if (st) {
                    st.style.color = 'var(--accent-success)';
                    st.innerText = 'Stored logs cleared from Firebase.';
                }
            } catch (err) {
                if (st) {
                    st.style.color = 'var(--accent-danger)';
                    st.innerText = `Clear failed: ${err.message}`;
                }
            }
        });
    }

    buildOperatorModal();

    document.getElementById('operatorProfileBtn')?.addEventListener('click', () => {
        buildOperatorModal();
        populateOperatorSettings(activeConfig);
        syncDevicePresenceUI();
        renderOperatorAlerts();
        generateNewCaptcha();
        const overlay = document.getElementById('operatorModalOverlay');
        if (overlay) overlay.style.display = 'flex';
    });

    function populateOperatorSettings(cfg) {
        const tgEl = document.getElementById('opTelegramSelect');
        const minPhEl = document.getElementById('opMinPhInput');
        const maxPhEl = document.getElementById('opMaxPhInput');
        const maxTdsEl = document.getElementById('opMaxTdsInput');
        const maxTurbEl = document.getElementById('opMaxTurbInput');

        if (tgEl) tgEl.value = String(Boolean(cfg.telegramEnabled));
        if (minPhEl) minPhEl.value = cfg.minPh;
        if (maxPhEl) maxPhEl.value = cfg.maxPh;
        if (maxTdsEl) maxTdsEl.value = cfg.maxTds;
        if (maxTurbEl) maxTurbEl.value = cfg.maxTurb;
    }

    // 6. Device Presence & Metadata Sync
    function isDeviceOnline() {
        if (!currentData.timestampMs) return false;
        return (Date.now() - currentData.timestampMs) <= MAX_STALE_MS;
    }

    function syncDevicePresenceUI() {
        const online = isDeviceOnline();
        const liveBadge = document.getElementById('liveBadge');
        if (liveBadge) {
            liveBadge.className = online ? 'badge' : 'badge offline-badge';
            liveBadge.innerText = online ? 'Live' : 'Offline';
        }

        const opBadge = document.getElementById('opDeviceStatusBadge');
        const opDetected = document.getElementById('opDetectedDevices');
        const opSrc = document.getElementById('opDeviceSource');
        const opIp = document.getElementById('opDeviceIp');
        const opSsid = document.getElementById('opDeviceSsid');
        const opRssi = document.getElementById('opDeviceRssi');
        const opSeen = document.getElementById('opDeviceLastSeen');
        const opConn = document.getElementById('opDeviceConnNote');

        if (opBadge) {
            opBadge.className = online ? 'status-badge bg-normal' : 'status-badge bg-danger';
            opBadge.innerText = online ? 'Online' : 'Offline';
        }
        if (opDetected) opDetected.innerText = detectedDevices.join(', ');
        if (opSrc) opSrc.innerText = currentData.data_source || '--';
        if (opIp) opIp.innerText = currentData.ip_address || 'Not reported in payload';
        if (opSsid) opSsid.innerText = formatMaskedSsid(currentData.wifi_ssid);
        if (opRssi) opRssi.innerText = currentData.wifi_rssi !== null ? `${currentData.wifi_rssi} dBm` : 'Not reported in payload';
        if (opSeen) opSeen.innerText = currentData.timestamp ? new Date(currentData.timestamp).toLocaleString() : 'Never';
        if (opConn) {
            if (!currentData.timestampMs) {
                opConn.innerText = 'No telemetry received yet';
            } else if (online) {
                opConn.innerText = 'Active stream within 30s';
            } else {
                const secAgo = Math.round((Date.now() - currentData.timestampMs) / 1000);
                opConn.innerText = `Offline (${secAgo}s ago)`;
            }
        }

        renderLiveWorkflow();
    }

    window.addEventListener('hydrosense:devices', (e) => {
        if (Array.isArray(e.detail) && e.detail.length) {
            detectedDevices = e.detail;
            syncDevicePresenceUI();
        }
    });

    setInterval(syncDevicePresenceUI, 5000);

    // 7. Chart Setups
    Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
    const hideScales = { x: { display: false }, y: { display: false } };
    const miniChartOpts = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: hideScales,
        layout: { padding: 0 },
        elements: { point: { radius: 0 } },
        animation: { duration: 400 }
    };

    const createMiniChart = (id, color) => {
        const ctx = document.getElementById(id).getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 50);
        gradient.addColorStop(0, color + '66');
        gradient.addColorStop(1, color + '00');
        return new Chart(ctx, {
            type: 'line',
            data: {
                labels: Array(20).fill(''),
                datasets: [{ data: Array(20).fill(null), borderColor: color, backgroundColor: gradient, borderWidth: 2, fill: true, tension: 0.4 }]
            },
            options: miniChartOpts
        });
    };

    const miniTemp = createMiniChart('mini-temp', '#0ea5e9');
    const miniPh = createMiniChart('mini-ph', '#a855f7');
    const miniTds = createMiniChart('mini-tds', '#f59e0b');
    const miniTurb = createMiniChart('mini-turb', '#10b981');

    const ctxMain = document.getElementById('mainTrendChart').getContext('2d');
    const mainChart = new Chart(ctxMain, {
        type: 'line',
        data: {
            labels: Array(20).fill(''),
            datasets: [
                { label: 'Temp (°C)', data: Array(20).fill(null), borderColor: '#0ea5e9', borderWidth: 2.5, tension: 0.4, pointRadius: 2 },
                { label: 'pH (x10)', data: Array(20).fill(null), borderColor: '#a855f7', borderWidth: 2.5, tension: 0.4, pointRadius: 2 },
                { label: 'TDS (/10)', data: Array(20).fill(null), borderColor: '#f59e0b', borderWidth: 2.5, tension: 0.4, pointRadius: 2 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 500, easing: 'easeOutQuart' },
            plugins: { legend: { display: false } },
            scales: {
                y: { min: 0, max: 100, ticks: { stepSize: 20 } },
                x: { grid: { display: false } }
            },
            interaction: { mode: 'index', intersect: false }
        }
    });

    const ctxWqi = document.getElementById('wqiChart').getContext('2d');
    const wqiDoughnut = new Chart(ctxWqi, {
        type: 'doughnut',
        data: {
            labels: ['Status', 'Remainder'],
            datasets: [{ data: [0, 100], backgroundColor: ['#334155', '#334155'], borderWidth: 0, cutout: '80%', circumference: 360, rotation: 270 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });

    // Historical Graph & Lightweight Recent Logs Table (Top 25 Rows)
    const ctxHist = document.getElementById('historyChart').getContext('2d');
    const historyChart = new Chart(ctxHist, {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Sensor Value', data: [], backgroundColor: '#a855f7', borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

    function buildCsvString(rows) {
        const headers = ['DateTime', 'Device_ID', 'Temperature_C', 'pH', 'TDS_ppm', 'Turbidity_NTU', 'Status', 'Data_Source'];
        const csvLines = [headers.join(',')];
        rows.forEach(r => {
            const cols = [
                `"${new Date(r.timestampMs).toLocaleString().replace(/"/g, '""')}"`,
                `"${r.device_id}"`,
                r.temp,
                r.ph,
                r.tds,
                r.turbidity,
                `"${r.status}"`,
                `"${r.data_source}"`
            ];
            csvLines.push(cols.join(','));
        });
        return csvLines.join('\n');
    }

    function formatByteSize(bytes) {
        if (!bytes || bytes <= 0) return '0 KB';
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function updateCsvButtonMeta(rows) {
        const csvCountEl = document.getElementById('csvExportCount');
        if (!csvCountEl) return;
        const csvText = buildCsvString(rows);
        const approxBytes = new Blob([csvText], { type: 'text/csv;charset=utf-8;' }).size;
        csvCountEl.innerText = `${rows.length} rows • ${formatByteSize(approxBytes)}`;
    }

    function getCsvExportRows() {
        let rows = [...historyCache];
        if (customStartDate || customEndDate) {
            const startMs = customStartDate ? new Date(`${customStartDate}T00:00:00`).getTime() : -Infinity;
            const endMs = customEndDate ? new Date(`${customEndDate}T23:59:59.999`).getTime() : Infinity;
            rows = rows.filter(item => item.timestampMs >= startMs && item.timestampMs <= endMs);
        } else {
            const nowMs = Date.now();
            const rangeMap = {
                '24H': 24 * 60 * 60 * 1000,
                '7D': 7 * 24 * 60 * 60 * 1000,
                '30D': 30 * 24 * 60 * 60 * 1000,
                'ALL': Infinity
            };
            const maxAge = rangeMap[currentCsvPreset] ?? rangeMap['7D'];
            if (Number.isFinite(maxAge)) {
                rows = rows.filter(item => (nowMs - item.timestampMs) <= maxAge);
            }
        }
        return rows;
    }

    function renderHistoryLogsTable(csvRows) {
        const tbody = document.getElementById('historyLogsTableBody');
        const totalEl = document.getElementById('filteredLogCount');
        const visibleEl = document.getElementById('visibleLogCount');
        if (totalEl) totalEl.innerText = String(historyCache.length);
        if (!tbody) return;

        if (!historyCache.length) {
            if (visibleEl) visibleEl.innerText = '0';
            tbody.innerHTML = '<tr><td colspan="8">No Firebase records available.</td></tr>';
            updateCsvButtonMeta([]);
            return;
        }

        const recentSlice = [...historyCache].reverse().slice(0, TABLE_PREVIEW_LIMIT);
        if (visibleEl) visibleEl.innerText = String(recentSlice.length);

        tbody.innerHTML = recentSlice.map(item => {
            const dtStr = new Date(item.timestampMs).toLocaleString();
            const badgeCls = item.status === 'POTABLE' ? 'bg-normal' : 'bg-danger';
            return `<tr>
                <td>${dtStr}</td>
                <td>${item.device_id}</td>
                <td>${item.temp}</td>
                <td>${item.ph}</td>
                <td>${item.tds}</td>
                <td>${item.turbidity}</td>
                <td><span class="status-badge ${badgeCls}">${item.status}</span></td>
                <td>${item.data_source}</td>
            </tr>`;
        }).join('');

        updateCsvButtonMeta(csvRows);
    }

    function renderTrendsAndLogs() {
        const csvRows = getCsvExportRows();
        const metric = document.getElementById('trendMetricSelect')?.value || 'ph';
        const colorMap = {
            ph: '#a855f7',
            tds: '#f59e0b',
            turbidity: '#10b981',
            temp: '#0ea5e9'
        };

        const chartSubset = historyCache.slice(-30);
        historyChart.data.labels = chartSubset.map(item => {
            const d = new Date(item.timestampMs);
            return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        });
        historyChart.data.datasets[0].label = metric.toUpperCase();
        historyChart.data.datasets[0].data = chartSubset.map(item => item[metric]);
        historyChart.data.datasets[0].backgroundColor = colorMap[metric] || '#0ea5e9';
        historyChart.update();

        renderHistoryLogsTable(csvRows);
    }

    document.getElementById('trendMetricSelect')?.addEventListener('change', renderTrendsAndLogs);

    document.querySelectorAll('[data-csv-range]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-csv-range]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCsvPreset = btn.getAttribute('data-csv-range');
            customStartDate = null;
            customEndDate = null;
            const startEl = document.getElementById('historyStartDate');
            const endEl = document.getElementById('historyEndDate');
            if (startEl) startEl.value = '';
            if (endEl) endEl.value = '';
            renderTrendsAndLogs();
        });
    });

    function syncCsvDates() {
        customStartDate = document.getElementById('historyStartDate')?.value || null;
        customEndDate = document.getElementById('historyEndDate')?.value || null;
        if (customStartDate || customEndDate) {
            document.querySelectorAll('[data-csv-range]').forEach(b => b.classList.remove('active'));
        }
        renderTrendsAndLogs();
    }

    document.getElementById('historyStartDate')?.addEventListener('change', syncCsvDates);
    document.getElementById('historyEndDate')?.addEventListener('change', syncCsvDates);

    document.getElementById('resetDateFilterBtn')?.addEventListener('click', () => {
        customStartDate = null;
        customEndDate = null;
        currentCsvPreset = '7D';
        const startEl = document.getElementById('historyStartDate');
        const endEl = document.getElementById('historyEndDate');
        if (startEl) startEl.value = '';
        if (endEl) endEl.value = '';
        document.querySelectorAll('[data-csv-range]').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-csv-range') === '7D');
        });
        renderTrendsAndLogs();
    });

    document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
        const rows = getCsvExportRows();
        const csvContent = buildCsvString(rows);
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `HydroSense_Logs_${Date.now()}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });

    // Operator Alerts Log Renderer
    function renderOperatorAlerts() {
        const tbody = document.getElementById('opAlertsTableBody');
        const botLabel = document.getElementById('opAlertsBotStatus');
        if (botLabel) {
            botLabel.innerText = activeConfig.telegramEnabled ? 'Enabled' : 'Disabled';
            botLabel.style.color = activeConfig.telegramEnabled ? 'var(--accent-success)' : 'var(--accent-warning)';
        }
        if (!tbody) return;

        const alerts = [];
        historyCache.forEach(item => {
            const violations = [];
            if (item.ph < activeConfig.minPh || item.ph > activeConfig.maxPh) {
                violations.push({
                    trigger: 'pH Out of Limit',
                    actual: `${item.ph} pH`,
                    limit: `${activeConfig.minPh} - ${activeConfig.maxPh}`,
                    badge: 'bg-danger'
                });
            }
            if (item.tds > activeConfig.maxTds) {
                violations.push({
                    trigger: 'High TDS',
                    actual: `${item.tds} ppm`,
                    limit: `<= ${activeConfig.maxTds}`,
                    badge: 'bg-warning'
                });
            }
            if (item.turbidity > activeConfig.maxTurb) {
                violations.push({
                    trigger: 'High Turbidity',
                    actual: `${item.turbidity} NTU`,
                    limit: `<= ${activeConfig.maxTurb}`,
                    badge: 'bg-warning'
                });
            }
            if (!violations.length && item.status !== 'POTABLE') {
                violations.push({
                    trigger: 'Non-Potable',
                    actual: `pH ${item.ph}, TDS ${item.tds}, Turb ${item.turbidity}`,
                    limit: 'Configured limits',
                    badge: 'bg-danger'
                });
            }

            violations.forEach(v => alerts.push({ timestampMs: item.timestampMs, ...v }));
        });

        alerts.sort((a, b) => b.timestampMs - a.timestampMs);

        if (!alerts.length) {
            tbody.innerHTML = '<tr><td colspan="4">No threshold violations recorded.</td></tr>';
            return;
        }

        tbody.innerHTML = alerts.slice(0, 30).map(al => `
            <tr>
                <td>${new Date(al.timestampMs).toLocaleString()}</td>
                <td><span class="status-badge ${al.badge}">${al.trigger}</span></td>
                <td>${al.actual} (Limit: ${al.limit})</td>
                <td>Firebase</td>
            </tr>
        `).join('');
    }

    // Live System Workflow Renderer (Sensor Unreachable when ESP32 Offline)
    function setNodeState(nodeId, badgeId, stateType, badgeText) {
        const node = document.getElementById(nodeId);
        const badge = document.getElementById(badgeId);
        if (node) {
            node.classList.remove('node-active', 'node-fault');
            if (stateType === 'ok') node.classList.add('node-active');
            if (stateType === 'fault') node.classList.add('node-fault');
        }
        if (badge) {
            badge.className = `status-badge ${stateType === 'fault' ? 'bg-danger' : stateType === 'warn' ? 'bg-warning' : 'bg-normal'}`;
            badge.innerText = badgeText;
        }
    }

    function renderLiveWorkflow() {
        const diagMsg = document.getElementById('simDiagnosticMsg');
        const c1 = document.getElementById('conn-1');
        const c2 = document.getElementById('conn-2');
        c1?.classList.remove('connector-broken');
        c2?.classList.remove('connector-broken');

        const online = isDeviceOnline();
        const hasReading = currentData.timestampMs !== null;
        const isPotable = currentData.status === 'POTABLE';

        if (!hasReading) {
            setNodeState('node-sensors', 'flowBadgeSensors', 'warn', 'Awaiting');
            setNodeState('node-esp32', 'flowBadgeEsp', 'fault', 'Offline');
            setNodeState('node-rules', 'flowBadgeRules', 'warn', 'Standby');
            setNodeState('node-firebase', 'flowBadgeFirebase', 'ok', 'Connected');
            setNodeState('node-ui-alert', 'flowBadgeAlert', 'ok', activeConfig.telegramEnabled ? 'UI + Bot Ready' : 'UI Only');
            c1?.classList.add('connector-broken');
            c2?.classList.add('connector-broken');
            if (diagMsg) diagMsg.innerText = 'Firebase RTDB is connected; waiting for sensor telemetry.';
            return;
        }

        if (!online) {
            setNodeState('node-sensors', 'flowBadgeSensors', 'warn', 'Unreachable');
            setNodeState('node-esp32', 'flowBadgeEsp', 'fault', 'Offline');
            setNodeState('node-rules', 'flowBadgeRules', 'warn', `Last: ${currentData.status}`);
            setNodeState('node-firebase', 'flowBadgeFirebase', 'ok', 'Cached');
            setNodeState('node-ui-alert', 'flowBadgeAlert', 'warn', 'Device Offline');
            c1?.classList.add('connector-broken');
            c2?.classList.add('connector-broken');

            const secAgo = Math.round((Date.now() - currentData.timestampMs) / 1000);
            if (diagMsg) {
                diagMsg.innerText = `ESP32 is currently Offline (last reading was ${secAgo}s ago), so live sensor state is unreachable. Last stored status: ${currentData.status}.`;
            }
            return;
        }

        setNodeState('node-sensors', 'flowBadgeSensors', 'ok', 'Reporting');
        setNodeState('node-esp32', 'flowBadgeEsp', 'ok', 'Online');
        setNodeState('node-rules', 'flowBadgeRules', isPotable ? 'ok' : 'fault', isPotable ? 'Within Limits' : 'Exceeds Limit');
        setNodeState('node-firebase', 'flowBadgeFirebase', 'ok', 'Synced');
        setNodeState('node-ui-alert', 'flowBadgeAlert', isPotable ? 'ok' : 'warn', activeConfig.telegramEnabled ? 'UI + Bot Ready' : 'UI Only');

        if (diagMsg) {
            diagMsg.innerText = `ESP32 is online (last reading ${new Date(currentData.timestampMs).toLocaleTimeString()}); status is ${currentData.status}.`;
        }
    }

    function pushMiniPoint(chart, val) {
        const arr = chart.data.datasets[0].data;
        const nullIdx = arr.indexOf(null);
        if (nullIdx !== -1) {
            arr[nullIdx] = val;
        } else {
            arr.push(val);
            arr.shift();
        }
        chart.update('none');
    }

    function pushMainPoint(data, timeStr) {
        const d0 = mainChart.data.datasets[0].data;
        const d1 = mainChart.data.datasets[1].data;
        const d2 = mainChart.data.datasets[2].data;
        const labels = mainChart.data.labels;

        const nullIdx = d0.indexOf(null);
        if (nullIdx !== -1) {
            d0[nullIdx] = data.temp;
            d1[nullIdx] = Number((data.ph * 10).toFixed(1));
            d2[nullIdx] = Number((data.tds / 10).toFixed(1));
            labels[nullIdx] = timeStr;
        } else {
            d0.push(data.temp); d0.shift();
            d1.push(Number((data.ph * 10).toFixed(1))); d1.shift();
            d2.push(Number((data.tds / 10).toFixed(1))); d2.shift();
            labels.push(timeStr); labels.shift();
        }
        mainChart.update();
    }

    function applyReadingToUI(data, appendToCharts = true) {
        const safeTemp = Number.isFinite(Number(data.temp)) ? Number(data.temp) : 0;
        const safePh = Number.isFinite(Number(data.ph)) ? Number(data.ph) : 0;
        const safeTds = Number.isFinite(Number(data.tds)) ? Number(data.tds) : 0;
        const safeTurb = Number.isFinite(Number(data.turbidity)) ? Number(data.turbidity) : 0;

        currentData = {
            device_id: data.device_id || PRIMARY_DEVICE_ID,
            temp: safeTemp,
            ph: safePh,
            tds: safeTds,
            turb: safeTurb,
            turbidity: safeTurb,
            status: data.status,
            timestampMs: data.timestampMs,
            timestamp: data.timestamp,
            data_source: data.data_source,
            ip_address: data.ip_address || currentData.ip_address,
            wifi_ssid: data.wifi_ssid || currentData.wifi_ssid,
            wifi_rssi: data.wifi_rssi !== null && data.wifi_rssi !== undefined ? data.wifi_rssi : currentData.wifi_rssi
        };

        document.getElementById('val-temp').innerText = safeTemp;
        document.getElementById('val-ph').innerText = safePh;
        document.getElementById('val-tds').innerText = safeTds;
        document.getElementById('val-turb').innerText = safeTurb;

        const repTemp = document.getElementById('repLastTemp');
        const repPh = document.getElementById('repLastPh');
        const repTds = document.getElementById('repLastTds');
        const repTurb = document.getElementById('repLastTurb');
        if (repTemp) repTemp.innerText = `${safeTemp.toFixed(1)} °C`;
        if (repPh) repPh.innerText = `${safePh.toFixed(2)}`;
        if (repTds) repTds.innerText = `${Math.round(safeTds)} ppm`;
        if (repTurb) repTurb.innerText = `${safeTurb.toFixed(2)} NTU`;

        const phOk = safePh >= activeConfig.minPh && safePh <= activeConfig.maxPh;
        const tdsOk = safeTds <= activeConfig.maxTds;
        const turbOk = safeTurb <= activeConfig.maxTurb;
        const overallPotable = data.status === 'POTABLE' && phOk && tdsOk && turbOk;

        const wqiLabel = document.getElementById('wqiLabelTxt');
        const wqiSub = document.getElementById('wqiReasonTxt');
        wqiLabel.innerText = overallPotable ? 'POTABLE' : 'NON-POTABLE';

        if (overallPotable) {
            wqiLabel.style.color = 'var(--accent-success)';
            if (wqiSub) wqiSub.innerText = 'Within configured limits';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#22c55e', '#1e293b'];
            wqiDoughnut.data.datasets[0].data = [100, 0];
        } else {
            wqiLabel.style.color = 'var(--accent-danger)';
            if (wqiSub) wqiSub.innerText = 'Limit exceeded';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#ef4444', '#1e293b'];
            wqiDoughnut.data.datasets[0].data = [100, 0];
        }
        wqiDoughnut.update();
        syncDevicePresenceUI();

        const d = new Date(data.timestampMs);
        const timeStr = Number.isNaN(d.getTime()) ? new Date().toLocaleTimeString() : d.toLocaleTimeString();

        const term = document.getElementById('terminalBox');
        if (term) {
            const p = document.createElement('p');
            p.className = overallPotable ? 'term-line data' : 'term-line alert';
            p.innerText = `> [${timeStr}] FIREBASE_SYNC [${data.device_id}]: {"temp":${safeTemp}, "ph":${safePh}, "tds":${safeTds}, "turb":${safeTurb}} -> ${overallPotable ? 'POTABLE' : 'NON-POTABLE'}`;
            term.appendChild(p);
            if (term.childElementCount > 100) term.removeChild(term.firstChild);
            term.scrollTop = term.scrollHeight;
        }

        if (appendToCharts) {
            pushMiniPoint(miniTemp, safeTemp);
            pushMiniPoint(miniPh, safePh);
            pushMiniPoint(miniTds, safeTds);
            pushMiniPoint(miniTurb, safeTurb);
            pushMainPoint({ temp: safeTemp, ph: safePh, tds: safeTds }, timeStr);
        }
    }

    // 8. Dynamic Config Listener
    window.addEventListener('hydrosense:config', (e) => {
        if (!e.detail) return;
        activeConfig = { ...activeConfig, ...e.detail };
        populateOperatorSettings(activeConfig);
        renderOperatorAlerts();
        if (currentData.timestampMs) {
            applyReadingToUI(currentData, false);
        }
    });

    // 9. Listen to Firebase History Event
    window.addEventListener('hydrosense:history', (e) => {
        const list = e.detail || [];
        historyCache = list;

        const latestWithMeta = [...list].reverse().find(r => r.ip_address || r.wifi_ssid || r.wifi_rssi !== null);
        if (latestWithMeta) {
            currentData.ip_address = currentData.ip_address || latestWithMeta.ip_address;
            currentData.wifi_ssid = currentData.wifi_ssid || latestWithMeta.wifi_ssid;
            if (currentData.wifi_rssi === null) currentData.wifi_rssi = latestWithMeta.wifi_rssi;
        }

        if (list.length) {
            const recent = list.slice(-20);
            const padCount = 20 - recent.length;
            const padNulls = Array(padCount).fill(null);

            miniTemp.data.datasets[0].data = [...padNulls, ...recent.map(r => r.temp)];
            miniPh.data.datasets[0].data = [...padNulls, ...recent.map(r => r.ph)];
            miniTds.data.datasets[0].data = [...padNulls, ...recent.map(r => r.tds)];
            miniTurb.data.datasets[0].data = [...padNulls, ...recent.map(r => r.turbidity)];
            [miniTemp, miniPh, miniTds, miniTurb].forEach(c => c.update('none'));

            mainChart.data.labels = [...Array(padCount).fill(''), ...recent.map(r => {
                const dt = new Date(r.timestampMs);
                return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString();
            })];
            mainChart.data.datasets[0].data = [...padNulls, ...recent.map(r => r.temp)];
            mainChart.data.datasets[1].data = [...padNulls, ...recent.map(r => Number((r.ph * 10).toFixed(1)))];
            mainChart.data.datasets[2].data = [...padNulls, ...recent.map(r => Number((r.tds / 10).toFixed(1)))];
            mainChart.update();
        }

        renderTrendsAndLogs();
        renderOperatorAlerts();
        syncDevicePresenceUI();
    });

    // 10. Listen to Firebase Live Latest Event
    window.addEventListener('hydrosense:latest', (e) => {
        const data = e.detail;
        if (!data) return;
        const dedupKey = `${data.timestampMs}_${data.temp}_${data.ph}_${data.tds}_${data.turbidity}`;
        if (dedupKey === lastProcessedTimestamp) return;
        const isFirstLoad = lastProcessedTimestamp === null;
        lastProcessedTimestamp = dedupKey;
        applyReadingToUI(data, !isFirstLoad);
    });

    // 11. Analytical PDF Report Generation (Min / Mean / Max / Latest + Sample Log, No Range Mention)
    function computeMetricStats(records, key, decimals = 2) {
        const nums = records
            .map(r => Number(r[key]))
            .filter(v => Number.isFinite(v));
        if (!nums.length) {
            return { min: '--', avg: '--', max: '--', latest: '--' };
        }
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        const avg = nums.reduce((acc, v) => acc + v, 0) / nums.length;
        const latest = nums[nums.length - 1];
        return {
            min: min.toFixed(decimals),
            avg: avg.toFixed(decimals),
            max: max.toFixed(decimals),
            latest: latest.toFixed(decimals),
            latestNum: latest
        };
    }

    // Helper to load logo image into dataURL for jsPDF header
    function loadLogoDataUrl(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || 120;
                    canvas.height = img.naturalHeight || 120;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/png'));
                } catch (_) {
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    // 11. Sensor-Based Report (Recent Reading Analysis, Logo, Potable/Non-Potable, No Range, Non-Clinical/Non-Chemical Notice)
    window.generateReport = async function () {
        const JsPdfCtor =
            window.jspdf?.jsPDF ||
            window.jsPDF ||
            window.html2pdf?.jsPDF ||
            (typeof html2pdf !== 'undefined' ? html2pdf.jsPDF : null);

        if (!JsPdfCtor) {
            alert('PDF library not loaded yet. Please refresh and try again.');
            return;
        }

        const reviewerName = (document.getElementById('reportSignatoryName')?.value || 'Operator').trim();

        const hasLiveReading = currentData.timestampMs !== null && Number.isFinite(Number(currentData.ph));
        const recent = hasLiveReading
            ? currentData
            : (historyCache.length ? historyCache[historyCache.length - 1] : null);

        if (!recent) {
            alert('No sensor reading available yet to generate the report.');
            return;
        }

        const tempVal = Number(recent.temp ?? 0);
        const phVal = Number(recent.ph ?? 0);
        const tdsVal = Number(recent.tds ?? 0);
        const turbVal = Number(recent.turbidity ?? recent.turb ?? 0);

        // Analyze recent sensor reading to determine POTABLE / NON-POTABLE and reasons
        const phOut = phVal < activeConfig.minPh || phVal > activeConfig.maxPh;
        const tdsHigh = tdsVal > activeConfig.maxTds;
        const turbHigh = turbVal > activeConfig.maxTurb;
        const isPotable = !phOut && !tdsHigh && !turbHigh;
        const verdict = isPotable ? 'POTABLE' : 'NON-POTABLE';

        const findings = [];
        if (turbHigh) {
            findings.push(`Turbidity is measured at ${turbVal.toFixed(2)} NTU, indicating higher suspended particles or cloudiness in the recent water sample.`);
        } else {
            findings.push(`Turbidity is measured at ${turbVal.toFixed(2)} NTU, reflecting lower suspended particle cloudiness in the recent sample.`);
        }

        if (tdsHigh) {
            findings.push(`TDS is measured at ${Math.round(tdsVal)} ppm, indicating a higher concentration of dissolved solids/minerals in the recent sample.`);
        } else {
            findings.push(`TDS is measured at ${Math.round(tdsVal)} ppm, reflecting the dissolved mineral/ionic load present in the recent sample.`);
        }

        if (phOut) {
            findings.push(
                phVal < activeConfig.minPh
                    ? `pH is measured at ${phVal.toFixed(2)}, leaning toward the acidic side compared to neutral pH 7.0.`
                    : `pH is measured at ${phVal.toFixed(2)}, leaning toward the alkaline side compared to neutral pH 7.0.`
            );
        } else {
            findings.push(`pH is measured at ${phVal.toFixed(2)}, close to the neutral pH 7.0 reference.`);
        }

        findings.push(`Water temperature at the time of reading is ${tempVal.toFixed(1)} °C.`);

        const logoDataUrl = await loadLogoDataUrl('./assets/college_logo.png');

        const doc = new JsPdfCtor({ unit: 'pt', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const marginX = 46;
        const contentW = pageW - marginX * 2;
        let y = 34;

        const now = new Date();
        const docId = `HS-${String(now.getTime()).slice(-6)}`;

        // Header Banner with Logo
        doc.setFillColor(15, 23, 42);
        doc.rect(0, 0, pageW, 84, 'F');

        let textStartX = marginX;
        if (logoDataUrl) {
            try {
                doc.setFillColor(255, 255, 255);
                doc.roundedRect(marginX, 16, 52, 52, 6, 6, 'F');
                doc.addImage(logoDataUrl, 'PNG', marginX + 4, 20, 44, 44);
                textStartX = marginX + 64;
            } catch (_) {
                textStartX = marginX;
            }
        }

        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.text('HYDROSENSE 2.0', textStartX, 38);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(186, 230, 253);
        doc.text('Sensor Telemetry Analysis', textStartX, 56);

        doc.setFontSize(8.5);
        doc.setTextColor(226, 232, 240);
        doc.text(`Report ID: ${docId}`, pageW - marginX, 34, { align: 'right' });
        doc.text(`Generated: ${now.toLocaleString()}`, pageW - marginX, 49, { align: 'right' });
        doc.text(`Name: ${reviewerName}`, pageW - marginX, 64, { align: 'right' });

        y = 108;

        // Verdict Banner
        doc.setFillColor(isPotable ? 240 : 254, isPotable ? 253 : 242, isPotable ? 244 : 242);
        doc.setDrawColor(isPotable ? 34 : 239, isPotable ? 197 : 68, isPotable ? 94 : 68);
        doc.roundedRect(marginX, y, contentW, 56, 6, 6, 'FD');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(71, 85, 105);
        doc.text('RECENT READING ASSESSMENT', marginX + 14, y + 19);

        doc.setFontSize(15);
        doc.setTextColor(isPotable ? 21 : 185, isPotable ? 128 : 28, isPotable ? 61 : 28);
        doc.text(verdict, marginX + 14, y + 41);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(51, 65, 85);
        const readingTime = recent.timestampMs ? new Date(recent.timestampMs).toLocaleString() : now.toLocaleString();
        doc.text(`Reading Time: ${readingTime}`, pageW - marginX - 14, y + 32, { align: 'right' });

        y += 78;

        // Recent Sensor Readings Table (No Ranges)
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(15, 23, 42);
        doc.text('1. Recent Sensor Readings', marginX, y);
        y += 10;

        const cols = [
            { label: 'Sensor Parameter', w: contentW * 0.55, align: 'left' },
            { label: 'Recent Reading', w: contentW * 0.45, align: 'right' }
        ];

        doc.setFillColor(30, 41, 59);
        doc.rect(marginX, y, contentW, 24, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text(cols[0].label, marginX + 10, y + 15);
        doc.text(cols[1].label, pageW - marginX - 10, y + 15, { align: 'right' });
        y += 24;

        const rows = [
            ['Temperature', `${tempVal.toFixed(1)} °C`],
            ['pH', `${phVal.toFixed(2)}`],
            ['TDS', `${Math.round(tdsVal)} ppm`],
            ['Turbidity', `${turbVal.toFixed(2)} NTU`]
        ];

        rows.forEach((r, idx) => {
            doc.setFillColor(idx % 2 === 0 ? 255 : 248, idx % 2 === 0 ? 255 : 250, idx % 2 === 0 ? 255 : 252);
            doc.rect(marginX, y, contentW, 24, 'F');
            doc.setDrawColor(226, 232, 240);
            doc.rect(marginX, y, contentW, 24, 'S');

            doc.setTextColor(15, 23, 42);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9.5);
            doc.text(r[0], marginX + 10, y + 15);

            doc.setFont('helvetica', 'bold');
            doc.text(r[1], pageW - marginX - 10, y + 15, { align: 'right' });
            y += 24;
        });

        y += 22;

        // Analysis & Observations
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(15, 23, 42);
        doc.text('2. Reading Analysis & Observations', marginX, y);
        y += 14;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(30, 41, 59);

        findings.forEach((line) => {
            const wrapped = doc.splitTextToSize(`• ${line}`, contentW - 8);
            doc.text(wrapped, marginX + 4, y);
            y += wrapped.length * 13.5 + 5;
        });

        y += 10;

        // Non-Clinical / Non-Chemical Verification Notice
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(148, 163, 184);
        doc.roundedRect(marginX, y, contentW, 56, 5, 5, 'FD');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        doc.text('Verification & Scope Notice', marginX + 12, y + 16);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(51, 65, 85);
        const noticeText = 'This report, including all calculations and the potability verdict, is derived solely from recent electronic sensor readings and is not clinically or chemically verified through laboratory testing.';
        const wrappedNotice = doc.splitTextToSize(noticeText, contentW - 24);
        doc.text(wrappedNotice, marginX + 12, y + 31);

        // Footer: Digital Document Notice
        const footerY = doc.internal.pageSize.getHeight() - 56;
        doc.setDrawColor(203, 213, 225);
        doc.line(marginX, footerY - 10, pageW - marginX, footerY - 10);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        doc.text('This is a digitally generated report; no physical signature is required.', marginX, footerY + 4);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(71, 85, 105);
        doc.text(`Name: ${reviewerName}`, pageW - marginX, footerY + 4, { align: 'right' });

        doc.save(`HydroSense_Report_${docId}.pdf`);
    };
});