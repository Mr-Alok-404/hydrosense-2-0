import json
import os
import firebase_admin
from firebase_admin import credentials, db
from dotenv import load_dotenv

load_dotenv()

CREDENTIALS_PATH = os.getenv("FIREBASE_CREDENTIALS_PATH", "").strip()
CREDENTIALS_JSON = os.getenv("FIREBASE_CREDENTIALS_JSON", "").strip()
DATABASE_URL = os.getenv("FIREBASE_DATABASE_URL", "").strip()


def _build_credential():
    if CREDENTIALS_JSON:
        cred_dict = json.loads(CREDENTIALS_JSON)
        return credentials.Certificate(cred_dict)

    if CREDENTIALS_PATH and os.path.exists(CREDENTIALS_PATH):
        return credentials.Certificate(CREDENTIALS_PATH)

    # Optional Render Secret File fallback (e.g. /etc/secrets/firebase-key.json)
    secret_file = "/etc/secrets/firebase-key.json"
    if os.path.exists(secret_file):
        return credentials.Certificate(secret_file)

    raise RuntimeError(
        "Firebase credentials not found. Set FIREBASE_CREDENTIALS_JSON on Render or a valid FIREBASE_CREDENTIALS_PATH locally."
    )


def initialize_firebase():
    if firebase_admin._apps:
        return

    if not DATABASE_URL:
        raise RuntimeError("FIREBASE_DATABASE_URL is not set.")

    cred = _build_credential()
    firebase_admin.initialize_app(cred, {
        "databaseURL": DATABASE_URL
    })
    print("Firebase connected successfully")


def save_reading(device_id, reading):
    initialize_firebase()

    readings_ref = db.reference(f"readings/{device_id}")
    new_ref = readings_ref.push(reading)

    db.reference(f"latest/{device_id}").set(reading)

    db.reference(f"devices/{device_id}").update({
        "online": True,
        "last_seen": reading["timestamp"]
    })

    return new_ref.key