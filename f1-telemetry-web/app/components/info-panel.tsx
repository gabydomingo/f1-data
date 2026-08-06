"use client";

type Props = { onClose: () => void };

export default function InfoPanel({ onClose }: Props) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-2xl overflow-auto border border-neutral-700 bg-[#141416] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-sm tracking-[0.2em] text-neutral-100">F1 TELEMETRY ENGINE</h2>
          <button onClick={onClose} className="text-[11px] text-neutral-500 hover:text-neutral-200">
            CERRAR
          </button>
        </div>

        <p className="mt-4 text-[12px] leading-relaxed text-neutral-400">
          Plataforma de análisis de telemetría de Fórmula 1. Toma los datos de tiempo real de la
          FIA, los procesa con un pipeline de tres capas sobre un data lake en AWS S3, y los
          expone acá para recorrer cualquier vuelta de cualquier piloto metro a metro.
        </p>

        <Seccion titulo="CÓMO SE LEE">
          <ul className="list-inside list-disc space-y-1">
            <li>El gráfico de abajo es una vuelta completa: cada valle es una frenada.</li>
            <li>En el mapa, los tramos rojos son donde el piloto tiene el freno pisado.</li>
            <li>Hacé click en cualquier parte del auto para ver qué mide esa zona.</li>
            <li>La barra inferior recorre la vuelta; el botón de velocidad cambia el ritmo.</li>
          </ul>
        </Seccion>

        <Seccion titulo="EL MODELO">
          <p>
            Un regresor de gradient boosting estima cuánto ritmo pierde el auto a medida que se
            gasta el neumático, entrenado con las vueltas de la temporada completa y validado
            contra un circuito que nunca vio. La ventana de parada que muestra el panel de
            estrategia sale de simular en qué vuelta se pierde menos tiempo total.
          </p>
          <p className="mt-2">
            Esa ventana queda sistemáticamente más tarde que la parada real, y es un resultado
            del análisis, no un error de cálculo: los equipos adelantan la parada para ganar
            posiciones con goma nueva, o la deciden por un coche de seguridad. Nada de eso lo
            explica la degradación.
          </p>
        </Seccion>

        <Seccion titulo="STACK">
          <p>
            Python, FastF1 y Apache Spark para el procesamiento. XGBoost para el modelo. AWS S3
            como data lake con particionado Hive. Next.js, TypeScript, Recharts y React Three
            Fiber en el front, leyendo Parquet directo desde S3 con Range Requests.
          </p>
        </Seccion>

        <Seccion titulo="FUENTES Y CRÉDITOS">
          <p>
            Datos obtenidos mediante{" "}
            <a
              href="https://docs.fastf1.dev/"
              target="_blank"
              rel="noreferrer"
              className="text-neutral-300 underline underline-offset-2"
            >
              FastF1
            </a>
            . Este proyecto no está asociado ni respaldado por la Fórmula 1 ni por la FIA. F1 y
            los nombres de escuderías y pilotos son marcas de sus respectivos titulares, usadas
            acá con fines informativos.
          </p>
          <p className="mt-2">
            {/* La licencia CC BY exige nombrar autor, título y licencia.
                Completar con los datos exactos de la página del modelo. */}
            Modelo 3D: &quot;2026 Red Bull Racing RB22&quot; por Dave Love SketchFab, publicado en
            Sketchfab bajo licencia CC BY 4.0. Optimizado para web (Draco + WebP).
          </p>
        </Seccion>
      </div>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 border-t border-neutral-800 pt-4">
      <p className="text-[10px] tracking-widest text-[#E10600]">{titulo}</p>
      <div className="mt-2 text-[11px] leading-relaxed text-neutral-500">{children}</div>
    </div>
  );
}
