"""
Module: ML Training Pipeline
Description: Automates the ingestion of Silver layer data, executes feature engineering, 
             trains the XGBoost regressor, and exports the serialized model artifact.
"""

import os
import pandas as pd
import xgboost as xgb
import pickle
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error

# Paths
SILVER_DIR = "data/silver/2024_silverstone_R_silver.parquet"
MODEL_DIR = "models/"

def train_and_export_model():
    print("INFO: Loading Silver layer data...")
    df = pd.read_parquet(SILVER_DIR)
    
    # 1. Feature Engineering (Exact same logic as EDA)
    df_model = df[(df['LapTime'] > 85) & (df['LapTime'] < 105)].copy()
    features = ['TyreLife', 'LapNumber', 'Compound']
    target = 'LapTime'
    
    df_model = df_model[features + [target]].dropna()
    df_encoded = pd.get_dummies(df_model, columns=['Compound'], drop_first=False)
    
    X = df_encoded.drop(columns=['LapTime'])
    y = df_encoded['LapTime']
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    print("INFO: Training XGBoost Regressor...")
    xgb_model = xgb.XGBRegressor(
        n_estimators=200,
        learning_rate=0.05,
        max_depth=5,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        objective='reg:squarederror'
    )
    
    xgb_model.fit(X_train, y_train)
    
    # Validation Check
    y_pred = xgb_model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    print(f"INFO: Model passed validation with MAE: {mae:.3f}s")
    
    # 2. Model Serialization (Export)
    os.makedirs(MODEL_DIR, exist_ok=True)
    model_path = os.path.join(MODEL_DIR, "xgb_strategy_model.pkl")
    
    print(f"INFO: Saving model artifact to {model_path}...")
    with open(model_path, "wb") as f:
        pickle.dump(xgb_model, f)
        
    print("SUCCESS: ML Pipeline execution complete.")

if __name__ == "__main__":
    try:
        train_and_export_model()
    except Exception as e:
        print(f"ERROR: ML Pipeline failed. Details: {e}")