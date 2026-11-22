import os
import time
import requests

_last_alert_time = 0.0


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
    if now - _last_alert_time < cooldown_seconds:
        return False

    dash_url = os.getenv("DASHBOARD_LIVE_URL", "https://hydrosense-2-0.web.app").strip()
    device_id = reading.get("device_id", "HYDRO_ESP32_01")
    ph = reading.get("ph", "--")
    tds = reading.get("tds", "--")
    turb = reading.get("turbidity", "--")
    temp = reading.get("temperature", reading.get("temp", "--"))
    status = reading.get("status", "UNSAFE")
    ts = reading.get("timestamp", "--")

    message = (
        f"🚨 *HydroSense 2.0 Water Quality Alert: {status}*\n"
        f"• *Node:* `{device_id}`\n"
        f"• *Timestamp:* `{ts}`\n"
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
    message = (
        f"📡⚠️ *DEVICE CONNECTION LOST — OFFLINE*\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"• *Hardware Node:* `{device_id}`\n"
        f"• *Status:* `DISCONNECTED / NO HEARTBEAT`\n"
        f"• *Last Telemetry:* `{last_seen_str}`\n"
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
    ts = reading.get("timestamp", "--")
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
        f"• *Active Since:* `{ts}`\n"
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