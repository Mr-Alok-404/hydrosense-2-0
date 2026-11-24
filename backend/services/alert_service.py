import os
import time
from datetime import datetime, timezone, timedelta
import requests

_last_alert_time = 0.0
IST = timezone(timedelta(hours=5, minutes=30))


def _format_ist_timestamp(raw_ts: str | None = None) -> str:
    """Returns a clear IST timestamp (YYYY-MM-DD HH:MM:SS IST).
    Naive timestamps are treated as UTC and converted to IST (UTC+5:30).
    """
    if raw_ts and isinstance(raw_ts, str) and raw_ts.strip() and raw_ts.strip() not in ("--", "Unknown"):
        cleaned = raw_ts.strip()
        try:
            iso_candidate = cleaned.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso_candidate)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S IST")
        except ValueError:
            pass

    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S IST")


def _post_telegram_message(message: str) -> bool:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()

    if not token or not chat_id:
        print("Telegram alert skipped: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")
        return False

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(
            url,
            json={
                "chat_id": chat_id,
                "text": message,
                "parse_mode": "Markdown",
            },
            timeout=10,
        )
        if resp.ok:
            print("Telegram notification sent successfully.")
            return True
        print("Telegram API error:", resp.status_code, resp.text)
        return False
    except Exception as exc:
        print("Telegram request failed:", exc)
        return False


def send_telegram_alert(
    reading: dict,
    cooldown_seconds: int = 0,
    enabled: bool = True,
) -> bool:
    global _last_alert_time

    if not enabled:
        print("Telegram alert skipped: disabled via dynamic settings.")
        return False

    now = time.time()
    if cooldown_seconds > 0 and (now - _last_alert_time < cooldown_seconds):
        return False

    dash_url = os.getenv("DASHBOARD_LIVE_URL", "https://hydrosense-2-0.web.app").strip()
    device_id = reading.get("device_id", "HYDRO_ESP32_01")
    ph = reading.get("ph", "--")
    tds = reading.get("tds", "--")
    turb = reading.get("turbidity", "--")
    temp = reading.get("temperature", reading.get("temp", "--"))
    status = reading.get("status", "UNSAFE")
    ts_ist = _format_ist_timestamp(reading.get("timestamp"))

    message = (
        f"🚨 *HydroSense 2.0 Water Quality Alert: {status}*\n"
        f"• *Node:* `{device_id}`\n"
        f"• *Timestamp:* `{ts_ist}`\n"
        f"• *pH:* `{ph}`\n"
        f"• *TDS:* `{tds}` ppm\n"
        f"• *Turbidity:* `{turb}` NTU\n"
        f"• *Temperature:* `{temp}` °C\n"
        f"🔗 *Dashboard:* {dash_url}"
    )

    sent = _post_telegram_message(message)
    if sent:
        _last_alert_time = now
    return sent


def send_device_offline_alert(
    device_id: str,
    last_seen_str: str,
    offline_seconds: int,
    enabled: bool = True,
) -> bool:
    if not enabled:
        return False

    dash_url = os.getenv("DASHBOARD_LIVE_URL", "https://hydrosense-2-0.web.app").strip()
    last_seen_ist = _format_ist_timestamp(last_seen_str)
    detected_at_ist = _format_ist_timestamp()

    message = (
        f"📡⚠️ *DEVICE CONNECTION LOST — OFFLINE*\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"• *Hardware Node:* `{device_id}`\n"
        f"• *Status:* `DISCONNECTED / NO HEARTBEAT`\n"
        f"• *Last Telemetry:* `{last_seen_ist}`\n"
        f"• *Detected At:* `{detected_at_ist}`\n"
        f"• *Downtime:* `{offline_seconds}s` without response\n"
        f"• *Action:* Check ESP32 power supply or Wi-Fi link.\n"
        f"🔗 *Live Monitor:* {dash_url}"
    )
    return _post_telegram_message(message)


def send_device_online_alert(
    reading: dict,
    downtime_seconds: int | None = None,
    enabled: bool = True,
) -> bool:
    if not enabled:
        return False

    dash_url = os.getenv("DASHBOARD_LIVE_URL", "https://hydrosense-2-0.web.app").strip()
    device_id = reading.get("device_id", "HYDRO_ESP32_01")
    ts_ist = _format_ist_timestamp(reading.get("timestamp"))
    ph = reading.get("ph", "--")
    tds = reading.get("tds", "--")
    turb = reading.get("turbidity", "--")
    temp = reading.get("temperature", reading.get("temp", "--"))
    status = reading.get("status", "UNKNOWN")
    source = reading.get("data_source", "--")

    downtime_line = (
        f"• *Previous Downtime:* `~{downtime_seconds}s`\n"
        if downtime_seconds is not None and downtime_seconds > 0
        else ""
    )

    message = (
        f"✅📡 *DEVICE ONLINE — TELEMETRY RESUMED*\n"
        f"════════════════════\n"
        f"• *Hardware Node:* `{device_id}`\n"
        f"• *Active Since:* `{ts_ist}`\n"
        f"{downtime_line}"
        f"• *Source:* `{source}` | *Status:* `{status}`\n"
        f"📊 *Latest Sensor Snapshot:*\n"
        f"  ◦ *pH:* `{ph}`\n"
        f"  ◦ *TDS:* `{tds}` ppm\n"
        f"  ◦ *Turbidity:* `{turb}` NTU\n"
        f"  ◦ *Temperature:* `{temp}` °C\n"
        f"🔗 *Dashboard:* {dash_url}"
    )
    return _post_telegram_message(message)