# Despliegue — Openship (Mac → VPS)

Cómo subir **Mi Súper Tostada** al VPS desde la app de escritorio de Openship.
El desarrollo local **no cambia**: Postgres nativo, `bun run dev:all`, sin Docker.

Contrato del stack: `AGENTS.md`. Loop local: `USAGE.md`.

---

## Qué corre dónde

| Dónde | Qué | Cuándo |
|---|---|---|
| **Tu Mac** | App Openship (plano de control) | Solo mientras la tienes abierta |
| **VPS** | Postgres 18 + API (Node) + Next.js + OpenResty | 24/7 |

No instales `openship up` en el VPS. Eso trae otro Postgres, Redis y un dashboard 24/7 que este Plus 4 (8 GB) no debe pagar.

La app del negocio va en **Docker** (Sandboxed). El runtime Direct/bare de Openship no aplica: es para cajas de ~2 GB.

---

## Local, intacto

```bash
cp .env.example .env
bun install
bun run db:setup
bun run dev:all
```

- Web: http://localhost:3000
- API: http://localhost:3001
- `docker-compose.yml` de la raíz sigue siendo solo empaquetado (`bun run db:up`), no producción.

La carpeta `deploy/` y `openship.json` no las usa `next dev` ni Nest en watch.

---

## Una vez en el VPS (mínimo)

Ubuntu 24.04, región EE. UU., Linux. **No** Docker, nginx ni Node a mano.

1. Clave SSH desde el Mac:

```bash
ssh-keygen -t ed25519 -C "misupertostada" -f ~/.ssh/id_ed25519_tostada
```

Pega `~/.ssh/id_ed25519_tostada.pub` en el panel del VPS (o en `~/.ssh/authorized_keys`).

2. Comprueba: `ssh -i ~/.ssh/id_ed25519_tostada root@IP_DEL_VPS`

3. Firewall:

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

4. Swap de 2 GB (red de seguridad si un PDF y un deploy coinciden):

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## Openship en el Mac

1. Abre Openship (no hace falta login en desktop).
2. **Servers → Add Server**
   - Nombre: `produccion`
   - IP del VPS, puerto `22`, usuario `root`
   - Auth: **SSH Key** → `~/.ssh/id_ed25519_tostada`
   - **Test Connection** → **Save** → **Automatic Setup** (Docker + Git)
3. Nuevo proyecto → carpeta de este repo (o el remoto de GitHub).
4. Target: **Server** → `produccion`. Isolation: **Sandboxed (Docker)**.
5. **Build: This Machine** si Docker Desktop está en **linux/amd64** (Rosetta / “Use Virtualization framework”). El VPS es AMD EPYC, no ARM. Si el contenedor muere con `exec format error`, cambia el build al **servidor** y no despliegues en la ventana 21:00–03:00.
6. Pega las variables de `deploy/openship.env.example` (secretos en el panel, nunca en git).
7. **Antes del primer deploy:** en el Mac, con las mismas `R2_*` y `WEB_ORIGIN` en tu `.env` local, corre `bun run r2:cors` (ver **R2 y CORS** más abajo).
8. Dominios (A record a la IP del VPS, mismo dominio registrable):
   - `web` :3000 → `https://app.TU-DOMINIO` (panel + portal)
   - `api` :3001 → `https://api.TU-DOMINIO`
9. Deploy.

`openship.json` apunta a `deploy/docker-compose.yml`. No hace falta wizard de framework.

---

## Variables

Plantilla: `deploy/openship.env.example`.

| Clave | Notas |
|---|---|
| `WEB_ORIGIN` | URL pública del **web**, con `https://`. CORS y links de WhatsApp. |
| `NEXT_PUBLIC_API_URL` | URL pública de la **api**. Queda **horneada** en el build de Next (`deploy/Dockerfile.web`); si cambias dominio, edita el `ARG` ahí y redeploy `web`. Openship no pasa build args al compose. |
| `POSTGRES_PASSWORD` | Solo red interna. 32+ caracteres. |
| `APP_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `R2_*` | Obligatorio en production (`apps/api/src/config/env.ts`). |
| `BOOTSTRAP_ADMIN_*` | Crea el primer `ADMIN_JEFE` si `usuario` está vacía. |
| `SEED_ON_BOOT` | `true` **solo el primer deploy**, después quítalo (default `false`). El seed solo inserta lo que falta: no pisa precios, nombres ni clientes editados en el panel (`packages/db/src/seed.test.ts`). |

WhatsApp (Meta) es opcional. Sin esas claves, el Fake adapter cubre el desarrollo; en producción no se envía a Graph.

Generar la clave de cifrado:

```bash
openssl rand -hex 32
```

---

## Primer arranque

El contenedor `api`, al subir:

1. Migraciones Drizzle (`packages/db/src/migrate-prod.ts`)
2. Org + `ventana_semanal` + permisos + admin bootstrap
3. Si `SEED_ON_BOOT=true`: catálogo y clientes de `CONTEXT.md` §5, **sin** contraseñas de demo ni tokens de portal

Entra en `https://app.TU-DOMINIO/login` con el bootstrap. Crea a Alex, Carla y Tony en `/configuracion`. Luego puedes quitar `BOOTSTRAP_ADMIN_PASSWORD` del panel (el usuario ya existe).

Fotos y comprobantes van a **R2**, no al disco del VPS.

---

## R2 y CORS (obligatorio en production)

En **production** el browser sube directo al bucket con URLs prefirmadas (comprobantes del portal, fotos de producto/cliente, adjuntos en cartera/reparto). R2 responde al preflight del browser; si el bucket no tiene CORS para tu `WEB_ORIGIN`, la subida falla en consola con *No 'Access-Control-Allow-Origin' header*.

En **development** (`NODE_ENV !== production`) la API hace de proxy (`PUT /internal/storage/:key`) y no hace falta CORS en R2 para `localhost`.

### Una vez por bucket (desde el Mac)

Antes del primer deploy con clientes reales, o cada vez que cambies el dominio público del panel (`WEB_ORIGIN`):

1. En tu `.env` local (no en git), pon las mismas claves que usarás en Openship:
   - `WEB_ORIGIN=https://app.TU-DOMINIO` (exacto, sin slash final)
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`
2. Ejecuta:

```bash
bun run r2:cors
```

El script (`scripts/r2-cors.ts`) aplica en el bucket:

- **Orígenes:** `WEB_ORIGIN` de tu `.env` (en dev también añade `http://localhost:3000`).
- **Métodos:** `GET`, `PUT`, `HEAD`
- **Headers:** `content-type`, `content-length`

Debe imprimir algo como: `CORS aplicado en mi-super-tostada para: https://app.TU-DOMINIO`.

### Alternativa manual (Cloudflare)

Dashboard → R2 → tu bucket → **Settings** → **CORS policy** → pega la misma regla (origen = `WEB_ORIGIN`, métodos y headers de arriba). El script evita errores de tipeo y se puede repetir si cambias dominio.

### Qué no confundir

| Entorno | Subida al bucket | CORS en R2 |
|---|---|---|
| Local con `bun run dev:all` | Proxy por la API (`localhost:3001`) | No necesario |
| Production (Openship/VPS) | Directo desde el browser | **Sí**, con `WEB_ORIGIN` |

Si cambias `WEB_ORIGIN` en Openship después del deploy, vuelve a correr `bun run r2:cors` con el valor nuevo. No hace falta redeploy de contenedores solo por CORS.

---

## Recursos (Cloud VPS Plus 4, 8 GB)

Tope del compose (~2.7 GB de RAM, ~3.5 vCPU). El resto queda para el kernel, Docker y OpenResty.

| Servicio | RAM | CPU | Heap Node |
|---|---|---|---|
| postgres | 1024 MB | 1.0 | `shared_buffers=256MB`, máx. 50 conexiones |
| api | 1024 MB | 1.5 | `--max-old-space-size=640` (PDF en proceso) |
| web | 640 MB | 1.0 | `--max-old-space-size=448` (standalone) |

Postgres **no** publica `:5432`. Sin Redis (pg-boss usa Postgres). Sin Puppeteer.

No actives preview/staging ni un segundo entorno en esta caja.

---

## Qué no hacer

- `openship up` / `--compose` en el VPS
- Runtime Direct/bare para esta app
- Preview environments
- `SEED_ON_BOOT=true` en cada deploy
- Poner Postgres en `0.0.0.0`
- Correr `bun test` o `dev:all` en el servidor

---

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| Login no deja cookie | `WEB_ORIGIN` = origen exacto del panel (`https://app…`, sin slash final). API y web en el **mismo** eTLD+1. |
| SSE no actualiza el panel | La API ya manda `X-Accel-Buffering: no`. Si sigue muerto, el edge está bufferizando `/pedidos/stream`. |
| `exec format error` | Imagen ARM en VPS x86. Build `linux/amd64` o construir **en el servidor**. |
| OOM al desplegar | Build en el Mac, no en el VPS; confirma el swap de 2 GB. |
| API no arranca | `APP_ENCRYPTION_KEY` y `R2_*` obligatorios. Logs del contenedor `api`. |
| Comprobante o foto no sube (CORS en consola del browser) | CORS del bucket R2. Desde el Mac: `bun run r2:cors` con `WEB_ORIGIN` y `R2_*` de production. Ver sección **R2 y CORS**. |
| `/health` → `db: down` | Postgres aún no healthy; espera el `start_period` de 90 s. |

Respaldos de negocio: `pg_dump` a R2 (F-903), además de los snapshots del VPS. Los backups de Openship no sustituyen eso.

---

## Archivos de este flujo

```
openship.json                 # composePath → deploy/
deploy/docker-compose.yml      # postgres + api + web, límites
deploy/Dockerfile.api         # Bun build, Node 22 runtime
deploy/Dockerfile.web         # Next standalone
deploy/entrypoint-api.sh      # migrate → bootstrap → node
deploy/openship.env.example   # plantilla de secretos
scripts/r2-cors.ts            # CORS del bucket R2 (correr desde el Mac)
```
