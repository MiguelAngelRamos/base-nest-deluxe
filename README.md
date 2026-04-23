# Clinic API

API RESTful para gestión de clínica médica construida con NestJS 11, TypeORM y PostgreSQL. Cubre autenticación JWT con rotación de refresh tokens, control de acceso basado en roles (RBAC), gestión de pacientes, médicos, especialidades y citas médicas.

---

## Prerrequisitos

| Requisito | Versión mínima |
|-----------|----------------|
| Node.js | 22.x LTS |
| pnpm | 9.x |
| PostgreSQL | 15.x |

---

## Variables de entorno

Copia `.env.example` a `.env` y completa cada valor:

```bash
cp .env.example .env
```

### Servidor

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `PORT` | Puerto en el que escucha la aplicación | `3000` |
| `NODE_ENV` | Entorno de ejecución (`development` / `production`) | `development` |

### Base de datos PostgreSQL

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `DB_HOST` | Host del servidor PostgreSQL | `192.168.1.51` |
| `DB_PORT` | Puerto PostgreSQL | `5432` |
| `DB_USERNAME` | Usuario de la base de datos | `clinic_user` |
| `DB_PASSWORD` | Contraseña de la base de datos | `s3cr3t` |
| `DB_NAME` | Nombre de la base de datos | `clinic_db` |
| `DB_SSL` | Habilitar SSL en la conexión (`true` / `false`) | `false` |

### JWT

| Variable | Descripción | Requerimiento |
|----------|-------------|---------------|
| `JWT_SECRET` | Secreto para firmar access tokens (HS256) | Mínimo 32 bytes en producción |
| `JWT_EXPIRATION` | Tiempo de vida del access token | `15m` |
| `JWT_REFRESH_SECRET` | Secreto para firmar refresh tokens (HS256) | Mínimo 32 bytes, diferente de `JWT_SECRET` |
| `JWT_REFRESH_EXPIRATION` | Tiempo de vida del refresh token | `7d` |
| `JWT_ISSUER` | Claim `iss` del JWT | `clinic-api` |
| `JWT_AUDIENCE` | Claim `aud` del JWT | `clinic-web` |

### CORS

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `ALLOWED_ORIGINS` | Orígenes permitidos (separados por coma) | `http://localhost:4200` |

### Swagger (solo desarrollo)

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `SWAGGER_USER` | Usuario para autenticación básica de Swagger | `admin` |
| `SWAGGER_PASSWORD` | Contraseña para autenticación básica de Swagger | `SuperSecretSwagger#2025` |

> **Nota de seguridad:** En `NODE_ENV=production`, Swagger queda deshabilitado automáticamente. Los secretos JWT inferiores a 32 bytes provocan un error de inicio intencional (*fail-fast*).

---

## Instalación y configuración

### 1. Instalar dependencias

```bash
pnpm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
# Edita .env con los valores reales de tu entorno
```

### 3. Crear la base de datos en PostgreSQL

```sql
CREATE DATABASE clinic_db;
```

### 4. Ejecutar migraciones

```bash
pnpm migration:run
```

Esto creará las tablas: `users`, `patients`, `doctors`, `specialties`, `appointments` y `doctor_specialties`.

### 5. Iniciar en desarrollo

```bash
pnpm start:dev
```

La API estará disponible en `http://localhost:3000/api/v1`.  
La documentación Swagger en `http://localhost:3000/api/docs` (requiere usuario/contraseña definidos en `.env`).

---

## Scripts disponibles

| Script | Descripción |
|--------|-------------|
| `pnpm start` | Inicia el servidor compilado |
| `pnpm start:dev` | Modo watch con recarga automática |
| `pnpm start:debug` | Modo debug + watch |
| `pnpm start:prod` | Ejecuta el bundle de producción (`dist/main`) |
| `pnpm build` | Compila TypeScript a `dist/` |
| `pnpm lint` | Ejecuta ESLint con corrección automática |
| `pnpm format` | Ejecuta Prettier sobre `src/` y `test/` |
| `pnpm test` | Tests unitarios con Jest |
| `pnpm test:watch` | Tests en modo watch |
| `pnpm test:cov` | Tests con reporte de cobertura |
| `pnpm test:e2e` | Tests end-to-end |
| `pnpm migration:generate` | Genera migración a partir de cambios en entidades |
| `pnpm migration:run` | Aplica todas las migraciones pendientes |
| `pnpm migration:revert` | Revierte la última migración aplicada |
| `pnpm migration:show` | Lista el estado de todas las migraciones |

---

## Ejecución en desarrollo

```bash
pnpm start:dev
```

- Modo watch habilitado: cambios en `src/` recargan el servidor automáticamente.
- Swagger disponible con autenticación básica.
- TypeORM con `synchronize: false` (se usan migraciones, nunca auto-sync).
- Logs de TypeORM habilitados.

## Ejecución en producción

```bash
pnpm build
pnpm start:prod
```

**Checklist de producción:**

- `JWT_SECRET` y `JWT_REFRESH_SECRET` deben tener al menos 32 caracteres aleatorios.
- `DB_SSL=true` si tu PostgreSQL requiere conexión cifrada.
- `ALLOWED_ORIGINS` debe contener únicamente el dominio del frontend.
- Swagger se deshabilita automáticamente con `NODE_ENV=production`.
- El refresh token viaja en cookie `HttpOnly; SameSite=Strict; Secure` — requiere HTTPS.

---

## Prefijo global de rutas

Todas las rutas llevan el prefijo `/api/v1`:

```
POST   /api/v1/auth/login
GET    /api/v1/doctors
POST   /api/v1/appointments
```

---

## Endpoints públicos (sin autenticación)

| Método | Ruta | Rate limit |
|--------|------|------------|
| `GET` | `/` | — |
| `POST` | `/api/v1/auth/register` | 5 rpm |
| `POST` | `/api/v1/auth/login` | 5 rpm |
| `POST` | `/api/v1/auth/refresh` | 10 rpm |

El resto de endpoints requieren un `Authorization: Bearer <access_token>` válido.
