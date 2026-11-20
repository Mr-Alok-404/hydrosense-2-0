document.addEventListener('DOMContentLoaded', () => {
    const MAX_STALE_MS = 30000;

    let activeConfig = {
        minPh: 6.5,
        maxPh: 8.5,
        maxTds: 500,
        maxTurb: 5.0,
        telegramEnabled: true
    };
    let currentData = {
        device_id: 'HYDRO_ESP32_01',
        temp: null,
        ph: null,
        tds: null,
        turb: null,
        status: 'WAITING',
        timestampMs: null,
        timestamp: null,
        data_source: '--',
        ip_address: null,
        wifi_ssid: null,
        wifi_rssi: null
    };
    let detectedDevices = ['HYDRO_ESP32_01'];
    let historyCache = [];
    let csvSelectedRows = [];
    let lastProcessedTimestamp = null;
    let currentCsvPreset = '7D';
    let customStartDate = null;
    let customEndDate = null;
    let showSsidUnmasked = false;

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

    // 2. View Switching Logic
    const navItems = document.querySelectorAll('.nav-item');
    const viewSections = document.querySelectorAll('.view-section');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            const tabName = item.innerText.trim();
            const isOnlineNow = isDeviceOnline();
            const badgeClass = isOnlineNow ? 'badge' : 'badge offline-badge';
            const badgeText = isOnlineNow ? 'Live' : 'Offline';
            const titleHtml = tabName.includes('Dashboard')
                ? `${tabName} <span class="${badgeClass}" id="liveBadge">${badgeText}</span>`
                : tabName;
            document.getElementById('pageTitle').innerHTML = titleHtml;

            const targetId = item.getAttribute('data-target');
            viewSections.forEach(view => {
                view.classList.toggle('active-view', view.id === targetId);
                view.classList.toggle('hidden-view', view.id !== targetId);
            });

            if (targetId === 'trends-view') renderTrendsAndLogs();
            if (targetId === 'alerts-view') renderAlertsTable();
            if (targetId === 'devices-view') syncDevicePresenceUI();
            if (targetId === 'workflow-view') renderLiveWorkflow();

            [mainChart, historyChart].forEach(c => { if (c) c.resize(); });
            if (window.innerWidth <= 768 && sidebar) sidebar.classList.remove('open');
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

    // 5. Device Presence & Metadata UI
    function isDeviceOnline() {
        if (!currentData.timestampMs) return false;
        return (Date.now() - currentData.timestampMs) <= MAX_STALE_MS;
    }

    function formatMaskedSsid(ssid) {
        if (!ssid) return 'Not reported in payload';
        if (showSsidUnmasked) return ssid;
        if (ssid.length <= 2) return `${ssid[0]}*`;
        return `${ssid.slice(0, 2)}${'*'.repeat(Math.min(8, ssid.length - 2))}`;
    }

    function syncDevicePresenceUI() {
        const online = isDeviceOnline();
        const liveBadge = document.getElementById('liveBadge');
        if (liveBadge) {
            liveBadge.className = online ? 'badge' : 'badge offline-badge';
            liveBadge.innerText = online ? 'Live' : 'Offline';
        }

        const devBadge = document.getElementById('deviceStatusBadge');
        const lastSeenEl = document.getElementById('deviceLastSeen');
        const connNoteEl = document.getElementById('deviceConnectionNote');
        const srcEl = document.getElementById('deviceDataSource');
        const ipEl = document.getElementById('deviceIpAddress');
        const ssidEl = document.getElementById('deviceWifiSsid');
        const rssiEl = document.getElementById('deviceWifiRssi');
        const latestStatusEl = document.getElementById('deviceLatestStatus');
        const detectedListEl = document.getElementById('detectedDevicesList');

        if (devBadge) {
            devBadge.className = online ? 'status-badge bg-normal ml-auto' : 'status-badge bg-danger ml-auto';
            devBadge.innerText = online ? 'Online' : 'Offline';
        }
        if (lastSeenEl) {
            lastSeenEl.innerText = currentData.timestamp
                ? new Date(currentData.timestamp).toLocaleString()
                : 'Never';
        }
        if (connNoteEl) {
            if (!currentData.timestampMs) {
                connNoteEl.innerText = 'No telemetry received yet';
            } else if (online) {
                connNoteEl.innerText = 'Active stream within 30s';
            } else {
                const secAgo = Math.round((Date.now() - currentData.timestampMs) / 1000);
                connNoteEl.innerText = `Offline (last seen ${secAgo}s ago)`;
            }
        }
        if (srcEl) srcEl.innerText = currentData.data_source || '--';
        if (ipEl) ipEl.innerText = currentData.ip_address || 'Not reported in payload';
        if (ssidEl) ssidEl.innerText = formatMaskedSsid(currentData.wifi_ssid);
        if (rssiEl) rssiEl.innerText = currentData.wifi_rssi !== null ? `${currentData.wifi_rssi} dBm` : 'Not reported in payload';
        if (latestStatusEl) latestStatusEl.innerText = currentData.status || '--';
        if (detectedListEl) detectedListEl.innerText = detectedDevices.join(', ');

        renderLiveWorkflow();
    }

    document.getElementById('toggleSsidBtn')?.addEventListener('click', () => {
        showSsidUnmasked = !showSsidUnmasked;
        syncDevicePresenceUI();
    });

    window.addEventListener('hydrosense:devices', (e) => {
        if (Array.isArray(e.detail) && e.detail.length) {
            detectedDevices = e.detail;
            syncDevicePresenceUI();
        }
    });

    setInterval(syncDevicePresenceUI, 5000);

    // 6. Chart Setups
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

    // Historical Graph (Displays Stored Readings Directly) + CSV Export Range Selector
    const ctxHist = document.getElementById('historyChart').getContext('2d');
    const historyChart = new Chart(ctxHist, {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Sensor Value', data: [], backgroundColor: '#a855f7', borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

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

    function renderHistoryLogsTable(rows) {
        const tbody = document.getElementById('historyLogsTableBody');
        const countEl = document.getElementById('filteredLogCount');
        if (countEl) countEl.innerText = String(historyCache.length);
        if (!tbody) return;

        if (!historyCache.length) {
            tbody.innerHTML = '<tr><td colspan="8">No Firebase records available.</td></tr>';
            return;
        }

        const newestFirst = [...historyCache].reverse().slice(0, 150);
        tbody.innerHTML = newestFirst.map(item => {
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

        const csvCountEl = document.getElementById('csvExportCount');
        if (csvCountEl) csvCountEl.innerText = String(rows.length);
    }

    function renderTrendsAndLogs() {
        csvSelectedRows = getCsvExportRows();
        const metric = document.getElementById('trendMetricSelect')?.value || 'ph';
        const colorMap = {
            ph: '#a855f7',
            tds: '#f59e0b',
            turbidity: '#10b981',
            temp: '#0ea5e9'
        };

        const chartSubset = historyCache.slice(-60);
        historyChart.data.labels = chartSubset.map(item => {
            const d = new Date(item.timestampMs);
            return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        });
        historyChart.data.datasets[0].label = metric.toUpperCase();
        historyChart.data.datasets[0].data = chartSubset.map(item => item[metric]);
        historyChart.data.datasets[0].backgroundColor = colorMap[metric] || '#0ea5e9';
        historyChart.update();

        renderHistoryLogsTable(csvSelectedRows);
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
        const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `HydroSense_Logs_${Date.now()}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });

    // Alerts Table
    function renderAlertsTable() {
        const tbody = document.getElementById('alertsTableBody');
        const botLabel = document.getElementById('alertsBotStatusLabel');
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
                    limit: `${activeConfig.minPh} - ${activeConfig.maxPh} pH`,
                    badge: 'bg-danger'
                });
            }
            if (item.tds > activeConfig.maxTds) {
                violations.push({
                    trigger: 'High TDS',
                    actual: `${item.tds} ppm`,
                    limit: `<= ${activeConfig.maxTds} ppm`,
                    badge: 'bg-warning'
                });
            }
            if (item.turbidity > activeConfig.maxTurb) {
                violations.push({
                    trigger: 'High Turbidity',
                    actual: `${item.turbidity} NTU`,
                    limit: `<= ${activeConfig.maxTurb} NTU`,
                    badge: 'bg-warning'
                });
            }
            if (!violations.length && item.status !== 'POTABLE') {
                violations.push({
                    trigger: 'Non-Potable Reading',
                    actual: `pH ${item.ph}, TDS ${item.tds}, Turb ${item.turbidity}`,
                    limit: `pH ${activeConfig.minPh}-${activeConfig.maxPh}, TDS <=${activeConfig.maxTds}, Turb <=${activeConfig.maxTurb}`,
                    badge: 'bg-danger'
                });
            }

            violations.forEach(v => {
                alerts.push({ timestampMs: item.timestampMs, ...v });
            });
        });

        alerts.sort((a, b) => b.timestampMs - a.timestampMs);

        if (!alerts.length) {
            tbody.innerHTML = '<tr><td colspan="4">No threshold violations recorded under current limits.</td></tr>';
            return;
        }

        tbody.innerHTML = alerts.slice(0, 100).map(al => `
            <tr>
                <td>${new Date(al.timestampMs).toLocaleString()}</td>
                <td><span class="status-badge ${al.badge}">${al.trigger}</span></td>
                <td>Actual: ${al.actual} | Limit: ${al.limit}</td>
                <td><i class="fas fa-database icon-cyan"></i> Logged in Firebase</td>
            </tr>
        `).join('');
    }

    // Live System Workflow Renderer
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
        const c2 = document.getElementById('conn-2');
        c2?.classList.remove('connector-broken');

        const online = isDeviceOnline();
        const hasReading = currentData.timestampMs !== null;
        const isPotable = currentData.status === 'POTABLE';

        setNodeState('node-sensors', 'flowBadgeSensors', hasReading ? 'ok' : 'warn', hasReading ? 'Reporting' : 'Awaiting');
        setNodeState('node-esp32', 'flowBadgeEsp', online ? 'ok' : 'fault', online ? 'Online' : 'Offline');
        setNodeState('node-rules', 'flowBadgeRules', hasReading ? (isPotable ? 'ok' : 'fault') : 'warn', hasReading ? (isPotable ? 'Within Limits' : 'Exceeds Limit') : 'Standby');
        setNodeState('node-firebase', 'flowBadgeFirebase', 'ok', 'Synced');
        setNodeState('node-ui-alert', 'flowBadgeAlert', hasReading ? (isPotable ? 'ok' : 'warn') : 'ok', activeConfig.telegramEnabled ? 'UI + Bot Ready' : 'UI Only');

        if (!online && c2) c2.classList.add('connector-broken');

        if (diagMsg) {
            if (!hasReading) {
                diagMsg.innerText = 'Firebase RTDB is connected; waiting for sensor telemetry.';
            } else if (online) {
                diagMsg.innerText = `ESP32 is online (last reading ${new Date(currentData.timestampMs).toLocaleTimeString()}); status is ${currentData.status}.`;
            } else {
                const secAgo = Math.round((Date.now() - currentData.timestampMs) / 1000);
                diagMsg.innerText = `ESP32 is currently Offline (last reading was ${secAgo}s ago). Latest stored status is ${currentData.status}.`;
            }
        }
    }

    function updateKpiStatus(elementId, isSafe, trigger = null) {
        const el = document.getElementById(elementId);
        if (!el) return;
        const statusEl = el.querySelector('.kpi-status');
        if (isSafe) {
            statusEl.className = 'kpi-status status-normal';
            statusEl.innerText = 'Within Safe Limit';
        } else {
            statusEl.className = 'kpi-status status-critical';
            statusEl.innerText = trigger ? `Alert: ${trigger}` : 'Out of Limit';
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
        currentData = {
            device_id: data.device_id || 'HYDRO_ESP32_01',
            temp: data.temp,
            ph: data.ph,
            tds: data.tds,
            turb: data.turbidity,
            status: data.status,
            timestampMs: data.timestampMs,
            timestamp: data.timestamp,
            data_source: data.data_source,
            ip_address: data.ip_address || currentData.ip_address,
            wifi_ssid: data.wifi_ssid || currentData.wifi_ssid,
            wifi_rssi: data.wifi_rssi !== null && data.wifi_rssi !== undefined ? data.wifi_rssi : currentData.wifi_rssi
        };

        document.getElementById('val-temp').innerText = data.temp;
        document.getElementById('val-ph').innerText = data.ph;
        document.getElementById('val-tds').innerText = data.tds;
        document.getElementById('val-turb').innerText = data.turbidity;

        const phOk = data.ph >= activeConfig.minPh && data.ph <= activeConfig.maxPh;
        const tdsOk = data.tds <= activeConfig.maxTds;
        const turbOk = data.turbidity <= activeConfig.maxTurb;
        const overallPotable = data.status === 'POTABLE' && phOk && tdsOk && turbOk;

        const wqiLabel = document.getElementById('wqiLabelTxt');
        const wqiSub = document.getElementById('wqiReasonTxt');
        wqiLabel.innerText = overallPotable ? 'POTABLE' : 'NON-POTABLE';

        if (overallPotable) {
            wqiLabel.style.color = 'var(--accent-success)';
            if (wqiSub) wqiSub.innerText = 'All parameters within limits';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#22c55e', '#1e293b'];
            wqiDoughnut.data.datasets[0].data = [100, 0];
            ['card-temp', 'card-ph', 'card-tds', 'card-turb'].forEach(id => updateKpiStatus(id, true));
        } else {
            wqiLabel.style.color = 'var(--accent-danger)';
            if (wqiSub) wqiSub.innerText = 'One or more limits exceeded';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#ef4444', '#1e293b'];
            wqiDoughnut.data.datasets[0].data = [100, 0];

            updateKpiStatus('card-temp', true);
            updateKpiStatus('card-ph', phOk, `pH ${activeConfig.minPh}-${activeConfig.maxPh}`);
            updateKpiStatus('card-tds', tdsOk, `TDS <=${activeConfig.maxTds}`);
            updateKpiStatus('card-turb', turbOk, `Turb <=${activeConfig.maxTurb}`);
        }
        wqiDoughnut.update();
        syncDevicePresenceUI();

        const d = new Date(data.timestampMs);
        const timeStr = Number.isNaN(d.getTime()) ? new Date().toLocaleTimeString() : d.toLocaleTimeString();

        const term = document.getElementById('terminalBox');
        if (term) {
            const p = document.createElement('p');
            p.className = overallPotable ? 'term-line data' : 'term-line alert';
            p.innerText = `> [${timeStr}] FIREBASE_SYNC [${data.device_id}]: {"temp":${data.temp}, "ph":${data.ph}, "tds":${data.tds}, "turb":${data.turbidity}} -> ${overallPotable ? 'POTABLE' : 'NON-POTABLE'}`;
            term.appendChild(p);
            if (term.childElementCount > 120) term.removeChild(term.firstChild);
            term.scrollTop = term.scrollHeight;
        }

        if (appendToCharts) {
            pushMiniPoint(miniTemp, data.temp);
            pushMiniPoint(miniPh, data.ph);
            pushMiniPoint(miniTds, data.tds);
            pushMiniPoint(miniTurb, data.turbidity);
            pushMainPoint(data, timeStr);
        }
    }

    // 7. Dynamic Config Listener & Form Submit
    const settingsForm = document.getElementById('settingsForm');
    const settingsStatus = document.getElementById('settingsSaveStatus');

    function populateSettingsForm(cfg) {
        const tgEl = document.getElementById('telegramEnabledSelect');
        const minPhEl = document.getElementById('minPhInput');
        const maxPhEl = document.getElementById('maxPhInput');
        const maxTdsEl = document.getElementById('maxTdsInput');
        const maxTurbEl = document.getElementById('maxTurbInput');

        if (tgEl) tgEl.value = String(Boolean(cfg.telegramEnabled));
        if (minPhEl) minPhEl.value = cfg.minPh;
        if (maxPhEl) maxPhEl.value = cfg.maxPh;
        if (maxTdsEl) maxTdsEl.value = cfg.maxTds;
        if (maxTurbEl) maxTurbEl.value = cfg.maxTurb;
    }
    populateSettingsForm(activeConfig);

    window.addEventListener('hydrosense:config', (e) => {
        if (!e.detail) return;
        activeConfig = { ...activeConfig, ...e.detail };
        populateSettingsForm(activeConfig);
        renderAlertsTable();
        if (currentData.timestampMs) {
            applyReadingToUI(currentData, false);
        }
    });

    if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const minPh = Number(document.getElementById('minPhInput').value);
            const maxPh = Number(document.getElementById('maxPhInput').value);
            const maxTds = Number(document.getElementById('maxTdsInput').value);
            const maxTurb = Number(document.getElementById('maxTurbInput').value);
            const telegramEnabled = document.getElementById('telegramEnabledSelect').value === 'true';

            if (Number.isNaN(minPh) || Number.isNaN(maxPh) || minPh < 0 || maxPh > 14 || minPh >= maxPh) {
                if (settingsStatus) {
                    settingsStatus.style.color = 'var(--accent-danger)';
                    settingsStatus.innerText = 'Invalid pH range: ensure 0 <= Min pH < Max pH <= 14.';
                }
                return;
            }
            if (Number.isNaN(maxTds) || maxTds <= 0 || Number.isNaN(maxTurb) || maxTurb <= 0) {
                if (settingsStatus) {
                    settingsStatus.style.color = 'var(--accent-danger)';
                    settingsStatus.innerText = 'TDS and Turbidity limits must be positive numbers.';
                }
                return;
            }

            if (typeof window.saveHydroSenseConfig !== 'function') {
                if (settingsStatus) {
                    settingsStatus.style.color = 'var(--accent-warning)';
                    settingsStatus.innerText = 'Firebase config writer not ready yet.';
                }
                return;
            }

            try {
                if (settingsStatus) {
                    settingsStatus.style.color = 'var(--text-muted)';
                    settingsStatus.innerText = 'Saving to Firebase...';
                }
                await window.saveHydroSenseConfig({ minPh, maxPh, maxTds, maxTurb, telegramEnabled });
                activeConfig = { minPh, maxPh, maxTds, maxTurb, telegramEnabled };
                renderAlertsTable();
                if (currentData.timestampMs) {
                    applyReadingToUI(currentData, false);
                }
                if (settingsStatus) {
                    settingsStatus.style.color = 'var(--accent-success)';
                    settingsStatus.innerText = 'Saved & synced to Firebase!';
                }
            } catch (err) {
                if (settingsStatus) {
                    settingsStatus.style.color = 'var(--accent-danger)';
                    settingsStatus.innerText = `Save failed: ${err.message}`;
                }
            }
        });
    }

    // 8. Listen to Firebase History Event
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
        renderAlertsTable();
        syncDevicePresenceUI();
    });

    // 9. Listen to Firebase Live Latest Event
    window.addEventListener('hydrosense:latest', (e) => {
        const data = e.detail;
        if (!data) return;
        const dedupKey = `${data.timestampMs}_${data.temp}_${data.ph}_${data.tds}_${data.turbidity}`;
        if (dedupKey === lastProcessedTimestamp) return;
        const isFirstLoad = lastProcessedTimestamp === null;
        lastProcessedTimestamp = dedupKey;
        applyReadingToUI(data, !isFirstLoad);
    });

    // 10. Report Generation (PDF Export — Without Confidence Score)
    window.generateReport = function () {
        const period = document.getElementById('reportPeriod').value;
        const signatoryName = document.getElementById('reportSignatoryName').value;
        const signatoryDesig = document.getElementById('reportSignatoryDesig').value;

        const now = new Date();
        document.getElementById('pdfDate').innerText = 'Generated: ' + now.toLocaleString();

        let periodText = 'Last 24 Hours';
        if (period === '1W') periodText = 'Last 7 Days';
        if (period === '1M') periodText = 'Last 30 Days';
        document.getElementById('pdfPeriod').innerText = periodText;

        document.getElementById('pdfSign').innerText = signatoryName;
        document.getElementById('pdfNameOut').innerText = signatoryName;
        document.getElementById('pdfDesigOut').innerText = signatoryDesig;

        const phVal = currentData.ph ?? '--';
        const tdsVal = currentData.tds ?? '--';
        const turbVal = currentData.turb ?? '--';
        const tempVal = currentData.temp ?? '--';

        const isSafePh = typeof currentData.ph === 'number' && currentData.ph >= activeConfig.minPh && currentData.ph <= activeConfig.maxPh;
        const isSafeTds = typeof currentData.tds === 'number' && currentData.tds <= activeConfig.maxTds;
        const isSafeTurb = typeof currentData.turb === 'number' && currentData.turb <= activeConfig.maxTurb;

        document.getElementById('pdfTableBody').innerHTML = `
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">Temperature</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${tempVal} °C</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">15.0 - 35.0 °C</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:green; font-weight:bold;">Recorded</td>
            </tr>
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">pH Level</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${phVal} pH</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">${activeConfig.minPh} - ${activeConfig.maxPh}</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:${isSafePh ? 'green' : 'red'}; font-weight:bold;">${isSafePh ? 'Safe' : 'Alert'}</td>
            </tr>
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">TDS (Total Dissolved Solids)</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${tdsVal} ppm</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">&le; ${activeConfig.maxTds} ppm</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:${isSafeTds ? 'green' : 'orange'}; font-weight:bold;">${isSafeTds ? 'Safe' : 'Alert'}</td>
            </tr>
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">Turbidity</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${turbVal} NTU</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">&le; ${activeConfig.maxTurb} NTU</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:${isSafeTurb ? 'green' : 'orange'}; font-weight:bold;">${isSafeTurb ? 'Safe' : 'Alert'}</td>
            </tr>
        `;

        const vEl = document.getElementById('pdfVerdict');
        vEl.innerText = currentData.status || 'WAITING';
        vEl.style.color = currentData.status === 'POTABLE' ? 'green' : 'red';

        const element = document.getElementById('reportTemplate');
        const opt = {
            margin: 0,
            filename: `HydroSense_Report_${now.getTime()}.pdf`,
            image: { type: 'jpeg', quality: 1.0 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'px', format: [794, 1123], orientation: 'portrait' }
        };
        html2pdf().set(opt).from(element).save();
    };
});