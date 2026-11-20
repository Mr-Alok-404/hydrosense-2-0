import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  set,
  remove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig, DEVICE_ID } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const DEFAULT_CONFIG = {
  minPh: 6.5,
  maxPh: 8.5,
  maxTds: 500,
  maxTurb: 5.0,
  telegramEnabled: true
};

function parseTimestampMs(rawTs) {
  if (typeof rawTs === "number") {
    return rawTs < 1e12 ? rawTs * 1000 : rawTs;
  }
  if (typeof rawTs === "string" && rawTs.trim() !== "") {
    const parsed = Date.parse(rawTs);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeRecord(raw, key = null) {
  const temp = Number(raw.Temperature ?? raw.temperature ?? raw.temp ?? 0);
  const ph = Number(raw.pH ?? raw.ph ?? 0);
  const tds = Number(raw.TDS ?? raw.tds ?? 0);
  const turb = Number(raw.Turbidity ?? raw.turbidity ?? 0);
  const rawStatus = String(raw.prediction ?? raw.status ?? "WAITING").toUpperCase();
  const isSafe = rawStatus === "SAFE" || rawStatus === "POTABLE";
  const tsMs = parseTimestampMs(raw.timestamp);

  // Non-sensitive device metadata only (never Wi-Fi password)
  const ipAddress = raw.ip_address ?? raw.ip ?? raw.local_ip ?? raw.device_ip ?? null;
  const wifiSsid = raw.wifi_ssid ?? raw.ssid ?? raw.wifi_name ?? null;
  const wifiRssi = raw.wifi_rssi ?? raw.rssi ?? null;

  return {
    key,
    device_id: raw.device_id ?? DEVICE_ID,
    temp: Number(temp.toFixed(1)),
    ph: Number(ph.toFixed(2)),
    tds: Math.round(tds),
    turbidity: Number(turb.toFixed(2)),
    status: isSafe ? "POTABLE" : "NON-POTABLE",
    timestamp: new Date(tsMs).toISOString(),
    timestampMs: tsMs,
    data_source: raw.data_source ?? "SIMULATED",
    ip_address: ipAddress ? String(ipAddress) : null,
    wifi_ssid: wifiSsid ? String(wifiSsid) : null,
    wifi_rssi: wifiRssi !== null && wifiRssi !== undefined ? Number(wifiRssi) : null
  };
}

// Expose dynamic BIS & Telegram settings writer to dashboard.js
window.saveHydroSenseConfig = async function saveHydroSenseConfig(nextConfig) {
  const payload = {
    min_ph: Number(nextConfig.minPh),
    max_ph: Number(nextConfig.maxPh),
    max_tds: Number(nextConfig.maxTds),
    max_turbidity: Number(nextConfig.maxTurb),
    telegram_enabled: Boolean(nextConfig.telegramEnabled),
    updated_at: new Date().toISOString()
  };
  await set(ref(db, "config/bis_rules"), payload);
  return payload;
};

// Expose guarded database log cleaner to dashboard.js
window.clearHydroSenseStoredLogs = async function clearHydroSenseStoredLogs(targetDeviceId, alsoClearLatest = false) {
  const cleanId = String(targetDeviceId || "").trim();
  if (!cleanId) {
    throw new Error("Target Device ID is required.");
  }
  await remove(ref(db, `readings/${cleanId}`));
  if (alsoClearLatest) {
    await remove(ref(db, `latest/${cleanId}`));
  }
  return { clearedDevice: cleanId, alsoClearLatest };
};

// Track all device IDs seen under latest/
onValue(ref(db, "latest"), (snapshot) => {
  const allLatest = snapshot.val() || {};
  const deviceIds = Object.keys(allLatest);
  window.dispatchEvent(new CustomEvent("hydrosense:devices", {
    detail: deviceIds.length ? deviceIds : [DEVICE_ID]
  }));
});

// 1. Live Latest Listener for primary DEVICE_ID
onValue(ref(db, `latest/${DEVICE_ID}`), (snapshot) => {
  const val = snapshot.val();
  if (!val) {
    window.dispatchEvent(new CustomEvent("hydrosense:latest", { detail: null }));
    return;
  }
  const record = normalizeRecord(val);
  window.dispatchEvent(new CustomEvent("hydrosense:latest", { detail: record }));
});

// 2. Full Historical Readings Listener (All entries under readings/<DEVICE_ID>)
onValue(ref(db, `readings/${DEVICE_ID}`), (snapshot) => {
  const rawObj = snapshot.val();
  if (!rawObj) {
    window.dispatchEvent(new CustomEvent("hydrosense:history", { detail: [] }));
    return;
  }

  const list = Object.entries(rawObj)
    .map(([key, item]) => normalizeRecord(item, key))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  window.dispatchEvent(new CustomEvent("hydrosense:history", { detail: list }));
});

// 3. Dynamic BIS & Bot Settings Listener
onValue(ref(db, "config/bis_rules"), (snapshot) => {
  const cfg = snapshot.val() || {};
  const normalizedConfig = {
    minPh: Number(cfg.min_ph ?? DEFAULT_CONFIG.minPh),
    maxPh: Number(cfg.max_ph ?? DEFAULT_CONFIG.maxPh),
    maxTds: Number(cfg.max_tds ?? DEFAULT_CONFIG.maxTds),
    maxTurb: Number(cfg.max_turbidity ?? DEFAULT_CONFIG.maxTurb),
    telegramEnabled: cfg.telegram_enabled !== undefined ? Boolean(cfg.telegram_enabled) : DEFAULT_CONFIG.telegramEnabled
  };
  window.dispatchEvent(new CustomEvent("hydrosense:config", { detail: normalizedConfig }));
});