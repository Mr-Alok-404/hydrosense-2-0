import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  query,
  limitToLast
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig, DEVICE_ID } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

function normalizeRecord(raw, key = null) {
  const temp = Number(raw.Temperature ?? raw.temperature ?? raw.temp ?? 0);
  const ph = Number(raw.pH ?? raw.ph ?? 0);
  const tds = Number(raw.TDS ?? raw.tds ?? 0);
  const turb = Number(raw.Turbidity ?? raw.turbidity ?? 0);
  const rawStatus = (raw.prediction ?? raw.status ?? "WAITING").toUpperCase();
  const isSafe = rawStatus === "SAFE" || rawStatus === "POTABLE";

  return {
    key,
    device_id: raw.device_id ?? DEVICE_ID,
    temp: Number(temp.toFixed(1)),
    ph: Number(ph.toFixed(2)),
    tds: Math.round(tds),
    turbidity: Number(turb.toFixed(2)),
    status: isSafe ? "POTABLE" : "NON-POTABLE",
    confidence: Number(raw.confidence ?? (isSafe ? 96 : 88)),
    timestamp: raw.timestamp ?? new Date().toISOString(),
    data_source: raw.data_source ?? "SIMULATED"
  };
}

// 1. Live Latest Listener
onValue(ref(db, `latest/${DEVICE_ID}`), (snapshot) => {
  const val = snapshot.val();
  if (!val) return;
  const record = normalizeRecord(val);
  window.dispatchEvent(new CustomEvent("hydrosense:latest", { detail: record }));
});

// 2. Historical Readings Listener (Last 30 entries for graphs & trends)
const histQuery = query(ref(db, `readings/${DEVICE_ID}`), limitToLast(30));
onValue(histQuery, (snapshot) => {
  const rawObj = snapshot.val();
  if (!rawObj) return;

  const list = Object.entries(rawObj).map(([key, item]) => normalizeRecord(item, key));
  window.dispatchEvent(new CustomEvent("hydrosense:history", { detail: list }));
});