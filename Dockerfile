# =============================================================================
#  Dockerfile — Clinic API (NestJS + pnpm + argon2 + TypeORM)
# =============================================================================
#  Patrón: multi-stage build (3 etapas).
#    1) deps     -> instala TODAS las dependencias (incluye dev) con build tools
#                   necesarios para compilar argon2 (dependencia nativa).
#    2) builder  -> compila el código TypeScript -> JavaScript en /dist.
#    3) runner   -> imagen FINAL minima, con solo dependencias de produccion y
#                   ejecutandose como usuario sin privilegios.
#
#  Beneficios:
#    - Imagen final pequeña (sin python, gcc, devDependencies, ni código fuente .ts).
#    - Superficie de ataque reducida (Alpine + non-root + dumb-init como PID 1).
#    - Cache eficiente (las capas de deps se reutilizan si package.json no cambia).
#
#  Build (con BuildKit habilitado para soportar cache mounts de pnpm):
#    DOCKER_BUILDKIT=1 docker build -t clinic-api:latest .
#
#  Run:
#    docker run --rm -p 3000:3000 --env-file .env --read-only \
#      --tmpfs /tmp --cap-drop=ALL --security-opt=no-new-privileges \
#      clinic-api:latest
# =============================================================================


# -----------------------------------------------------------------------------
#  ARGS globales — declarados ANTES del primer FROM para que sean accesibles
#  en todas las instrucciones FROM (imagen base). Pinneados a versión exacta
#  para builds reproducibles; subir manualmente cuando se valide una nueva LTS.
#
#  IMPORTANTE: cada ARG global se "resetea" al cruzar un FROM. Para usarlo
#  dentro de un stage hay que re-declararlo sin valor (ARG NOMBRE) — hereda
#  el global automáticamente. Si no se re-declara, la variable queda vacía.
#  Ver las re-declaraciones en cada stage.
# -----------------------------------------------------------------------------
ARG NODE_VERSION=22.11.0
ARG ALPINE_VERSION=3.20
ARG PNPM_VERSION=9.15.0


# =============================================================================
#  STAGE 1 — deps  (instala TODAS las dependencias, incl. dev)
# =============================================================================
#  Necesitamos build tools porque argon2 es una dependencia nativa que se
#  compila contra libc al instalarse (configurada en package.json:
#  pnpm.onlyBuiltDependencies = ["argon2"]).
#
#  Esta capa NO termina en la imagen final — solo aporta node_modules/.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS deps

# Re-declaración obligatoria: el ARG global PNPM_VERSION no cruza el FROM.
# Sin esta línea ${PNPM_VERSION} estaría vacío en este stage.
ARG PNPM_VERSION

# Toolchain nativo + libs que argon2 enlaza dinámicamente.
# - python3, make, g++  -> compilar el binding C/C++
# - libc6-compat        -> compatibilidad glibc en Alpine (musl)
# - dumb-init           -> se copia al runner; lo cacheamos aquí
RUN apk add --no-cache \
      python3 \
      make \
      g++ \
      libc6-compat \
      dumb-init

# pnpm via corepack — versión fijada y firmada por Node oficial.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# Copiamos SOLO los manifiestos primero. Si no cambian, Docker reutiliza
# la capa de node_modules en builds posteriores (cache hit).
COPY package.json pnpm-lock.yaml ./

# --frozen-lockfile  -> falla si lock no coincide (build determinista)
# --prod=false       -> incluye devDependencies (las necesita el builder)
# cache mount        -> reutiliza el store de pnpm entre builds (BuildKit)
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod=false


# =============================================================================
#  STAGE 2 — builder  (compila TypeScript -> JavaScript)
# =============================================================================
#  Toma node_modules de la etapa anterior y el código fuente, ejecuta
#  `pnpm build` (nest build). Resultado: /app/dist con JS plano.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS builder

# Nuevo scope de stage -> re-declarar para heredar el valor del ARG global.
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# Reusamos los node_modules ya instalados (con devDeps) y el lock.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./

# Código fuente y configs necesarias para compilar.
# .dockerignore garantiza que node_modules/dist locales no entren aquí.
COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# Compilación TS -> JS. Output: /app/dist
RUN pnpm build

# Re-instalamos SOLO dependencias de producción en una carpeta limpia,
# para copiarlas tal cual al runner sin arrastrar devDependencies ni
# herramientas de compilación.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod=true --ignore-scripts=false


# =============================================================================
#  STAGE 3 — runner  (imagen FINAL mínima y endurecida)
# =============================================================================
#  Solo lo imprescindible para correr `node dist/main`:
#    - Runtime de Node
#    - dumb-init (PID 1 que reenvía señales y cosecha zombies)
#    - node_modules de producción
#    - /dist compilado
#  Usuario no privilegiado, FS de la app de solo lectura cuando sea posible.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS runner

# Metadatos OCI — útiles para registries (ghcr, ECR, etc.) y trazabilidad.
LABEL org.opencontainers.image.title="clinic-api" \
      org.opencontainers.image.description="API NestJS clinica medica - OWASP Top 10 2025" \
      org.opencontainers.image.source="https://github.com/" \
      org.opencontainers.image.licenses="UNLICENSED"

# Solo dumb-init en runtime (sin compiladores, sin python).
RUN apk add --no-cache dumb-init libc6-compat

WORKDIR /app

# La imagen oficial de node:alpine ya incluye un usuario `node` (uid 1000).
# Lo reutilizamos en lugar de crear uno nuevo. NUNCA correr como root.
ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_LOGLEVEL=warn \
    # Evita que paquetes intenten escribir en $HOME en runtime.
    HOME=/app

# Copiamos los artefactos cambiando ownership en una sola operación
# (evita una capa extra con `chown -R` que duplicaría tamaño).
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist          ./dist
COPY --chown=node:node package.json                       ./

# Cambio a usuario no-root ANTES del entrypoint.
USER node

# Documenta el puerto (no abre nada por sí solo — eso es -p en `docker run`).
EXPOSE 3000

# Healthcheck nativo de Docker. Verifica que el proceso responde HTTP.
# Usa el modulo http de Node para no depender de curl/wget en la imagen.
# Ajustar la ruta si la API expone un /health propio.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

# dumb-init como PID 1:
#   - Reenvía SIGTERM/SIGINT al proceso Node (graceful shutdown).
#   - Cosecha procesos zombie si Node spawnea hijos.
# CMD en exec form (array) — sin shell intermedia, las señales llegan limpias.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
