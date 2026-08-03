"""
Module: Gold Layer (BigQuery Load)
Description: Loads the processed Silver data into Google BigQuery 
             to be consumed by Looker Studio for the BI Dashboard.
"""

import os
import pandas as pd
import pandas_gbq
from google.oauth2 import service_account

CREDENTIALS_PATH = "gcp_credentials.json"
SILVER_DIR = "data/silver/2024_silverstone_R_silver.parquet"
PROJECT_ID = "f1-telemetry-bi" 
TABLE_ID = f"{PROJECT_ID}.f1_gold_layer.silverstone_telemetry"

def load_to_bigquery():
    print("INFO: Autenticando con Google Cloud...")
    credentials = service_account.Credentials.from_service_account_file(CREDENTIALS_PATH)
    
    print(f"INFO: Leyendo datos limpios desde {SILVER_DIR}...")
    df = pd.read_parquet(SILVER_DIR)
    
    print(f"INFO: Subiendo datos a BigQuery ({TABLE_ID})...")
    # Usamos pandas_gbq directamente para evitar el FutureWarning
    pandas_gbq.to_gbq(
        df,
        destination_table=TABLE_ID,
        project_id=PROJECT_ID,
        credentials=credentials,
        if_exists='replace'
    )
    print("SUCCESS: Datos cargados en la Capa Gold (BigQuery) correctamente.")

if __name__ == "__main__":
    load_to_bigquery()