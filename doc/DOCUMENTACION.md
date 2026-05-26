# DOCUMENTACION.md — Clinic API

> Documento maestro del proyecto. Pensado para que un asistente IA (Claude) o un nuevo desarrollador pueda entender el sistema completo sin tener que leer todo el código fuente.

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Stack tecnológico](#2-stack-tecnológico)
3. [Estructura del proyecto](#3-estructura-del-proyecto)
4. [Módulos de dominio](#4-módulos-de-dominio)
5. [Modelo de datos](#5-modelo-de-datos)
6. [Autenticación y autorización](#6-autenticación-y-autorización)
7. [Seguridad (OWASP Top 10 2025)](#7-seguridad-owasp-top-10-2025)
8. [API endpoints](#8-api-endpoints)
9. [Configuración y variables de entorno](#9-configuración-y-variables-de-entorno)
10. [Docker y despliegue](#10-docker-y-despliegue)
11. [Base de datos y migraciones](#11-base-de-datos-y-migraciones)
12. [Comandos útiles](#12-comandos-útiles)
13. [Convenciones de código](#13-convenciones-de-código)
14. [Documentación adicional](#14-documentación-adicional)

---

## 1. Resumen ejecutivo

**Clinic API** es una API RESTful para la gestión de una clínica médica. Permite administrar:

- **Usuarios** del sistema con roles (admin, doctor, paciente)
- **Pacientes** con sus datos clínicos básicos
- **Médicos** con sus especialidades
- **Especialidades** médicas (catálogo)
- **Citas** médicas con prevención de double-booking y estados

### Arquitectura

- **Monolito modular** en NestJS 11 (un solo proceso, una sola BD)
- **6 módulos de dominio** auto-contenidos: `auth`, `users`, `patients`, `doctors`, `specialties`, `appointments`
- **Persistencia**: PostgreSQL 16 con TypeORM (sin auto-sync, solo migraciones)
- **Caché/Blocklist**: Valkey 8 (fork de Redis) para revocación de JWT
- **Contenedorización**: Docker multi-stage con imagen final endurecida (Alpine + non-root + read-only)

### Principios de diseño

| Principio | Aplicación |
|-----------|-----------|
| **Seguridad por defecto** | `JwtAuthGuard` global; endpoints públicos se marcan explícitamente con `@Public()` |
| **Defense in depth** | Validación a nivel de DTO + RBAC en controlador + ownership en servicio |
| **Fail-fast** | Secretos JWT <32 bytes en producción abortan el arranque |
| **IDOR prevention** | Cada servicio implementa `assertCanRead`/`assertCanWrite` |
| **Sin auto-sync** | `synchronize: false`; esquema se versiona en migraciones |
| **UUID v4** | Previene enumeración de recursos |

---

## 2. Stack tecnológico

### Runtime y framework

| Tecnología | Versión | Propósito |
|-----------|---------|-----------|
| **Node.js** | 22.x LTS | Runtime |
| **TypeScript** | 5.7 | Lenguaje |
| **NestJS** | 11.x | Framework HTTP modular |
| **pnpm** | 9.x | Gestor de paquetes |

### Persistencia

| Tecnología | Versión | Propósito |
|-----------|---------|-----------|
| **PostgreSQL** | 16 (alpine) | BD principal |
| **TypeORM** | 0.3.28 | ORM con migraciones versionadas |
| **Valkey** | 8 (alpine) | Blocklist de access tokens JWT |
| **ioredis** | 5.x | Cliente Valkey/Redis |

### Seguridad

| Tecnología | Propósito |
|-----------|-----------|
| **Passport.js** | Framework de estrategias de auth (`jwt`, `local`) |
| **@nestjs/jwt** | Firma/verificación HS256 |
| **Argon2id** | Hashing de password y refresh tokens (64MB, 3 iters, 4 hilos) |
| **Helmet** | Headers HTTP de seguridad (CSP, HSTS, X-Frame-Options) |
| **@nestjs/throttler** | Rate limiting por IP (60 rpm baseline; endpoints sensibles más estrictos) |
| **class-validator** | Validación de DTOs |

### Documentación y dev

| Tecnología | Propósito |
|-----------|-----------|
| **Swagger UI** | Documentación interactiva en `/api/docs` (solo dev, con Basic Auth) |
| **express-basic-auth** | Protege Swagger en dev |
| **cookie-parser** | Lee cookie HttpOnly del refresh token |
| **Jest** | Tests unitarios y e2e |
| **ESLint + Prettier** | Linting y formato |

---

## 3. Estructura del proyecto

```
BASE-API-NEST-DELUXE/
├── src/
│   ├── main.ts                      # Bootstrap: helmet, CORS, pipes, swagger
│   ├── app.module.ts                # Módulo raíz: TypeORM, Throttler, guards globales
│   ├── app.controller.ts            # Health check GET /
│   ├── app.service.ts
│   │
│   ├── auth/                        # Autenticación (login/register/refresh/logout)
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts          # validateUser, issueTokens, refresh con reuse detection
│   │   ├── auth.module.ts
│   │   ├── dto/{login,register}.dto.ts
│   │   ├── guards/{jwt-auth,local-auth}.guard.ts
│   │   └── strategies/{jwt,local}.strategy.ts
│   │
│   ├── users/                       # CRUD de usuarios (solo ADMIN)
│   │   ├── users.{controller,service,module}.ts
│   │   ├── dto/{create,update}-user.dto.ts
│   │   └── entities/user.entity.ts  # email, passwordHash, role, isActive, refreshTokenHash
│   │
│   ├── patients/                    # Pacientes con ownership
│   │   ├── patients.{controller,service,module}.ts
│   │   ├── dto/{create,update}-patient.dto.ts
│   │   └── entities/patient.entity.ts
│   │
│   ├── doctors/                     # Médicos + asignación de especialidades (ADMIN)
│   │   ├── doctors.{controller,service,module}.ts
│   │   ├── dto/{create,update}-doctor.dto.ts
│   │   └── entities/doctor.entity.ts
│   │
│   ├── specialties/                 # Catálogo de especialidades
│   │   ├── specialties.{controller,service,module}.ts
│   │   ├── dto/{create,update}-specialty.dto.ts
│   │   └── entities/specialty.entity.ts
│   │
│   ├── appointments/                # Citas con double-booking prevention
│   │   ├── appointments.{controller,service,module}.ts
│   │   ├── dto/{create,update,update-status}-appointment.dto.ts
│   │   └── entities/appointment.entity.ts
│   │
│   ├── common/                      # Elementos transversales
│   │   ├── decorators/{current-user,public,roles}.decorator.ts
│   │   ├── filters/http-exception.filter.ts
│   │   ├── guards/roles.guard.ts
│   │   └── types/authenticated-user.interface.ts
│   │
│   ├── config/                      # Configuración tipada con namespaces
│   │   ├── app.config.ts            # 'app': port, nodeEnv
│   │   ├── database.config.ts       # 'database': host, port, user, pass, name, ssl
│   │   ├── jwt.config.ts            # 'jwt': secrets (valida ≥32 bytes), issuer, audience
│   │   ├── valkey.config.ts         # 'valkey': host, port, password
│   │   └── index.ts                 # Barrel export
│   │
│   ├── valkey/
│   │   └── valkey.module.ts         # @Global provee VALKEY_CLIENT (ioredis)
│   │
│   └── database/
│       └── migrations/
│           ├── 1776681637179-InitialSchema.ts
│           └── 1776700000000-AddRefreshTokenToUser.ts
│
├── doc/                             # Documentación de aprendizaje y referencia
│   ├── DOCUMENTACION.md             # ← este archivo
│   ├── migracion-microservicios.md
│   ├── bloque2-jwt-access-refresh.md
│   ├── docker-comandos.md
│   ├── helmet-proyecto.md
│   ├── idor.md
│   ├── jwt-analisis-completo.md
│   ├── refresh-token-rotation.md
│   ├── seguridad-jwt-casos-practicos.md
│   ├── valkey.md
│   └── …
│
├── test/                            # Tests e2e
├── ADR.md                           # Architecture Decision Records
├── ARCHITECTURE.md                  # Detalle arquitectónico
├── ERD.md                           # Diagrama entidad-relación
├── MODULES.md                       # Dependencias entre módulos (Mermaid)
├── SEQUENCES.md                     # Diagramas de secuencia
├── README.md                        # Quickstart
├── Dockerfile                       # Multi-stage (deps → builder → runner)
├── docker-compose.yml               # api + postgres + valkey
├── ormconfig.ts                     # DataSource para CLI de TypeORM
├── package.json
└── tsconfig*.json
```

---

## 4. Módulos de dominio

### 4.1. AppModule (raíz)

Configura las dependencias globales del sistema:

- **`ConfigModule`** (global) — carga `.env` y los 4 namespaces (`app`, `database`, `jwt`, `valkey`)
- **`TypeOrmModule.forRootAsync`** — conexión a PostgreSQL con `synchronize: false`
- **`ThrottlerModule`** — 60 rpm baseline
- **`CacheModule`** (global) — store en memoria
- **`ValkeyModule`** (@Global) — provee `VALKEY_CLIENT`
- **Guards globales (APP_GUARD)**:
  - `ThrottlerGuard` — rate limiting
  - `JwtAuthGuard` — autenticación obligatoria por defecto

### 4.2. AuthModule

Maneja todo el flujo de autenticación. Importa `UsersModule` para reusar `UsersService`.

**Endpoints públicos** (`@Public()`):
- `POST /auth/register` — crea usuario con rol forzado `PATIENT` (rate limit 5/10min)
- `POST /auth/login` — emite par de tokens (rate limit 5 rpm)
- `POST /auth/refresh` — rota refresh token (rate limit 10 rpm)

**Endpoints autenticados:**
- `POST /auth/logout` — añade access token a blocklist Valkey + limpia `refreshTokenHash`

**Estrategias Passport:**
- `JwtStrategy` — valida HS256 + issuer + audience; verifica `isActive`; consulta blocklist Valkey
- `LocalStrategy` — valida email/password con `argon2.verify`

### 4.3. UsersModule

CRUD completo de usuarios del sistema. **Todo el módulo requiere rol `ADMIN`** (excepto el `findByEmail` interno que usa `AuthService`).

- Hashing de password con Argon2id en `create`
- Soft delete vía `isActive = false`
- Exporta `UsersService` para uso de `AuthModule`, `PatientsModule`, `DoctorsModule`

### 4.4. PatientsModule

CRUD de pacientes con **ownership checks** (IDOR prevention).

- `create` — un paciente solo puede crear su propio perfil
- `findAll` — solo ADMIN
- `findOne` / `update` — el propio paciente, el médico asignado o ADMIN
- `remove` — solo ADMIN (soft delete)

### 4.5. DoctorsModule

CRUD de médicos + gestión de la relación ManyToMany con especialidades.

- `findAll` / `findOne` — cualquier usuario autenticado (directorio clínico)
- `create` / `update` / `remove` — solo ADMIN
- `addSpecialty` / `removeSpecialty` — solo ADMIN

### 4.6. SpecialtiesModule

Catálogo de especialidades médicas.

- Lectura libre para autenticados
- Mutaciones solo ADMIN
- `remove` falla si hay médicos asignados (integridad referencial)

### 4.7. AppointmentsModule

Gestión de citas con reglas de negocio:

- **Double-booking prevention** (mismo médico, misma fecha, horarios solapados)
- **Estados**: `scheduled → confirmed → completed | cancelled | no_show`
- **Ownership**: paciente ve solo sus citas, médico solo las suyas, ADMIN todas

---

## 5. Modelo de datos

### 5.1. Tablas PostgreSQL

| Tabla | Cardinalidad | Notas |
|-------|--------------|-------|
| `users` | ~Usuarios del sistema | UUID, email único, role enum, isActive, refreshTokenHash |
| `patients` | 1:1 con `users` | Datos demográficos |
| `doctors` | 1:1 con `users` | licenseNumber único |
| `specialties` | Catálogo | name único |
| `doctor_specialties` | Tabla intermedia ManyToMany | (doctor_id, specialty_id) |
| `appointments` | N:1 patients, N:1 doctors | enum status, date + start_time + end_time |
| `migrations` | Control de versionado de TypeORM | — |

### 5.2. Relaciones

```
users (1)─────(1) patients
users (1)─────(1) doctors
doctors (N)───(N) specialties      [doctor_specialties]
patients (1)──(N) appointments
doctors (1)───(N) appointments
```

### 5.3. Enums

```typescript
// user.entity.ts
enum UserRole { ADMIN, DOCTOR, PATIENT }

// patient.entity.ts
enum Gender { MALE, FEMALE, OTHER }

// appointment.entity.ts
enum AppointmentStatus { SCHEDULED, CONFIRMED, CANCELLED, COMPLETED, NO_SHOW }
```

### 5.4. Campos clave

| Tabla | Campo | Tipo | Detalle |
|-------|-------|------|---------|
| `users` | `id` | UUID v4 | PK; previene enumeración |
| `users` | `email` | varchar(255) | UNIQUE a nivel de BD |
| `users` | `password_hash` | varchar | Argon2id (nunca texto plano) |
| `users` | `refresh_token_hash` | varchar nullable | Argon2id; null tras logout/revocación |
| `users` | `is_active` | bool default true | Soft delete |
| `patients` | `user_id` | UUID FK | OneToOne con users |
| `doctors` | `license_number` | varchar(50) UNIQUE | Licencia profesional |
| `appointments` | `patient_id`, `doctor_id` | UUID FK | NOT NULL |
| `appointments` | `date` | date | Permite agrupar por día |
| `appointments` | `start_time`, `end_time` | time | Para detección de conflictos |
| `appointments` | `status` | enum | Default SCHEDULED |

Ver [ERD.md](../ERD.md) para el diagrama entidad-relación completo.

---

## 6. Autenticación y autorización

### 6.1. Flujo de tokens

**Access Token (JWT, vida corta 15min):**
- Algoritmo: HS256
- Claims: `sub`, `email`, `role`, `jti` (uuid único), `iss`, `aud`, `iat`, `exp`
- Viaja en header `Authorization: Bearer <token>`
- Se almacena en memoria del cliente (no en localStorage)

**Refresh Token (JWT, vida larga 7d):**
- Algoritmo: HS256 con **secreto diferente** al access token
- Claims mínimos: solo `sub`
- Viaja en **cookie HttpOnly + Secure + SameSite=Strict** con path `/api/v1/auth/refresh`
- Su hash Argon2id se guarda en `users.refresh_token_hash`
- **Rotación obligatoria**: cada refresh emite un par nuevo y reemplaza el hash

### 6.2. Reuse detection

Si llega un refresh token con firma válida pero:
- El usuario no tiene `refreshTokenHash` (logout previo) → **rechazar**
- El hash almacenado no matchea (token ya rotado) → **revocar familia completa** (`refreshTokenHash = null`) y forzar re-login en todos los dispositivos

### 6.3. Logout

1. Decodifica el access token y extrae `jti` + `exp`
2. Almacena `blocklist:at:<jti> = "1"` en Valkey con TTL = `exp - now`
3. Limpia `refresh_token_hash` del usuario
4. Limpia la cookie del refresh

### 6.4. RBAC

| Decorador | Aplicación |
|-----------|-----------|
| `@Public()` | Marca un endpoint como público (omite `JwtAuthGuard`) |
| `@Roles(...roles)` | Lista de roles autorizados; lo lee `RolesGuard` |
| `@CurrentUser()` | Inyecta `req.user` (tipo `AuthenticatedUser`) en el método |

**Capas de control:**

1. **`JwtAuthGuard`** (global) — verifica firma + `isActive` + blocklist
2. **`RolesGuard`** (por handler) — verifica `role` ∈ `@Roles(...)`
3. **`assertCanRead/Write`** (en servicio) — verifica ownership del recurso

Ver [SEQUENCES.md](../SEQUENCES.md) para los diagramas de flujo de login/refresh/logout.

---

## 7. Seguridad (OWASP Top 10 2025)

### 7.1. Controles implementados

| OWASP | Categoría | Mitigación en el código |
|-------|-----------|-------------------------|
| **A01** | Broken Access Control | `JwtAuthGuard` global; `RolesGuard`; ownership en servicios; UUID v4 en IDs; CORS restrictivo; cookie `SameSite=Strict` |
| **A02** | Cryptographic Failures | Argon2id (64MB, 3 iters, 4 hilos); refresh token hasheado en BD; secretos JWT separados access/refresh; HTTPS obligado en cookies (excepto dev) |
| **A03** | Injection | `ValidationPipe` global con `whitelist + forbidNonWhitelisted`; TypeORM con queries parametrizadas; `ParseUUIDPipe` en params |
| **A04** | Insecure Design | Rate limiting (login 5rpm, register 5/10min, refresh 10rpm); rol forzado a `PATIENT` en `/register`; cookie con path restringido |
| **A05** | Security Misconfiguration | `helmet()`; Swagger solo en dev con Basic Auth; `synchronize: false`; secretos validados al arrancar |
| **A07** | Auth Failures | JWT con `jti` + blocklist Valkey; rotación de refresh; reuse detection; logout invalida access + refresh |
| **A09** | Logging & Monitoring | `Logger` con contexto en cada servicio; logs de login fallido, refresh reuse, logout; `HttpExceptionFilter` registra 401/403 |

### 7.2. Endurecimiento del container

Ver [sección 10](#10-docker-y-despliegue) para detalles del Dockerfile/compose:

- Usuario `node` (uid 1000), nunca root
- Imagen final Alpine sin build tools (sin python/gcc)
- `read_only: true` en compose con tmpfs en `/tmp`
- `cap_drop: ALL` + `no-new-privileges:true`
- `dumb-init` como PID 1 (graceful shutdown)
- Healthchecks en api, postgres y valkey

### 7.3. Casos de seguridad documentados

Ver [memory/project_jwt_security_cases.md](../../.claude/projects/c--Users-Miguel-Desktop-BASE-API-NEST-DELUXE/memory/project_jwt_security_cases.md):

1. Expiración natural del access token
2. Rotación del refresh token
3. Logout con blocklist
4. Baja de usuario (`isActive = false`)
5. Blocklist en Valkey

---

## 8. API endpoints

**Prefijo global:** `/api/v1`

### Auth (`/api/v1/auth`)

| Método | Ruta | Auth | Rate limit | Rol |
|--------|------|------|------------|-----|
| `POST` | `/register` | Público | 5/10min | — |
| `POST` | `/login` | Público | 5/min | — |
| `POST` | `/refresh` | Cookie HttpOnly | 10/min | — |
| `POST` | `/logout` | Bearer | 60/min | Cualquiera autenticado |

### Users (`/api/v1/users`)

Todo el módulo: **solo ADMIN**.

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/` | Crear usuario |
| `GET` | `/` | Listar |
| `GET` | `/:id` | Obtener |
| `PATCH` | `/:id` | Actualizar |
| `DELETE` | `/:id` | Soft delete |

### Patients (`/api/v1/patients`)

| Método | Ruta | Rol / Ownership |
|--------|------|-----------------|
| `POST` | `/` | Cualquier autenticado (un paciente solo crea el suyo) |
| `GET` | `/` | ADMIN |
| `GET` | `/:id` | Ownership |
| `GET` | `/user/:userId` | Ownership |
| `PATCH` | `/:id` | Ownership |
| `DELETE` | `/:id` | ADMIN |

### Doctors (`/api/v1/doctors`)

| Método | Ruta | Rol |
|--------|------|-----|
| `POST` | `/` | ADMIN |
| `GET` | `/` | Autenticado |
| `GET` | `/specialty/:specialtyId` | Autenticado |
| `GET` | `/:id` | Autenticado |
| `PATCH` | `/:id` | ADMIN |
| `POST` | `/:id/specialties/:specialtyId` | ADMIN |
| `DELETE` | `/:id/specialties/:specialtyId` | ADMIN |
| `DELETE` | `/:id` | ADMIN |

### Specialties (`/api/v1/specialties`)

| Método | Ruta | Rol |
|--------|------|-----|
| `GET` | `/` | Autenticado |
| `GET` | `/:id` | Autenticado |
| `POST` | `/` | ADMIN |
| `PATCH` | `/:id` | ADMIN |
| `DELETE` | `/:id` | ADMIN |

### Appointments (`/api/v1/appointments`)

| Método | Ruta | Rol / Ownership |
|--------|------|-----------------|
| `POST` | `/` | Ownership (paciente/médico crean las suyas) |
| `GET` | `/` | ADMIN |
| `GET` | `/patient/:patientId` | Ownership |
| `GET` | `/doctor/:doctorId` | ADMIN o el propio médico |
| `GET` | `/date/:date` | ADMIN |
| `GET` | `/:id` | Ownership |
| `PATCH` | `/:id` | Ownership |
| `PATCH` | `/:id/status` | Ownership |
| `DELETE` | `/:id` | Ownership (soft cancel) |

---

## 9. Configuración y variables de entorno

Copiar `.env.example` a `.env`:

### Servidor

| Variable | Ejemplo | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP |
| `NODE_ENV` | `development` / `production` | Entorno |

### Base de datos PostgreSQL

| Variable | Ejemplo |
|----------|---------|
| `DB_HOST` | `127.0.0.1` (o `postgres` en compose) |
| `DB_PORT` | `5432` |
| `DB_USERNAME` | `clinic_user` |
| `DB_PASSWORD` | `s3cr3t` |
| `DB_NAME` | `clinic_db` |
| `DB_SSL` | `false` en dev / `true` en prod |

### JWT

| Variable | Requerimiento |
|----------|---------------|
| `JWT_SECRET` | **≥32 bytes** en producción (`openssl rand -base64 48`) |
| `JWT_EXPIRATION` | `15m` |
| `JWT_REFRESH_SECRET` | **≥32 bytes, distinto a JWT_SECRET** |
| `JWT_REFRESH_EXPIRATION` | `7d` |
| `JWT_ISSUER` | `clinic-api` |
| `JWT_AUDIENCE` | `clinic-web` |

> Secretos <32 bytes en producción → **abort de arranque** (fail-fast en [jwt.config.ts:24](../src/config/jwt.config.ts#L24))

### Valkey

| Variable | Ejemplo |
|----------|---------|
| `VALKEY_HOST` | `127.0.0.1` (o `valkey` en compose) |
| `VALKEY_PORT` | `6379` |
| `VALKEY_PASSWORD` | requerido en compose |

### CORS y Swagger

| Variable | Ejemplo |
|----------|---------|
| `ALLOWED_ORIGINS` | `http://localhost:4200` (coma-separado) |
| `SWAGGER_USER` | `admin` |
| `SWAGGER_PASSWORD` | `SuperSecretSwagger#2025` |

---

## 10. Docker y despliegue

### 10.1. Dockerfile — multi-stage build

Tres etapas para minimizar la imagen final y reducir superficie de ataque:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐
│  STAGE 1: deps  │───►│ STAGE 2: builder│───►│ STAGE 3: runner     │
│  (Alpine + gcc) │    │ (compila TS→JS) │    │ (final, sin gcc)    │
│  pnpm install   │    │ pnpm build      │    │ node + dumb-init    │
│  full deps      │    │ + prod install  │    │ usuario `node`      │
└─────────────────┘    └─────────────────┘    └─────────────────────┘
```

**Decisiones clave:**

| Aspecto | Implementación |
|---------|----------------|
| Base | `node:22.11.0-alpine3.20` (versión fija para builds reproducibles) |
| Gestor | `pnpm@9.15.0` vía corepack |
| Argon2 nativo | Compila con `python3, make, g++, libc6-compat` solo en stage `deps` |
| Cache | `--mount=type=cache,id=pnpm-store` (BuildKit) |
| Lockfile | `--frozen-lockfile` (falla si lock no coincide) |
| Usuario | `node` (uid 1000) — nunca root |
| PID 1 | `dumb-init` — reenvía SIGTERM y cosecha zombies |
| Healthcheck | `node -e require('http').get(...)` — sin curl/wget |
| Variables | `NODE_ENV=production`, `PORT=3000`, `HOME=/app` |

**Build:**

```powershell
$env:DOCKER_BUILDKIT=1
docker build -t clinic-api:latest .
```

### 10.2. docker-compose.yml

Tres servicios en una red interna `clinic-net`:

| Servicio | Imagen | Puerto host | Healthcheck |
|----------|--------|-------------|-------------|
| `api` | `clinic-api:latest` (build local) | `${PORT:-3000}:3000` | hereda del Dockerfile |
| `postgres` | `postgres:16-alpine` | **sin exponer al host** | `pg_isready` cada 10s |
| `valkey` | `valkey/valkey:8-alpine` | **sin exponer al host** | `valkey-cli ping` cada 10s |

**Endurecimiento del servicio `api`:**

```yaml
read_only: true              # filesystem inmutable
tmpfs: [/tmp]                # solo /tmp escribible (en RAM)
cap_drop: [ALL]              # sin capabilities Linux
security_opt:
  - no-new-privileges:true   # bloquea setuid
```

**Override de hosts:** `.env` tiene IPs físicas para dev local; compose las sobrescribe con DNS interno (`postgres`, `valkey`).

**Volúmenes persistentes:**

- `postgres-data` → `/var/lib/postgresql/data`
- `valkey-data` → `/data`

Sobreviven a `docker compose down`; solo se borran con `docker compose down -v`.

### 10.3. Comandos Docker

```bash
docker compose up -d                # Levantar todo en background
docker compose up -d --build        # Rebuild de imagen antes de levantar
docker compose logs -f api          # Tail de logs de la API
docker compose ps                   # Estado de los 3 servicios
docker compose down                 # Detener (conserva volúmenes)
docker compose down -v              # Detener + borrar volúmenes
docker compose exec api sh          # Shell dentro del container (limitado, read-only)
docker compose exec postgres psql -U $DB_USERNAME -d $DB_NAME
```

Ver [doc/docker-comandos.md](docker-comandos.md) para más detalles.

---

## 11. Base de datos y migraciones

### 11.1. Estrategia

- **`synchronize: false` siempre** (dev y prod)
- Cambios al esquema **solo vía migraciones versionadas**
- TypeORM CLI configurado en [ormconfig.ts](../ormconfig.ts)

### 11.2. Migraciones existentes

| Archivo | Contenido |
|---------|-----------|
| `1776681637179-InitialSchema.ts` | Crea todas las tablas (users, patients, doctors, specialties, doctor_specialties, appointments) con enums, FKs y constraints |
| `1776700000000-AddRefreshTokenToUser.ts` | Añade `refresh_token_hash` a `users` para rotación |

### 11.3. Comandos de migraciones

```bash
pnpm migration:generate    # Genera migración desde diff de entidades
pnpm migration:run         # Aplica migraciones pendientes
pnpm migration:revert      # Revierte la última
pnpm migration:show        # Lista estado de todas
```

**Importante:** las migraciones se compilan a `dist/` antes de ejecutarse (ver scripts en [package.json:21-24](../package.json#L21-L24)).

---

## 12. Comandos útiles

### Desarrollo

```bash
pnpm install                # Instalar dependencias
pnpm start:dev              # Modo watch (recarga automática)
pnpm start:debug            # Debug + watch
pnpm build                  # Compilar a dist/
pnpm start:prod             # Ejecutar bundle de producción
```

### Calidad de código

```bash
pnpm lint                   # ESLint con --fix
pnpm format                 # Prettier
pnpm test                   # Unit tests
pnpm test:watch             # Tests en watch
pnpm test:cov               # Tests + coverage
pnpm test:e2e               # Tests end-to-end
```

### Base de datos

```bash
pnpm migration:run          # Aplicar migraciones
pnpm migration:generate     # Generar nueva migración
pnpm migration:revert       # Revertir última
pnpm migration:show         # Ver estado
```

### Docker

```bash
docker compose up -d --build
docker compose logs -f api
docker compose down -v
```

---

## 13. Convenciones de código

### Naming

- **Archivos**: kebab-case (`auth.service.ts`, `create-user.dto.ts`)
- **Clases**: PascalCase (`AuthService`, `CreateUserDto`)
- **Métodos/variables**: camelCase
- **Constantes**: UPPER_SNAKE_CASE (`REFRESH_COOKIE`, `MIN_SECRET_LENGTH`)
- **Tablas DB**: snake_case (`refresh_token_hash`, `doctor_specialties`)

### TypeORM

- Entidades en `entities/` dentro de cada módulo
- `@PrimaryGeneratedColumn('uuid')` para todos los IDs
- `!` (non-null assertion) en propiedades que TypeORM inicializa
- Mapeo explícito a columnas snake_case con `name: 'foo_bar'`

### NestJS

- Un módulo por dominio (`auth/`, `users/`, etc.)
- DTOs con `class-validator` decorators
- Repositorios inyectados con `@InjectRepository(Entity)`
- Servicios exponen métodos asíncronos (`Promise<T>`)

### Comentarios en código

El código tiene **muchos comentarios didácticos** porque el proyecto es de aprendizaje. Patrones especiales:

- `// [SECURE-FIX]` — mitigación OWASP aplicada
- `//* [SECURE-FIX VN]` — versionado de los fixes de seguridad
- `//! [PROD]` — alertas críticas para despliegue a producción
- Bloques con `// ─────` — separadores de secciones importantes

### Git

- Commits en español (estilo del repo)
- Última secuencia de commits visible:
  - `e85f9bc` comandos
  - `84d863e` docker comandos
  - `3a0d348` imagen de dockerfile
  - `8a0b279` security: JWT hardening — jti, Valkey blocklist y secrets robustos
  - `38ff60e` first commit

---

## 14. Documentación adicional

| Archivo | Contenido |
|---------|-----------|
| [README.md](../README.md) | Quickstart y variables de entorno |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Arquitectura detallada, guards, pipes, filters |
| [MODULES.md](../MODULES.md) | Diagrama de módulos NestJS (Mermaid) |
| [ERD.md](../ERD.md) | Diagrama entidad-relación |
| [SEQUENCES.md](../SEQUENCES.md) | Diagramas de secuencia (login, refresh, logout) |
| [ADR.md](../ADR.md) | Architecture Decision Records |
| [doc/migracion-microservicios.md](migracion-microservicios.md) | Plan de descomposición a microservicios (4 servicios + 4 BDs) |
| [doc/jwt-analisis-completo.md](jwt-analisis-completo.md) | Análisis JWT en profundidad |
| [doc/seguridad-jwt-casos-practicos.md](seguridad-jwt-casos-practicos.md) | 5 casos críticos de seguridad |
| [doc/refresh-token-rotation.md](refresh-token-rotation.md) | Estrategia de rotación |
| [doc/revocacion-tokens.md](revocacion-tokens.md) | Logout y blocklist |
| [doc/idor.md](idor.md) | Prevención de IDOR |
| [doc/helmet.md](helmet.md) y [doc/helmet-proyecto.md](helmet-proyecto.md) | Headers HTTP |
| [doc/valkey.md](valkey.md) | Setup de Valkey |
| [doc/docker-comandos.md](docker-comandos.md) | Cheatsheet Docker |
| [doc/postman-guide.md](postman-guide.md) | Colección Postman |

---

## Anexo — Cómo trabajar con este proyecto desde Claude

Si eres una instancia de Claude leyendo esto por primera vez:

1. **Para entender el dominio**, lee la sección [4. Módulos de dominio](#4-módulos-de-dominio) y [5. Modelo de datos](#5-modelo-de-datos)
2. **Para implementar un endpoint nuevo**, sigue el patrón: controller → service → DTO + entity + (si toca esquema) migración
3. **Para añadir un campo a una entidad**:
   - Modifica la entidad TypeORM
   - Ejecuta `pnpm migration:generate`
   - Revisa la migración generada (TypeORM a veces incluye cambios no deseados)
   - Aplica con `pnpm migration:run`
4. **Para añadir un endpoint público**, usa `@Public()` — sin eso queda protegido por el `JwtAuthGuard` global
5. **Para añadir control de rol**, decora con `@UseGuards(RolesGuard) + @Roles(UserRole.X)` en el handler
6. **Para acceder al usuario actual**, usa `@CurrentUser() user: AuthenticatedUser` como parámetro
7. **Nunca commits con `--no-verify`** — los hooks existen por una razón
8. **Nunca cambies `synchronize: true`** — se perderían datos
9. **Si tocas la cookie del refresh**, mantén `httpOnly + secure + sameSite=Strict + path=/api/v1/auth/refresh`
10. **Antes de proponer microservicios**, lee [doc/migracion-microservicios.md](migracion-microservicios.md) — ya hay un plan
