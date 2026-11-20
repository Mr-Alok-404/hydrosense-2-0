import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  set,
  query,
  limitToLast
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

function normalizeRecord(raw, key = null) {
  const temp = Number(raw.Temperature ?? raw.temperature ?? raw.temp ?? 0);
  const ph = Number(raw.pH ?? raw.ph ?? 0);
  const tds = Number(raw.TDS ?? raw.tds ?? 0);
  const turb = Number(raw.Turbidity ?? raw.turbidity ?? 0);
  const rawStatus = String(raw.prediction ?? raw.status ?? "WAITING").toUpperCase();
  const isSafe = rawStatus === "SAFE" || rawStatus === "POTABLE";
  const tsRaw = raw.timestamp ?? new Date().toISOString();
  const parsedMs = Date.parse(tsRaw);

  return {
    key,
    device_id: raw.device_id ?? DEVICE_ID,
    temp: Number(temp.toFixed(1)),
    ph: Number(ph.toFixed(2)),
    tds: Math.round(tds),
    turbidity: Number(turb.toFixed(2)),
    status: isSafe ? "POTABLE" : "NON-POTABLE",
    confidence: Number(raw.confidence ?? (isSafe ? 96 : 88)),
    timestamp: tsRaw,
    timestampMs: Number.isNaN(parsedMs) ? Date.now() : parsedMs,
    data_source: raw.data_source ?? "SIMULATED"
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

// 1. Live Latest Listener
onValue(ref(db, `latest/${DEVICE_ID}`), (snapshot) => {
  const val = snapshot.val();
  if (!val) return;
  const record = normalizeRecord(val);
  window.dispatchEvent(new CustomEvent("hydrosense:latest", { detail: record }));
});

// 2. Historical Readings Listener (Last 50 entries)
const histQuery = query(ref(db, `readings/${DEVICE_ID}`), limitToLast(50));
onValue(histQuery, (snapshot) => {
  const rawObj = snapshot.val();
  if (!rawObj) return;

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