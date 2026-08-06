# F1 Telemetry Engine

Plataforma de análisis de telemetría de Fórmula 1 construida sobre un pipeline de datos propio.
Toma el cronometraje oficial de la FIA, lo procesa en un data lake de tres capas y lo expone en un
dashboard donde se puede recorrer cualquier vuelta de cualquier piloto, metro a metro.

**[Ver el dashboard][(https://TU-URL.vercel.app](https://f1-data-two.vercel.app/)**

<!-- Reemplazar por una captura del dashboard en funcionamiento -->
![Dashboard](docs/screenshot.png)

---

## Qué hace

- **59 carreras** de las temporadas 2024, 2025 y 2026 (en curso), con la telemetría completa de cada piloto.
- **Reproducción de una vuelta** sincronizada entre cuatro paneles: gráfico de velocidad y acelerador,
  mapa de pista con las zonas de frenada, visor 3D del auto y lectura instantánea de nueve magnitudes.
- **Modelo de degradación de neumáticos** entrenado sobre 65.000 vueltas, con la ventana de parada
  óptima contrastada contra la parada real de cada piloto.
- **Fuerzas G derivadas** de la trayectoria: no vienen en el dato oficial, se calculan en el cliente.

---

## Arquitectura

```
FastF1 (timing oficial FIA)
        │
        ▼
  ┌───────────┐   ingesta vuelta por vuelta        Python + FastF1
  │  BRONZE   │   data/raw/{año}/{gp}/             Parquet local
  └───────────┘   ~37M filas de telemetría
        │
        ▼
  ┌───────────┐   limpieza y tipado                PySpark
  │  SILVER   │   particionado Hive:               Parquet + Snappy
  └───────────┘   Year=/GrandPrix=/Driver=         → AWS S3 (1,1 GB)
        │
        ▼
  ┌───────────┐   catálogo, predicciones,          XGBoost
  │   GOLD    │   métricas del modelo              JSON + BigQuery
  └───────────┘
        │
        ▼
  Next.js App Router  ──►  lee Parquet directo de S3 con Range Requests
```

### Decisiones que vale la pena mirar

**Lectura de Parquet desde S3 sin descargar el archivo.** La API usa `hyparquet` con Range Requests:
pide solo los bytes de las columnas que necesita. Un archivo de 40.000 filas se resuelve leyendo unos
pocos cientos de KB.

**Particionado Hive.** El piloto, el circuito y el año están en el nombre de la carpeta, no dentro del
archivo. Filtrar por piloto no cuesta nada: es resolver una ruta.

**Sobrescritura dinámica de particiones.** Reprocesar Monza no borra el resto del data lake, lo que
permite que el job semanal actualice una sola carrera.

**Las fuerzas G se calculan, no se leen.** El timing oficial no publica acelerómetros. La aceleración
lateral sale de cuánto gira el rumbo del auto por metro recorrido; la longitudinal, de la variación de
velocidad respecto a la distancia. Ambas se miden sobre una base de 20 metros porque el muestreo es
irregular —de 4 cm a 46 m entre muestras— y con vecinos inmediatos el ruido de posición domina.

---

## Qué encontró el análisis

### El modelo de degradación funciona

Entrenado sobre 52.718 vueltas de 2024-2025 y validado **contra un circuito completo que nunca vio**:

| | Valor |
|---|---|
| Error medio | 0,678 s |
| Baseline (predecir el promedio) | 0,814 s |
| **Mejora sobre el baseline** | **16,7%** |
| Features por importancia | `TyreLife` › `Stint` › `LapNumber` |

El target no es el tiempo de vuelta absoluto sino la diferencia contra el mejor ritmo del piloto en esa
carrera, corregida por carga de combustible. Predecir el absoluto obligaría al modelo a saber en qué
circuito está —Monza gira en 80 segundos y Singapur en 100— y ante una pista nueva sería imposible.

### La ventana de parada no se puede predecir solo con degradación

El optimizador busca la vuelta que minimiza el tiempo total de carrera. Su respuesta queda
**sistemáticamente unas 12 vueltas más tarde** que la parada real, y eso es un resultado, no un error
de cálculo:

- **La F1 se corre contra otros autos, no contra el reloj.** Parar antes que el rival da dos vueltas
  rápidas con goma nueva y le gana la posición, aunque en tiempo absoluto se pierda.
- **Los safety cars deciden muchas paradas.** Con el auto de seguridad en pista, entrar a boxes cuesta
  la mitad.
- **Las banderas rojas la regalan.** En Japón y Mónaco 2024 la carrera se detuvo en las primeras
  vueltas y los veinte pilotos cambiaron neumáticos gratis: el modelo acierta cero de treinta y cuatro,
  y ningún modelo de degradación podría hacerlo mejor.

Modelar esto requiere posición en pista y distancia al auto de adelante. Ambos datos ya se guardan en
el silver; el modelo todavía no los usa.

### El feed oficial tiene huecos

De 59 carreras, **una tiene los datos de posición inutilizables**: en Hungría 2026 el cronometraje
repite la última coordenada conocida mientras el auto recorre cien metros a 324 km/h. El pipeline lo
detecta comparando cuánto se mueven las coordenadas contra cuánto avanzó el auto, y el dashboard
avisa en lugar de dibujar un trazado falso.

---

## Stack

| Capa | Herramientas |
|---|---|
| Ingesta | Python, FastF1, pandas |
| Procesamiento | PySpark |
| Almacenamiento | AWS S3, Parquet + Snappy, particionado Hive |
| ML | XGBoost, scikit-learn |
| Warehouse / BI | BigQuery, Looker Studio |
| Frontend | Next.js (App Router), TypeScript, Tailwind |
| Visualización | Recharts, SVG, React Three Fiber |
| Lectura remota | hyparquet sobre Range Requests |
| Automatización | GitHub Actions |
| Deploy | Vercel |

---

## Estructura

```
f1-data/
├── src/
│   ├── ingesta_carreras.py        Bronze: FastF1 → Parquet, vuelta por vuelta
│   ├── transformacion_carrera.py  Silver: PySpark, particionado Hive
│   ├── catalogo.py                Gold: índice de circuitos, pilotos y calidad de datos
│   ├── entrenamiento_modelo.py    Modelo de degradación, un modelo por era reglamentaria
│   ├── predicciones.py            Gold: ventana de parada óptima por piloto y carrera
│   ├── carga_bigquery.py          Warehouse para Looker Studio
│   └── verificar_silver.py        Chequeos de integridad del data lake
├── notebooks/                     Exploración y prototipos
├── .github/workflows/             Actualización semanal automática
└── f1-telemetry-web/              Dashboard Next.js
    └── app/
        ├── api/                   telemetry · catalog · strategy
        ├── components/            gráfico, mapa, visor 3D, tarjetas
        ├── hooks/                 fetch con cancelación y cache
        └── lib/                   lectura de S3 y cálculo de fuerzas G
```

---

## Cómo correrlo

Hace falta Python 3.10+, Java 17 (para Spark), Node 20+ y una cuenta de AWS.

```bash
# Pipeline de datos
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

F1_YEAR=2024 python src/ingesta_carreras.py        # descarga y arma el bronze
F1_YEAR=2024 python src/transformacion_carrera.py  # limpia y particiona el silver
python src/catalogo.py                             # índice para el dashboard

F1_YEARS=2024,2025 python src/entrenamiento_modelo.py
F1_YEARS=2024,2025 python src/predicciones.py

aws s3 sync data/silver s3://TU-BUCKET/data/silver --exclude "*.crc" --exclude "*_SUCCESS"
aws s3 sync data/gold   s3://TU-BUCKET/data/gold
```

```bash
# Dashboard
cd f1-telemetry-web
npm install
npm run dev
```

Variables de entorno en `f1-telemetry-web/.env.local`:

```
AWS_REGION=us-east-2
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Conviene usar un usuario IAM con permiso de lectura únicamente sobre el bucket.

---

## Limitaciones conocidas

- **La ventana de parada no modela el tráfico ni los safety cars.** Ver la sección de hallazgos.
- **El modelo de 2026 tiene un cuarto de los datos** que el de 2024-2025: su menor rendimiento (6,3%
  contra 16,7%) no permite concluir todavía que los autos nuevos degraden distinto.
- **El dashboard requiere pantalla de escritorio.** Muestra cuatro paneles simultáneos; en móvil avisa
  en lugar de romperse.
- **Las fuerzas G son una estimación** derivada de la trayectoria, no una medición del auto.

---

## Fuentes y créditos

Datos obtenidos mediante [FastF1](https://docs.fastf1.dev/), que expone el cronometraje oficial de la
Fórmula 1.

Este proyecto no está asociado ni respaldado por la Fórmula 1, la FIA ni ninguna escudería. F1 y los
nombres de equipos y pilotos son marcas de sus respectivos titulares, usadas aquí con fines
informativos y educativos.

Modelo 3D: "2026 Red Bull Racing RB22" por AUTOR_DEL_MODELO, publicado en Sketchfab bajo licencia
CC BY 4.0. Optimizado para web con Draco y WebP.
