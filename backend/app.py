import os
from datetime import datetime, timezone
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

from firebase_service import save_reading
from services.alert_service import send_telegram_alert
from services.ml_service import evaluate_water_quality

load_dotenv()

app = Flask(
    __name__,
    template_folder="../dashboard/templates",
    static_folder="../dashboard/static",
)
CORS(app)

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
    "timestamp": None,
}
history_readings = []


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

    eval_result = evaluate_water_quality(ph_val, tds_val, turb_val, temp_val)

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
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
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
        "data_source": record["data_source"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    try:
        firebase_key = save_reading(record["device_id"], firebase_payload)
        firebase_enabled = True
    except Exception as exc:
        return jsonify({
            "status": "error",
            "message": f"Firebase save failed: {exc}",
        }), 500

    alert_sent = False
    if record["status"] != "SAFE":
        alert_sent = send_telegram_alert(record)

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