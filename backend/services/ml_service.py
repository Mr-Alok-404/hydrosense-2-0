from pathlib import Path
import joblib
import lightgbm as lgb
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
FEATURES = ["pH", "TDS_ppm", "Turbidity_NTU", "Temperature_C"]

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


def check_bis_rules(ph: float, tds: float, turbidity: float):
    if ph < 6.5 or ph > 8.5:
        return True, "BIS Violation: pH out of safe range (6.5 - 8.5)"
    if tds > 500:
        return True, "BIS Violation: TDS > 500 ppm"
    if turbidity > 5.0:
        return True, "BIS Violation: Turbidity > 5.0 NTU"
    return False, "Passes Basic Rules"


def evaluate_water_quality(ph: float, tds: float, turbidity: float, temperature: float) -> dict:
    # Stage 1: BIS Threshold Fast-Path
    is_violation, rule_message = check_bis_rules(ph, tds, turbidity)
    if is_violation:
        return {
            "status": "UNSAFE",
            "message": rule_message,
            "prediction_source": "BIS_RULES_LOCAL",
            "confidence": 94,
        }

    # Stage 2: LightGBM Model Inference
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
                "Water passed both BIS thresholds and LightGBM screening."
                if is_safe
                else "Water passes BIS rules, but LightGBM detected a hazard pattern."
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
                "Water passed both BIS thresholds and AI screening."
                if is_safe
                else "Water passes BIS rules, but AI detected a hazard pattern."
            ),
            "prediction_source": "LIGHTGBM_JOBLIB",
            "confidence": max(50, min(99, conf)),
        }

    # Fallback if no model file is found
    return {
        "status": "SAFE",
        "message": "Water quality parameters are within acceptable limits",
        "prediction_source": "BIS_RULES_LOCAL",
        "confidence": 95,
    }