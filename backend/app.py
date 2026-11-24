import os
import threading
import time
from datetime import datetime, timezone
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
import requests

from firebase_service import save_reading
from services.alert_service import (
    send_device_offline_alert,
    send_device_online_alert,
    send_telegram_alert,
)
from services.ml_service import DEFAULT_THRESHOLDS, evaluate_water_quality

load_dotenv()

app = Flask(
    __name__,
    template_folder="../dashboard/templates",
    static_folder="../dashboard/static",
)
CORS(app)

OFFLINE_TIMEOUT_SECONDS = int(os.getenv("DEVICE_OFFLINE_SECONDS", "35"))


def is_ml_enabled() -> bool:
    raw = os.getenv("ML_ENABLED", "true").strip().lower()
    return raw in ("1", "true", "yes", "on")


_rules_cache = {
    "fetched_at": 0.0,
    "thresholds": dict(DEFAULT_THRESHOLDS),
    "telegram_enabled": True,
}


def get_remote_config_and_alerts() -> tuple[dict, bool]:
    now = time.time()
    if now - _rules_cache["fetched_at"] < 10.0:
        return dict(_rules_cache["thresholds"]), bool(_rules_cache["telegram_enabled"])

    db_url = os.getenv(
        "FIREBASE_DATABASE_URL",
        "https://hydrosense-2-0-default-rtdb.asia-southeast1.firebasedatabase.app",
    ).rstrip("/")

    thresholds = dict(DEFAULT_THRESHOLDS)
    telegram_enabled = True

    try:
        resp = requests.get(f"{db_url}/config/bis_rules.json", timeout=4)
        if resp.ok and isinstance(resp.json(), dict):
            data = resp.json()
            thresholds = {
                "min_ph": float(data.get("min_ph", DEFAULT_THRESHOLDS["min_ph"])),
                "max_ph": float(data.get("max_ph", DEFAULT_THRESHOLDS["max_ph"])),
                "max_tds": float(data.get("max_tds", DEFAULT_THRESHOLDS["max_tds"])),
                "max_turbidity": float(data.get("max_turbidity", DEFAULT_THRESHOLDS["max_turbidity"])),
            }
            if "telegram_enabled" in data:
                telegram_enabled = bool(data["telegram_enabled"])
    except Exception as exc:
        print(f"Warning: could not fetch /config/bis_rules from Firebase: {exc}")

    _rules_cache["fetched_at"] = now
    _rules_cache["thresholds"] = dict(thresholds)
    _rules_cache["telegram_enabled"] = telegram_enabled
    return thresholds, telegram_enabled


latest_reading = {
    "device_id": "HYDRO_ESP32_01",
    "ph": None,
    "temperature": None,
    "temp": None,
    "tds": None,
    "turbidity": None,
    "status": "WAITING",
    "confidence": None,
    "prediction_source": None,
    "ml_enabled": is_ml_enabled(),
    "timestamp": None,
}
history_readings = []

_presence_lock = threading.Lock()
_presence_state = {
    "last_seen_epoch": None,
    "last_seen_utc": None,
    "device_id": "HYDRO_ESP32_01",
    "offline_notified": False,
}


def _offline_watchdog_loop():
    """Monitors telemetry gap and sends a distinct Telegram alert once when ESP32 goes offline."""
    while True:
        time.sleep(5)
        with _presence_lock:
            last_epoch = _presence_state["last_seen_epoch"]
            already_notified = _presence_state["offline_notified"]
            device_id = _presence_state["device_id"]
            last_seen_utc = _presence_state["last_seen_utc"]

        if last_epoch is None or already_notified:
            continue

        gap = int(time.time() - last_epoch)
        if gap > OFFLINE_TIMEOUT_SECONDS:
            _, telegram_enabled = get_remote_config_and_alerts()
            sent = send_device_offline_alert(
                device_id=device_id,
                last_seen_str=last_seen_utc or "Unknown",
                offline_seconds=gap,
                enabled=telegram_enabled,
            )
            if sent:
                with _presence_lock:
                    _presence_state["offline_notified"] = True


_watchdog_thread = threading.Thread(target=_offline_watchdog_loop, daemon=True)
_watchdog_thread.start()


def normalize_payload(data: dict) -> dict:
    ph = data.get("pH", data.get("ph"))
    tds = data.get("TDS", data.get("tds"))
    turbidity = data.get("Turbidity", data.get("turbidity"))
    temp = data.get("Temperature", data.get("temperature", data.get("temp")))

    if None in (ph, tds, turbidity, temp):
        raise ValueError("Missing ph, tds, turbidity, or temperature")

    ph_val = float(ph)
    tds_val = float(tds)
    turb_val = float(turbidity)
    temp_val = float(temp)

    ml_flag = is_ml_enabled()
    thresholds, _ = get_remote_config_and_alerts()
    eval_result = evaluate_water_quality(
        ph_val,
        tds_val,
        turb_val,
        temp_val,
        ml_enabled=ml_flag,
        thresholds=thresholds,
    )

    now_utc = datetime.now(timezone.utc)

    return {
        "device_id": str(data.get("device_id", "HYDRO_ESP32_01")),
        "data_source": str(data.get("data_source", "SIMULATED")),
        "ph": round(ph_val, 2),
        "temperature": round(temp_val, 1),
        "temp": round(temp_val, 1),
        "tds": round(tds_val, 1),
        "turbidity": round(turb_val, 2),
        "status": eval_result["status"],
        "confidence": eval_result["confidence"],
        "message": eval_result["message"],
        "prediction_source": eval_result["prediction_source"],
        "ml_enabled": ml_flag,
        "timestamp": now_utc.isoformat(),
    }


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "online",
        "has_data": latest_reading["timestamp"] is not None,
        "firebase_enabled": True,
        "ml_enabled": is_ml_enabled(),
        "prediction_source": latest_reading.get("prediction_source"),
    })


@app.route("/api/sensor-data", methods=["POST"])
@app.route("/api/readings", methods=["POST"])
def ingest_data():
    global latest_reading
    data = request.get_json(silent=True) or {}
    try:
        record = normalize_payload(data)
    except (TypeError, ValueError) as exc:
        return jsonify({"status": "error", "message": str(exc)}), 400

    firebase_payload = {
        "device_id": record["device_id"],
        "pH": record["ph"],
        "TDS": record["tds"],
        "Turbidity": record["turbidity"],
        "Temperature": record["temperature"],
        "prediction": record["status"],
        "confidence": record["confidence"],
        "message": record["message"],
        "prediction_source": record["prediction_source"],
        "ml_enabled": record["ml_enabled"],
        "data_source": record["data_source"],
        "timestamp": record["timestamp"],
    }

    try:
        firebase_key = save_reading(record["device_id"], firebase_payload)
        firebase_enabled = True
    except Exception as exc:
        return jsonify({
            "status": "error",
            "message": f"Firebase save failed: {exc}",
        }), 500

    now_epoch = time.time()
    with _presence_lock:
        was_offline = _presence_state["offline_notified"]
        prev_epoch = _presence_state["last_seen_epoch"]
        downtime_sec = int(now_epoch - prev_epoch) if (was_offline and prev_epoch is not None) else None

        _presence_state["last_seen_epoch"] = now_epoch
        _presence_state["last_seen_utc"] = record["timestamp"]
        _presence_state["device_id"] = record["device_id"]
        _presence_state["offline_notified"] = False

    _, telegram_enabled = get_remote_config_and_alerts()

    online_alert_sent = False
    if was_offline:
        online_alert_sent = send_device_online_alert(
            reading=record,
            downtime_seconds=downtime_sec,
            enabled=telegram_enabled,
        )

    alert_sent = False
    if record["status"] != "SAFE":
        alert_sent = send_telegram_alert(record, enabled=telegram_enabled)

    record_with_key = {**record, "firebase_key": firebase_key}
    latest_reading = record_with_key
    history_readings.append(record_with_key)
    if len(history_readings) > 100:
        history_readings.pop(0)

    return jsonify({
        "status": "success",
        "data": record_with_key,
        "firebase_key": firebase_key,
        "firebase_enabled": firebase_enabled,
        "alert_sent": alert_sent,
        "online_alert_sent": online_alert_sent,
    }), 200


@app.route("/api/latest", methods=["GET"])
@app.route("/api/live", methods=["GET"])
def get_latest():
    if latest_reading["timestamp"] is None:
        return jsonify({"status": "waiting", "message": "No ESP32 reading received yet"}), 200
    return jsonify(latest_reading), 200


@app.route("/api/history", methods=["GET"])
def get_history():
    return jsonify(history_readings[-30:]), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)