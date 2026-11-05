#!/usr/bin/env bash
# Deja a los clientes existentes listos para el envío automático de WhatsApp:
#   - crea el enlace del portal a quien no lo tenga (el que ya existe no se toca),
#   - guarda el teléfono en formato +502XXXXXXXX y reporta los inválidos,
#   - siembra la ventana semanal (15:00 → 03:00, lun–sáb) si la organización no la tiene,
#     así la invitación de las 18:00 tiene horario contra el cual salir.
# Todo queda en audit_log. No enciende el envío: eso es en
# Configuración → Plantillas de Meta.
#
# En el VPS (Openship), dentro del contenedor api:
#   docker exec -it <contenedor-api> /app/scripts/habilitar-portales-clientes.sh
#   docker exec -it <contenedor-api> /app/scripts/habilitar-portales-clientes.sh --aplicar
#
# Local, desde cualquier carpeta:
#   scripts/habilitar-portales-clientes.sh                      # en seco: solo reporta
#   scripts/habilitar-portales-clientes.sh --aplicar            # escribe
# Opciones:
#   --org <uuid>           solo esa organización
#   --activar-inactivos    también reactiva clientes desactivados
#   --rotar-sin-cifrar     rota enlaces viejos sin copia cifrada (el enlace anterior deja de servir)
#
# Lee DATABASE_URL y APP_ENCRYPTION_KEY del .env de la raíz o del entorno.
# En producción, la APP_ENCRYPTION_KEY tiene que ser la misma que usa la API.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ Falta bun (https://bun.sh)." >&2
  exit 1
fi

# Dentro del contenedor api (Openship) no hay DATABASE_URL: el entrypoint la
# arma de POSTGRES_* al arrancar. Se arma igual aquí.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
  export DATABASE_URL="postgresql://${POSTGRES_USER:-tostada}:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-postgres}:5432/${POSTGRES_DB:-misupertostada}"
fi

exec bun apps/api/scripts/habilitar-portales.ts "$@"
