from pathlib import Path
import joblib
import lightgbm as lgb
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
FEATURES = ["pH", "TDS_ppm", "Turbidity_NTU", "Temperature_C"]

DEFAULT_THRESHOLDS = {
    "min_ph": 6.5,
    "max_ph": 8.5,
    "max_tds": 500.0,
    "max_turbidity": 5.0,
}

JOBLIB_CANDIDATES = [
    BASE_DIR / "model" / "lightgbm_water_model.joblib",
    BASE_DIR / "models" / "lightgbm_water_model.joblib",
    BASE_DIR / "lightgbm_water_model.joblib",
]

TXT_CANDIDATES = [
    BASE_DIR / "model" / "lightgbm_water_model.txt",
    BASE_DIR / "models" / "lightgbm_water_model.txt",
    BASE_DIR / "lightgbm_water_model.txt",
]

_loaded = False
_joblib_model = None
_lgb_booster = None


def _ensure_model_loaded():
    global _loaded, _joblib_model, _lgb_booster
    if _loaded:
        return

    for path in TXT_CANDIDATES:
        if path.exists():
            try:
                _lgb_booster = lgb.Booster(model_file=str(path))
                _loaded = True
                return
            except Exception as exc:
                print(f"Warning: failed to load LightGBM txt model {path}: {exc}")

    for path in JOBLIB_CANDIDATES:
        if path.exists():
            try:
                _joblib_model = joblib.load(path)
                _loaded = True
                return
            except Exception as exc:
                print(f"Warning: failed to load joblib model {path}: {exc}")

    _loaded = True


def check_bis_rules(
    ph: float,
    tds: float,
    turbidity: float,
    thresholds: dict | None = None,
):
    cfg = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    min_ph = float(cfg["min_ph"])
    max_ph = float(cfg["max_ph"])
    max_tds = float(cfg["max_tds"])
    max_turb = float(cfg["max_turbidity"])

    if ph < min_ph or ph > max_ph:
        return True, f"Threshold Violation: pH out of safe range ({min_ph} - {max_ph})"
    if tds > max_tds:
        return True, f"Threshold Violation: TDS > {max_tds} ppm"
    if turbidity > max_turb:
        return True, f"Threshold Violation: Turbidity > {max_turb} NTU"
    return False, "Passes Configured Thresholds"


def evaluate_water_quality(
    ph: float,
    tds: float,
    turbidity: float,
    temperature: float,
    ml_enabled: bool = True,
    thresholds: dict | None = None,
) -> dict:
    # Stage 1: Configured Threshold Check
    is_violation, rule_message = check_bis_rules(ph, tds, turbidity, thresholds=thresholds)
    if is_violation:
        return {
            "status": "UNSAFE",
            "message": rule_message,
            "prediction_source": "BIS_RULES_LOCAL",
            "confidence": 94,
        }

    # If ML flag is explicitly disabled, rely purely on threshold evaluation
    if not ml_enabled:
        return {
            "status": "SAFE",
            "message": "ML disabled (ML_ENABLED=false); water parameters are within configured safe limits.",
            "prediction_source": "THRESHOLDS_ONLY",
            "confidence": 95,
        }

    # Stage 2: ML Model Inference
    _ensure_model_loaded()
    input_df = pd.DataFrame(
        [[ph, tds, turbidity, temperature]],
        columns=FEATURES,
    )

    if _lgb_booster is not None:
        prob_safe = float(_lgb_booster.predict(input_df)[0])
        is_safe = prob_safe >= 0.5
        conf = int(round((prob_safe if is_safe else (1.0 - prob_safe)) * 100))
        return {
            "status": "SAFE" if is_safe else "UNSAFE",
            "message": (
                "Water passed configured thresholds and LightGBM screening."
                if is_safe
                else "Water passes thresholds, but LightGBM detected a hazard pattern."
            ),
            "prediction_source": "LIGHTGBM_BOOSTER",
            "confidence": max(50, min(99, conf)),
        }

    if _joblib_model is not None:
        pred = int(_joblib_model.predict(input_df)[0])
        conf = 96
        if hasattr(_joblib_model, "predict_proba"):
            proba = _joblib_model.predict_proba(input_df)[0]
            conf = int(round(float(max(proba)) * 100))
        is_safe = pred == 1
        return {
            "status": "SAFE" if is_safe else "UNSAFE",
            "message": (
                "Water passed configured thresholds and AI screening."
                if is_safe
                else "Water passes thresholds, but AI detected a hazard pattern."
            ),
            "prediction_source": "LIGHTGBM_JOBLIB",
            "confidence": max(50, min(99, conf)),
        }

    return {
        "status": "SAFE",
        "message": "Water quality parameters are within acceptable limits",
        "prediction_source": "BIS_RULES_LOCAL",
        "confidence": 95,
    }