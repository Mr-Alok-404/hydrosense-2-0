from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DATABASE_DIR = BASE_DIR / "backend" / "local_db"
DATABASE_PATH = DATABASE_DIR / "hydrosense_local.db"

DEVICE_ID = "HYDRO_001"
DEVICE_API_KEY = "HYDRO_SECRET_KEY_123"

ML_ENABLED = False