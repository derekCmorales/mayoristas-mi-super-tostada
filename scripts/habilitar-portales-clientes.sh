#!/usr/bin/env bash
# Deja a los clientes existentes listos para el envío automático de WhatsApp:
#   - crea el enlace del portal a quien no lo tenga (el que ya existe no se toca),
#   - guarda el teléfono en formato +502XXXXXXXX y reporta los inválidos,
#   - siembra la ventana semanal (15:00 → 03:00, lun–sáb) si la organización no la tiene,
#     así la invitación de las 18:00 tiene horario contra el cual salir.
# Todo queda en audit_log. No enciende el envío: eso es en
# Configuración → Plantillas de Meta.
#
# Uso, desde cualquier carpeta:
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

exec bun apps/api/scripts/habilitar-portales.ts "$@"
