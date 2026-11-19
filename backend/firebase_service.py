import os
import firebase_admin
from firebase_admin import credentials, db
from dotenv import load_dotenv

load_dotenv()

CREDENTIALS_PATH = os.getenv("FIREBASE_CREDENTIALS_PATH")
DATABASE_URL = os.getenv("FIREBASE_DATABASE_URL")


def initialize_firebase():
    if firebase_admin._apps:
        return

    cred = credentials.Certificate(CREDENTIALS_PATH)

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