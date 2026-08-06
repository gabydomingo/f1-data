"""
Carga del silver en BigQuery.

Sube la telemetría ya limpia a Google BigQuery para consumirla desde Looker
Studio. Es una salida alternativa al dashboard propio: sirve para explorar los
datos con SQL sin levantar la aplicación.

Requiere gcp_credentials.json en la raíz del proyecto (fuera del repositorio).

Uso:
    python src/carga_bigquery.py
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
    # Se llama a pandas_gbq directo en lugar de DataFrame.to_gbq: ese atajo
    # está deprecado en pandas y emite un FutureWarning en cada corrida.
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