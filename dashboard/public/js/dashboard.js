document.addEventListener('DOMContentLoaded', () => {
    const MAX_STALE_MS = 30000; // Device marked offline if no reading within 30 seconds

    // Global State
    let activeConfig = {
        minPh: 6.5,
        maxPh: 8.5,
        maxTds: 500,
        maxTurb: 5.0,
        telegramEnabled: true
    };
    let currentData = {
        temp: null,
        ph: null,
        tds: null,
        turb: null,
        status: 'WAITING',
        conf: null,
        timestampMs: null,
        timestamp: null,
        data_source: '--'
    };
    let historyCache = [];
    let lastProcessedTimestamp = null;

    // Footer Year
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

            if (targetId === 'trends-view') renderTrendsChart();
            if (targetId === 'alerts-view') renderAlertsTable();
            if (targetId === 'devices-view') syncDevicePresenceUI();

            [mainChart, historyChart].forEach(c => { if (c) c.resize(); });
            if (window.innerWidth <= 768 && sidebar) sidebar.classList.remove('open');
        });
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
            Chart.defaults.borderColor = '#e2e8f0';
        }
    }
    applyTheme(localStorage.getItem('hs_theme') || 'dark');

    toggle.addEventListener('click', () => {
        const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        localStorage.setItem('hs_theme', next);
        applyTheme(next);
        [mainChart, wqiDoughnut, miniTemp, miniPh, miniTds, miniTurb, historyChart].forEach(c => { if (c) c.update(); });
    });

    // 5. Device Online / Offline Presence Based on Timestamp Freshness
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

        const devBadge = document.getElementById('deviceStatusBadge');
        const lastSeenEl = document.getElementById('deviceLastSeen');
        const connNoteEl = document.getElementById('deviceConnectionNote');
        const srcEl = document.getElementById('deviceDataSource');

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
                connNoteEl.innerText = 'Active heartbeat within 30s';
            } else {
                const secAgo = Math.round((Date.now() - currentData.timestampMs) / 1000);
                connNoteEl.innerText = `Disconnected (last seen ${secAgo}s ago)`;
            }
        }
        if (srcEl) {
            srcEl.innerText = currentData.data_source || '--';
        }
    }

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
            labels: ['Safe', 'Unsafe'],
            datasets: [{ data: [0, 100], backgroundColor: ['#22c55e', '#334155'], borderWidth: 0, cutout: '80%', circumference: 360, rotation: 270 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });

    // Trends Chart (Powered by Firebase historyCache)
    let currentTrendPeriod = '1W';
    const ctxHist = document.getElementById('historyChart').getContext('2d');
    const historyChart = new Chart(ctxHist, {
        type: 'bar',
        data: { labels: [], datasets: [{ label: 'Sensor Value', data: [], backgroundColor: '#a855f7', borderRadius: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

    function renderTrendsChart() {
        if (!historyCache.length) return;
        const metric = document.getElementById('trendMetricSelect').value;
        const sliceCount = currentTrendPeriod === '1D' ? 12 : currentTrendPeriod === '1W' ? 25 : 50;
        const subset = historyCache.slice(-sliceCount);

        const colorMap = {
            ph: '#a855f7',
            tds: '#f59e0b',
            turbidity: '#10b981',
            temp: '#0ea5e9'
        };

        historyChart.data.labels = subset.map(item => {
            const d = new Date(item.timestamp);
            return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        });
        historyChart.data.datasets[0].label = metric.toUpperCase();
        historyChart.data.datasets[0].data = subset.map(item => item[metric]);
        historyChart.data.datasets[0].backgroundColor = colorMap[metric] || '#0ea5e9';
        historyChart.update();
    }

    document.querySelectorAll('.btn-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTrendPeriod = btn.getAttribute('data-period');
            renderTrendsChart();
        });
    });

    document.getElementById('trendMetricSelect').addEventListener('change', renderTrendsChart);

    // Alerts Table (Generated dynamically using activeConfig thresholds)
    function renderAlertsTable() {
        const tbody = document.getElementById('alertsTableBody');
        const botLabel = document.getElementById('alertsBotStatusLabel');
        if (botLabel) {
            botLabel.innerText = activeConfig.telegramEnabled ? 'Enabled' : 'Disabled';
            botLabel.style.color = activeConfig.telegramEnabled ? 'var(--accent-success)' : 'var(--accent-warning)';
        }
        if (!tbody) return;

        const unsafeItems = historyCache.filter(item => {
            const phBad = item.ph < activeConfig.minPh || item.ph > activeConfig.maxPh;
            const tdsBad = item.tds > activeConfig.maxTds;
            const turbBad = item.turbidity > activeConfig.maxTurb;
            return item.status !== 'POTABLE' || phBad || tdsBad || turbBad;
        }).reverse();

        if (unsafeItems.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4">No threshold violations recorded under current BIS rules.</td></tr>';
            return;
        }

        tbody.innerHTML = unsafeItems.map(item => {
            let trigger = 'Classification Alert';
            let actual = `pH ${item.ph}, TDS ${item.tds}, Turb ${item.turbidity}`;
            let limitStr = `pH ${activeConfig.minPh}-${activeConfig.maxPh}, TDS <=${activeConfig.maxTds}, Turb <=${activeConfig.maxTurb}`;
            let badgeClass = 'bg-warning';

            if (item.ph < activeConfig.minPh || item.ph > activeConfig.maxPh) {
                trigger = 'pH Out of Range';
                actual = `${item.ph} pH`;
                limitStr = `${activeConfig.minPh} - ${activeConfig.maxPh} pH`;
                badgeClass = 'bg-danger';
            } else if (item.tds > activeConfig.maxTds) {
                trigger = 'High TDS';
                actual = `${item.tds} ppm`;
                limitStr = `<= ${activeConfig.maxTds} ppm`;
            } else if (item.turbidity > activeConfig.maxTurb) {
                trigger = 'High Turbidity';
                actual = `${item.turbidity} NTU`;
                limitStr = `<= ${activeConfig.maxTurb} NTU`;
            }

            const timeLabel = new Date(item.timestamp).toLocaleString();
            return `<tr>
                <td>${timeLabel}</td>
                <td><span class="status-badge ${badgeClass}">${trigger}</span></td>
                <td>Actual: ${actual} | Limit: ${limitStr}</td>
                <td><i class="fas fa-database icon-cyan"></i> Logged in Firebase</td>
            </tr>`;
        }).join('');
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
            temp: data.temp,
            ph: data.ph,
            tds: data.tds,
            turb: data.turbidity,
            status: data.status,
            conf: data.confidence,
            timestampMs: data.timestampMs,
            timestamp: data.timestamp,
            data_source: data.data_source
        };

        document.getElementById('val-temp').innerText = data.temp;
        document.getElementById('val-ph').innerText = data.ph;
        document.getElementById('val-tds').innerText = data.tds;
        document.getElementById('val-turb').innerText = data.turbidity;

        document.getElementById('wqiScoreVal').innerText = `${data.confidence}%`;
        const wqiLabel = document.getElementById('wqiLabelTxt');
        wqiLabel.innerText = data.status;

        const phOk = data.ph >= activeConfig.minPh && data.ph <= activeConfig.maxPh;
        const tdsOk = data.tds <= activeConfig.maxTds;
        const turbOk = data.turbidity <= activeConfig.maxTurb;

        if (data.status === 'POTABLE' && phOk && tdsOk && turbOk) {
            wqiLabel.style.color = 'var(--accent-success)';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#22c55e', '#334155'];
            wqiDoughnut.data.datasets[0].data = [data.confidence, Math.max(0, 100 - data.confidence)];
            ['card-temp', 'card-ph', 'card-tds', 'card-turb'].forEach(id => updateKpiStatus(id, true));
        } else {
            wqiLabel.style.color = 'var(--accent-danger)';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#ef4444', '#334155'];
            wqiDoughnut.data.datasets[0].data = [data.confidence, Math.max(0, 100 - data.confidence)];

            updateKpiStatus('card-temp', true);
            updateKpiStatus('card-ph', phOk, `pH ${activeConfig.minPh}-${activeConfig.maxPh}`);
            updateKpiStatus('card-tds', tdsOk, `TDS <=${activeConfig.maxTds}`);
            updateKpiStatus('card-turb', turbOk, `Turb <=${activeConfig.maxTurb}`);
        }
        wqiDoughnut.update();
        syncDevicePresenceUI();

        const d = new Date(data.timestamp);
        const timeStr = isNaN(d) ? new Date().toLocaleTimeString() : d.toLocaleTimeString();

        const term = document.getElementById('terminalBox');
        if (term) {
            const p = document.createElement('p');
            p.className = data.status === 'POTABLE' ? 'term-line data' : 'term-line alert';
            p.innerText = `> [${timeStr}] FIREBASE_SYNC [${data.device_id}]: {"temp":${data.temp}, "ph":${data.ph}, "tds":${data.tds}, "turb":${data.turbidity}} -> ${data.status}`;
            term.appendChild(p);
            if (term.childElementCount > 60) term.removeChild(term.firstChild);
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
        if (currentData.timestamp) {
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
                if (currentData.timestamp) {
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
        if (!list.length) return;
        historyCache = list;

        const recent = list.slice(-20);
        const padCount = 20 - recent.length;
        const padNulls = Array(padCount).fill(null);

        miniTemp.data.datasets[0].data = [...padNulls, ...recent.map(r => r.temp)];
        miniPh.data.datasets[0].data = [...padNulls, ...recent.map(r => r.ph)];
        miniTds.data.datasets[0].data = [...padNulls, ...recent.map(r => r.tds)];
        miniTurb.data.datasets[0].data = [...padNulls, ...recent.map(r => r.turbidity)];
        [miniTemp, miniPh, miniTds, miniTurb].forEach(c => c.update('none'));

        mainChart.data.labels = [...Array(padCount).fill(''), ...recent.map(r => {
            const dt = new Date(r.timestamp);
            return isNaN(dt) ? '' : dt.toLocaleTimeString();
        })];
        mainChart.data.datasets[0].data = [...padNulls, ...recent.map(r => r.temp)];
        mainChart.data.datasets[1].data = [...padNulls, ...recent.map(r => Number((r.ph * 10).toFixed(1)))];
        mainChart.data.datasets[2].data = [...padNulls, ...recent.map(r => Number((r.tds / 10).toFixed(1)))];
        mainChart.update();

        renderTrendsChart();
        renderAlertsTable();
    });

    // 9. Listen to Firebase Live Latest Event
    window.addEventListener('hydrosense:latest', (e) => {
        const data = e.detail;
        if (!data || data.timestamp === lastProcessedTimestamp) return;
        const isFirstLoad = lastProcessedTimestamp === null;
        lastProcessedTimestamp = data.timestamp;
        applyReadingToUI(data, !isFirstLoad);
    });

    // 10. Report Generation (PDF Export)
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
        document.getElementById('pdfConf').innerText = currentData.conf !== null ? `${currentData.conf}%` : '--';

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