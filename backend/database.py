import sqlite3
from config import DATABASE_DIR, DATABASE_PATH


def get_connection():
    DATABASE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def initialize_database():
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                ph REAL NOT NULL,
                tds REAL NOT NULL,
                turbidity REAL NOT NULL,
                temperature REAL NOT NULL,
                data_source TEXT DEFAULT 'SIMULATED',
                prediction TEXT,
                message TEXT,
                prediction_source TEXT,
                created_at TEXT DEFAULT
                    (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )
        """)
        conn.commit()