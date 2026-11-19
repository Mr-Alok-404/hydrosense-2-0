document.addEventListener('DOMContentLoaded', () => {

    // Global State
    let currentData = { temp: 0, ph: 7.0, tds: 300, turb: 1.0, status: 'POTABLE', conf: 96 };
    let historyCache = [];
    let lastProcessedTimestamp = null;

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
            const titleHtml = tabName.includes('Dashboard')
                ? `${tabName} <span class="badge" id="liveBadge">Live</span>`
                : tabName;
            document.getElementById('pageTitle').innerHTML = titleHtml;

            const targetId = item.getAttribute('data-target');
            viewSections.forEach(view => {
                view.classList.toggle('active-view', view.id === targetId);
                view.classList.toggle('hidden-view', view.id !== targetId);
            });

            if (targetId === 'trends-view') renderTrendsChart();
            if (targetId === 'alerts-view') renderAlertsTable();

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

    // 5. Chart Setups (Initialized with null so no flat 0-line appears)
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
            datasets: [{ data: [96, 4], backgroundColor: ['#22c55e', '#334155'], borderWidth: 0, cutout: '80%', circumference: 360, rotation: 270 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });

    // Trends Bar Chart (Powered by Firebase historyCache)
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
        const sliceCount = currentTrendPeriod === '1D' ? 10 : currentTrendPeriod === '1W' ? 20 : 30;
        const subset = historyCache.slice(-sliceCount);

        historyChart.data.labels = subset.map(item => {
            const d = new Date(item.timestamp);
            return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        });
        historyChart.data.datasets[0].data = subset.map(item => item[metric]);
        historyChart.data.datasets[0].backgroundColor = metric === 'ph' ? '#a855f7' : '#f59e0b';
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

    // Alerts Table (Generated dynamically from unsafe Firebase readings)
    function renderAlertsTable() {
        const tbody = document.getElementById('alertsTableBody');
        if (!tbody) return;
        const unsafeItems = historyCache.filter(item => item.status !== 'POTABLE').reverse();

        if (unsafeItems.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4">No threshold violations recorded yet. Water quality is within safe limits.</td></tr>';
            return;
        }

        tbody.innerHTML = unsafeItems.map(item => {
            let trigger = 'Parameter Violation';
            let actual = '';
            let threshold = '';
            let badgeClass = 'bg-warning';

            if (item.ph < 6.5 || item.ph > 8.5) {
                trigger = 'Critical pH';
                actual = `${item.ph} pH`;
                threshold = '6.5 - 8.5 pH';
                badgeClass = 'bg-danger';
            } else if (item.tds >= 500) {
                trigger = 'High TDS';
                actual = `${item.tds} ppm`;
                threshold = '< 500 ppm';
            } else if (item.turbidity >= 5.0) {
                trigger = 'High Turbidity';
                actual = `${item.turbidity} NTU`;
                threshold = '< 5.0 NTU';
            }

            const timeLabel = new Date(item.timestamp).toLocaleString();
            return `<tr>
                <td>${timeLabel}</td>
                <td><span class="status-badge ${badgeClass}">${trigger}</span></td>
                <td>Actual: ${actual} | Limit: ${threshold}</td>
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
            statusEl.innerText = 'Safe (Truth Value)';
        } else {
            statusEl.className = 'kpi-status status-critical';
            statusEl.innerText = trigger ? `Critical: ${trigger}` : 'Unsafe';
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
            conf: data.confidence
        };

        // KPI Values
        document.getElementById('val-temp').innerText = data.temp;
        document.getElementById('val-ph').innerText = data.ph;
        document.getElementById('val-tds').innerText = data.tds;
        document.getElementById('val-turb').innerText = data.turbidity;

        // WQI / ML Score Gauge
        document.getElementById('wqiScoreVal').innerText = `${data.confidence}%`;
        const wqiLabel = document.getElementById('wqiLabelTxt');
        wqiLabel.innerText = data.status;

        if (data.status === 'POTABLE') {
            wqiLabel.style.color = 'var(--accent-success)';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#22c55e', '#334155'];
            wqiDoughnut.data.datasets[0].data = [data.confidence, 100 - data.confidence];
            ['card-temp', 'card-ph', 'card-tds', 'card-turb'].forEach(id => updateKpiStatus(id, true));
        } else {
            wqiLabel.style.color = 'var(--accent-danger)';
            wqiDoughnut.data.datasets[0].backgroundColor = ['#ef4444', '#334155'];
            wqiDoughnut.data.datasets[0].data = [data.confidence, 100 - data.confidence];

            updateKpiStatus('card-temp', true);
            updateKpiStatus('card-ph', (data.ph >= 6.5 && data.ph <= 8.5), 'pH out of bounds');
            updateKpiStatus('card-tds', (data.tds < 500), 'TDS >= 500 ppm');
            updateKpiStatus('card-turb', (data.turbidity < 5.0), 'Turbidity >= 5.0 NTU');
        }
        wqiDoughnut.update();

        const d = new Date(data.timestamp);
        const timeStr = isNaN(d) ? new Date().toLocaleTimeString() : d.toLocaleTimeString();

        // Terminal Feed
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

    // 6. Listen to Firebase History Event (Pre-fills all charts immediately on page load!)
    window.addEventListener('hydrosense:history', (e) => {
        const list = e.detail || [];
        if (!list.length) return;
        historyCache = list;

        // Pre-populate mini & main charts with last 20 Firebase readings
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

    // 7. Listen to Firebase Live Latest Event
    window.addEventListener('hydrosense:latest', (e) => {
        const data = e.detail;
        if (!data || data.timestamp === lastProcessedTimestamp) return;
        const isFirstLoad = lastProcessedTimestamp === null;
        lastProcessedTimestamp = data.timestamp;
        applyReadingToUI(data, !isFirstLoad);
    });

    // 8. Report Generation (Professional PDF Export)
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

        const isSafePh = currentData.ph >= 6.5 && currentData.ph <= 8.5;
        const isSafeTds = currentData.tds < 500;
        const isSafeTurb = currentData.turb < 5.0;

        document.getElementById('pdfTableBody').innerHTML = `
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">Temperature</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${currentData.temp} °C</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">15.0 - 35.0 °C</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:green; font-weight:bold;">Conforme</td>
            </tr>
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">pH Level (Truth Value)</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${currentData.ph} pH</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">6.5 - 8.5</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:${isSafePh ? 'green' : 'red'}; font-weight:bold;">${isSafePh ? 'Conforme' : 'Critical'}</td>
            </tr>
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">TDS (Total Dissolved Solids)</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${currentData.tds} ppm</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">< 500 ppm</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:${isSafeTds ? 'green' : 'orange'}; font-weight:bold;">${isSafeTds ? 'Conforme' : 'Warning'}</td>
            </tr>
            <tr>
                <td style="padding:12px; border:1px solid #ccc;">Turbidity</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; font-weight:bold;">${currentData.turb} NTU</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center;">< 5.0 NTU</td>
                <td style="padding:12px; border:1px solid #ccc; text-align:center; color:${isSafeTurb ? 'green' : 'orange'}; font-weight:bold;">${isSafeTurb ? 'Conforme' : 'Warning'}</td>
            </tr>
        `;

        const vEl = document.getElementById('pdfVerdict');
        vEl.innerText = currentData.status;
        vEl.style.color = currentData.status === 'POTABLE' ? 'green' : 'red';
        document.getElementById('pdfConf').innerText = `${currentData.conf}%`;

        const element = document.getElementById('reportTemplate');
        const opt = {
            margin: 0,
            filename: `HydroSense_Official_Report_${now.getTime()}.pdf`,
            image: { type: 'jpeg', quality: 1.0 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'px', format: [794, 1123], orientation: 'portrait' }
        };
        html2pdf().set(opt).from(element).save();
    };
});