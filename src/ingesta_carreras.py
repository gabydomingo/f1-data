"""
Module: Raw Data Ingestion Pipeline
Description: Automates the extraction of full race lap data and weather conditions 
             via FastF1 API, storing the raw output in Parquet format (Bronze Layer) 
             for downstream Big Data processing.
"""

import os
import fastf1
import pandas as pd

# Path configurations
CACHE_DIR = os.path.abspath("../data/cache/")
RAW_DATA_DIR = os.path.abspath("../data/raw/")

# Ensure directories exist
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(RAW_DATA_DIR, exist_ok=True)

# Enable caching
fastf1.Cache.enable_cache(CACHE_DIR)

def ingest_race_laps(year: int, grand_prix: str, session_type: str = 'R') -> str:
    """
    Downloads comprehensive lap data for all drivers in a given session,
    merges weather data, and exports it as a Parquet file.

    Args:
        year (int): Championship year.
        grand_prix (str): Event location/name.
        session_type (str): Session identifier (default 'R' for Race).

    Returns:
        str: The absolute path to the saved Parquet file.
    """
    print(f"INFO: Initiating ingestion pipeline for {grand_prix} {year} - Session: {session_type}")
    
    # Load the session (loading weather data is critical for tire strategy ML models)
    session = fastf1.get_session(year, grand_prix, session_type)
    session.load(telemetry=False, weather=True, messages=False)
    
    # Extract laps data for all drivers
    laps_df = session.laps
    
    # FastF1 returns specific object types (like Timedelta) that Parquet might reject.
    # We convert timedelta columns to standard float seconds for robust storage.
    timedelta_cols = laps_df.select_dtypes(include=['timedelta64[ns]']).columns
    for col in timedelta_cols:
        laps_df[col] = laps_df[col].dt.total_seconds()
        
    # Novedad: Convertir fechas de nanosegundos a strings para compatibilidad con Apache Spark
    datetime_cols = laps_df.select_dtypes(include=['datetime', 'datetimetz']).columns
    for col in datetime_cols:
        laps_df[col] = laps_df[col].astype(str)
        
    # Cast complex object columns to string to ensure Parquet serialization
    laps_df['Driver'] = laps_df['Driver'].astype(str)
    laps_df['Team'] = laps_df['Team'].astype(str)
    laps_df['Compound'] = laps_df['Compound'].astype(str)
    
    # Define output filename and path
    filename = f"{year}_{grand_prix.replace(' ', '_').lower()}_{session_type}_raw.parquet"
    output_path = os.path.join(RAW_DATA_DIR, filename)
    
    # Export to Parquet (Snappy compression is default and highly efficient)
    laps_df.to_parquet(output_path, index=False)
    
    print(f"SUCCESS: Raw data successfully written to Data Lake at: {output_path}")
    print(f"INFO: Ingested {len(laps_df)} rows and {len(laps_df.columns)} columns.")
    
    return output_path

if __name__ == "__main__":
    # Parameters for the pipeline execution
    TARGET_YEAR = 2024
    TARGET_GP = 'Silverstone'
    
    try:
        saved_file_path = ingest_race_laps(TARGET_YEAR, TARGET_GP)
    except Exception as e:
        print(f"ERROR: Pipeline execution failed. Details: {e}")