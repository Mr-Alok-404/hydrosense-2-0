import os
import time
import requests

_last_alert_time = 0.0


def send_telegram_alert(
    reading: dict,
    cooldown_seconds: int = 0,
    enabled: bool = True,
) -> bool:
    global _last_alert_time

    if not enabled:
        print("Telegram alert skipped: disabled via dynamic settings.")
        return False

    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    dash_url = os.getenv("DASHBOARD_LIVE_URL", "https://hydrosense-2-0.web.app").strip()

    if not token or not chat_id:
        print("Telegram alert skipped: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")
        return False

    now = time.time()
    if now - _last_alert_time < cooldown_seconds:
        return False

    device_id = reading.get("device_id", "HYDRO_ESP32_01")
    ph = reading.get("ph", "--")
    tds = reading.get("tds", "--")
    turb = reading.get("turbidity", "--")
    temp = reading.get("temperature", reading.get("temp", "--"))
    status = reading.get("status", "UNSAFE")

    message = (
        f"🚨 *HydroSense 2.0 Alert: {status} WATER*\n"
        f"• *Device:* `{device_id}`\n"
        f"• *pH:* `{ph}`\n"
        f"• *TDS:* `{tds}` ppm\n"
        f"• *Turbidity:* `{turb}` NTU\n"
        f"• *Temperature:* `{temp}` °C\n"
        f"🔗 *Live Dashboard:* {dash_url}"
    )

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
            _last_alert_time = now
            print("Telegram alert sent successfully.")
            return True
        print("Telegram API error:", resp.status_code, resp.text)
        return False
    except Exception as exc:
        print("Telegram request failed:", exc)
        return False