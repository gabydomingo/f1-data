"""
Module: Data Transformation Pipeline (Silver Layer)
Description: Utilizes Apache Spark to read raw Bronze layer data, perform 
             schema enforcement, handle null values, and engineer features 
             (e.g., tyre degradation metrics) before saving to the Silver layer.
"""

import os
from pyspark.sql import SparkSession
from pyspark.sql.functions import col


RAW_PATH = "data/raw/2024_silverstone_R_raw.parquet"
SILVER_DIR = "data/silver/"

def transform_race_data():
    """
    Executes the PySpark transformation job to clean and structure telemetry data.
    """
    print("INFO: Initializing Apache Spark Session...")
    
    # Initialize Spark Session configured for local execution
    # master("local[*]") tells Spark to use all available CPU cores
    spark = SparkSession.builder \
        .appName("F1_Telemetry_Silver_Pipeline") \
        .master("local[*]") \
        .config("spark.driver.memory", "4g") \
        .getOrCreate()
        
    # Reduce Spark verbosity in console logs
    spark.sparkContext.setLogLevel("ERROR")
        
    print("INFO: Reading raw Parquet data...")
    # Load Bronze data
    df_raw = spark.read.parquet(RAW_PATH)
    
    # Data Cleaning & Feature Engineering
    # 1. Filter out rows without valid lap times (e.g., formation laps, DNS)
    df_clean = df_raw.filter(col("LapTime").isNotNull())
    
    # 2. Select relevant columns for strategy analysis and enforce data types
    df_transformed = df_clean.select(
        col("Driver").cast("string"),
        col("Team").cast("string"),
        col("LapNumber").cast("integer"),
        col("Stint").cast("integer"),
        col("Compound").cast("string"),
        col("TyreLife").cast("integer"),
        col("LapTime").cast("double"),
        col("Sector1Time").cast("double"),
        col("Sector2Time").cast("double"),
        col("Sector3Time").cast("double")
    )
    
    # 3. Handle Missing Values: Ensure TyreLife has no nulls for ML modeling
    df_transformed = df_transformed.fillna({"TyreLife": 0})
    
    # Ensure Silver directory exists
    os.makedirs(SILVER_DIR, exist_ok=True)
    
    # In PySpark, writing to a directory creates a partitioned Parquet structure
    output_path = os.path.join(SILVER_DIR, "2024_silverstone_R_silver.parquet")
    
    print(f"INFO: Writing transformed data to Silver Layer: {output_path}")
    # Write to Parquet (Overwrite mode ensures idempotency in the pipeline)
    df_transformed.write.mode("overwrite").parquet(output_path)
    
    print("SUCCESS: Silver layer transformation complete.")
    
    # Gracefully shut down the Spark JVM
    spark.stop()

if __name__ == "__main__":
    try:
        transform_race_data()
    except Exception as e:
        print(f"ERROR: PySpark job failed. Details: {e}")