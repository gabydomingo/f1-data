"""
Module: Source Reachability Check
Description: Chequea si la fuente de timing de la F1 acepta al cliente.

             FastF1 no levanta excepción cuando el host lo rechaza: pide la
             página, ve un status >=400, reintenta contra su mirror y si ese
             también falla devuelve None. Arriba eso se vuelve un
             "Failed to load timing data!" de nivel WARNING y la sesión queda
             vacía. El script de ingesta termina bien y el workflow sale verde
             sobre cero carreras.

             Este chequeo pide los dos hosts a mano para que el código de
             respuesta quede escrito en el log. No falla nunca: el que tiene
             que romper el build es la ingesta.

Uso:
    python src/diagnostico_fuente.py
"""

import socket
import urllib.error
import urllib.request

# Los mismos de fastf1/_api.py. Importan: el User-Agent 'BestHTTP' es parte
# de lo que la fuente mira para decidir si contesta.
HOSTS = {
    "principal": "https://livetiming.formula1.com",
    "mirror": "https://livetiming-mirror.fastf1.dev",
}
HEADERS = {
    "Connection": "close",
    "TE": "identity",
    "User-Agent": "BestHTTP",
    "Accept-Encoding": "gzip, identity",
}
TIMEOUT = 20


def probar(nombre: str, url: str) -> bool:
    """Devuelve True si el host contestó algo que no sea un rechazo."""
    req = urllib.request.Request(url, headers=HEADERS, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            print(f"  {nombre:<11} {url}  ->  HTTP {r.status}")
            return True
    except urllib.error.HTTPError as e:
        # 404 en la raíz es normal y significa que el host nos atiende.
        # 403 es lo que devuelve cuando bloquea por IP o por cliente.
        alcanzable = e.code not in (401, 403, 429)
        print(f"  {nombre:<11} {url}  ->  HTTP {e.code} {e.reason}")
        return alcanzable
    except (urllib.error.URLError, socket.timeout, OSError) as e:
        motivo = getattr(e, "reason", e)
        print(f"  {nombre:<11} {url}  ->  sin respuesta ({type(e).__name__}: {motivo})")
        return False


def main() -> None:
    print("INFO: probando la fuente de timing desde esta máquina...")
    print("INFO: se pide la raíz de cada host, así que esto dice si el host "
          "atiende al cliente, no si tiene los datos de una sesión puntual.")
    resultados = {n: probar(n, u) for n, u in HOSTS.items()}

    # El que manda es el principal. El mirror es el plan B de FastF1, que ya
    # cae solo cuando el principal responde >=400: que el mirror conteste en
    # la raíz no alcanza para decir que la ingesta va a andar.
    if not resultados["principal"]:
        print("ALERTA: el host principal rechaza a este cliente. Es el caso "
              "típico de bloqueo por IP de datacenter, y es lo que hace que "
              "la ingesta salga vacía sin levantar ningún error.")
        if resultados["mirror"]:
            print("ALERTA: el mirror sí atiende, pero FastF1 ya reintenta "
                  "contra él solo. Si la ingesta igual viene vacía, el mirror "
                  "tampoco tiene estas sesiones.")
    elif all(resultados.values()):
        print("INFO: los dos hosts atienden. Si la ingesta igual viene vacía, "
              "el problema no es de alcance de red.")
    else:
        print("INFO: el host principal atiende, que es el que importa.")


if __name__ == "__main__":
    main()
