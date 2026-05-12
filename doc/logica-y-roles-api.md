# Lógica de la API y Permisos por Rol

> **Proyecto:** `clinic-api` — API RESTful para gestión de una clínica médica.
> **Stack:** NestJS 11 + TypeORM + PostgreSQL + Valkey/Redis (blocklist) + JWT (access + refresh).
> **Prefijo global:** `/api/v1` (ver `src/main.ts`).

---

## 1. ¿Qué hace esta API?

Es una API de **gestión de citas médicas (clinic-api)** que coordina tres actores reales del mundo de una clínica:

- **Pacientes** (rol `PATIENT`) que se autorregistran y agendan sus propias citas.
- **Médicos** (rol `DOCTOR`) que atienden, ven su agenda y gestionan los estados de las citas.
- **Administradores** (rol `ADMIN`) que mantienen el catálogo (especialidades, médicos), supervisan citas globalmente y gestionan usuarios.

Los recursos principales (`src/`) son:

| Recurso        | Entidad                                | Descripción                                                        |
| -------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `users`        | `User` (id, email, passwordHash, role) | Cuenta de autenticación. 1‑1 con Patient o Doctor según el rol.    |
| `patients`     | `Patient`                              | Ficha clínica/personal del paciente. Vinculada a un `User`.        |
| `doctors`      | `Doctor` (con `specialties` N‑M)       | Ficha profesional del médico, licencia, especialidades.            |
| `specialties`  | `Specialty`                            | Catálogo de especialidades (Cardiología, Pediatría…).              |
| `appointments` | `Appointment`                          | Cita: paciente + médico + fecha + hora + `status` (scheduled, …). |

### Ciclo de vida de una cita (`AppointmentStatus`)

`SCHEDULED` → `CONFIRMED` → `COMPLETED` / `NO_SHOW` / `CANCELLED`

`COMPLETED` y `NO_SHOW` son **estados finales** y no pueden volver a cambiar (`appointments.service.ts`). El `DELETE /appointments/:id` no borra físicamente: aplica **soft‑delete** moviendo la cita a `CANCELLED`.

---

## 2. Roles del sistema

Definidos en `src/users/entities/user.entity.ts`:

```ts
export enum UserRole {
  ADMIN = 'admin',
  DOCTOR = 'doctor',
  PATIENT = 'patient',
}
```

### ¿Hay un rol por defecto?

**Sí: `PATIENT`.**

- A nivel de tabla: la columna `role` tiene `default: UserRole.PATIENT`.
- A nivel de aplicación: el endpoint público `POST /auth/register` **fuerza** el rol a `PATIENT` en el servidor (`auth.service.ts → register`). El cliente **no puede** elegirse como `ADMIN` o `DOCTOR` desde el registro público — eso cierra la *privilege escalation* (OWASP A01/A04). Cualquier `role` enviado en el body es eliminado por el `ValidationPipe` global (`whitelist + forbidNonWhitelisted` en `main.ts`).
- Los roles `ADMIN` y `DOCTOR` se crean **solo** desde `POST /users` por un `ADMIN` ya existente (rol bootstrap manual / migración).

---

## 3. Cómo se aplican los permisos (capas)

El control de acceso vive en **dos capas complementarias** (defensa en profundidad):

1. **RBAC declarativo** — en el controlador con `@Roles(UserRole.X)` + `RolesGuard`. Define qué rol puede *invocar* el endpoint.
2. **Ownership en el servicio** — helpers como `assertCanAccess`, `assertCanRead`, `assertCanWrite` validan que el usuario sea **dueño** del recurso (paciente que consulta solo sus citas, médico que ve solo su agenda…). Esto cierra IDOR (OWASP A01).

Todo endpoint pasa primero por `JwtAuthGuard` (global). Los endpoints abiertos se marcan con `@Public()` (registro, login, refresh).

---

## 4. Matriz de permisos por endpoint

> Convención: ✅ permitido · ❌ denegado · 🔒 permitido **solo sobre recursos propios** (ownership).

### 4.1 Auth (`/api/v1/auth`)

| Método y ruta            | Público | PATIENT | DOCTOR | ADMIN | Notas |
| ------------------------ | :-----: | :-----: | :----: | :---: | ----- |
| `POST /auth/register`    |   ✅    |    —    |   —    |   —   | Rate‑limit 5/10min. Crea siempre como `PATIENT`. |
| `POST /auth/login`       |   ✅    |    —    |   —    |   —   | Rate‑limit 5/min. |
| `POST /auth/refresh`     |   ✅    |    —    |   —    |   —   | Usa cookie `refresh_token` HttpOnly (rotación + reuse detection). |
| `POST /auth/logout`      |   ❌    |    ✅    |   ✅   |   ✅   | Invalida refresh y mete el `jti` del access en la blocklist Valkey. |

### 4.2 Users (`/api/v1/users`) — `@Roles(ADMIN)` a nivel de clase

| Método y ruta         | PATIENT | DOCTOR | ADMIN | Notas |
| --------------------- | :-----: | :----: | :---: | ----- |
| `POST   /users`       |   ❌    |   ❌   |   ✅   | Crea usuarios con rol explícito (`DOCTOR`, `ADMIN`, `PATIENT`). |
| `GET    /users`       |   ❌    |   ❌   |   ✅   | Listar todos. |
| `GET    /users/:id`   |   ❌    |   ❌   |   ✅   | |
| `PATCH  /users/:id`   |   ❌    |   ❌   |   ✅   | |
| `DELETE /users/:id`   |   ❌    |   ❌   |   ✅   | Soft‑delete (`isActive=false`). |

### 4.3 Patients (`/api/v1/patients`)

| Método y ruta                   | PATIENT | DOCTOR | ADMIN | Notas |
| ------------------------------- | :-----: | :----: | :---: | ----- |
| `POST   /patients`              |   🔒   |   ❌   |   ✅   | El paciente solo crea **su propia** ficha (`userId == self`). |
| `GET    /patients`              |   ❌    |   ❌   |   ✅   | Listado completo (solo activos). |
| `GET    /patients/:id`          |   🔒   |   ✅   |   ✅   | Médico/Admin ven cualquier ficha; paciente solo la suya. |
| `GET    /patients/user/:userId` |   🔒   |   ✅   |   ✅   | Mismo criterio. |
| `PATCH  /patients/:id`          |   🔒   |   ❌   |   ✅   | El paciente solo edita la suya. El médico no edita pacientes. |
| `DELETE /patients/:id`          |   ❌    |   ❌   |   ✅   | Soft‑delete (desactiva el `User`). |

### 4.4 Doctors (`/api/v1/doctors`)

| Método y ruta                                   | PATIENT | DOCTOR | ADMIN | Notas |
| ----------------------------------------------- | :-----: | :----: | :---: | ----- |
| `POST   /doctors`                               |   ❌    |   ❌   |   ✅   | Solo Admin da de alta médicos. |
| `GET    /doctors`                               |   ✅    |   ✅   |   ✅   | Directorio clínico — lectura libre para autenticados. |
| `GET    /doctors/specialty/:specialtyId`        |   ✅    |   ✅   |   ✅   | Buscar médicos por especialidad. |
| `GET    /doctors/:id`                           |   ✅    |   ✅   |   ✅   | |
| `PATCH  /doctors/:id`                           |   ❌    |   ❌   |   ✅   | |
| `POST   /doctors/:id/specialties/:specialtyId`  |   ❌    |   ❌   |   ✅   | Asignar especialidad. |
| `DELETE /doctors/:id/specialties/:specialtyId`  |   ❌    |   ❌   |   ✅   | Desasignar especialidad. |
| `DELETE /doctors/:id`                           |   ❌    |   ❌   |   ✅   | Soft‑delete. |

### 4.5 Specialties (`/api/v1/specialties`)

| Método y ruta              | PATIENT | DOCTOR | ADMIN | Notas |
| -------------------------- | :-----: | :----: | :---: | ----- |
| `POST   /specialties`      |   ❌    |   ❌   |   ✅   | Catálogo maestro. |
| `GET    /specialties`      |   ✅    |   ✅   |   ✅   | Lectura libre para autenticados. |
| `GET    /specialties/:id`  |   ✅    |   ✅   |   ✅   | |
| `PATCH  /specialties/:id`  |   ❌    |   ❌   |   ✅   | |
| `DELETE /specialties/:id`  |   ❌    |   ❌   |   ✅   | |

### 4.6 Appointments (`/api/v1/appointments`)

| Método y ruta                              | PATIENT | DOCTOR | ADMIN | Notas |
| ------------------------------------------ | :-----: | :----: | :---: | ----- |
| `POST   /appointments`                     |   🔒   |   🔒  |   ✅   | El paciente solo agenda con su `patientId`; el médico solo donde es el `doctorId`. |
| `GET    /appointments`                     |   ❌    |   ❌   |   ✅   | Listado global. |
| `GET    /appointments/patient/:patientId`  |   🔒   |   🔒  |   ✅   | Paciente: solo las suyas. Médico: solo las que él atiende a ese paciente. |
| `GET    /appointments/doctor/:doctorId`    |   ❌    |   🔒  |   ✅   | Médico: solo su propia agenda. Paciente: bloqueado (revelaría datos de otros pacientes). |
| `GET    /appointments/date/:date`          |   ❌    |   ❌   |   ✅   | Listado por día — operación gerencial. |
| `GET    /appointments/:id`                 |   🔒   |   🔒  |   ✅   | Solo si es parte de la cita. |
| `PATCH  /appointments/:id/status`          |   🔒   |   🔒  |   ✅   | Cambia estado (no se puede salir de `COMPLETED`/`NO_SHOW`). |
| `PATCH  /appointments/:id`                 |   🔒   |   🔒  |   ✅   | Reagendar — revalida conflicto de horario para médico **y** paciente. |
| `DELETE /appointments/:id`                 |   🔒   |   🔒  |   ✅   | Soft‑delete → `status = CANCELLED`. No se puede cancelar una `COMPLETED`. |

---

## 5. Resumen ejecutivo por rol

### 👤 PATIENT (rol por defecto)

**Puede:**
- Registrarse en `/auth/register` (queda automáticamente como `PATIENT`).
- Iniciar sesión, refrescar token y cerrar sesión.
- Crear, leer y editar **su propia** ficha de paciente.
- Consultar el directorio de médicos y el catálogo de especialidades.
- Agendar citas **para sí mismo**, ver sus citas, reagendarlas, cambiar el estado y cancelarlas (soft‑delete).

**No puede:**
- Crear/modificar otros usuarios, médicos, especialidades o pacientes.
- Ver la agenda completa de un médico ni citas de otros pacientes.
- Ver listados globales (todas las citas, todos los pacientes).
- Desactivar pacientes (ni siquiera el suyo) — eso queda en manos del admin.

### 👨‍⚕️ DOCTOR

**Puede:**
- Iniciar sesión, refrescar token, cerrar sesión.
- Leer cualquier ficha de paciente (necesario para atender) y todo el directorio/catálogo.
- Ver **su propia agenda** (`/appointments/doctor/:doctorId` con el suyo).
- Ver y administrar las citas en las que participa: cambiar estado (confirmar, completar, no_show), reagendar, cancelar.
- Crear citas en las que él sea el médico.

**No puede:**
- Crear ni editar pacientes (no es su responsabilidad — flujo administrativo).
- Crear o editar usuarios, médicos, especialidades.
- Ver la agenda de otros médicos ni listados globales de citas.

### 🛠️ ADMIN

**Puede todo:** CRUD completo sobre `users`, `patients`, `doctors`, `specialties` y `appointments`. Es el único que crea cuentas de `DOCTOR` y de otros `ADMIN`, gestiona el catálogo de especialidades, asigna especialidades a médicos, ve listados globales, citas por fecha, y aplica soft‑deletes.

**No puede:**
- Saltarse las invariantes de negocio (no puede cambiar el `userId` de un paciente/médico ya creado, ni reactivar una cita `COMPLETED`).

---

## 6. Resumen visual de quién toca qué

```
                           PATIENT      DOCTOR        ADMIN
                           ───────      ──────        ─────
auth/register              ✅ (público — rol forzado a PATIENT)
auth/login/refresh/logout  ✅            ✅           ✅
users (CRUD)               ❌            ❌           ✅
specialties (read)         ✅            ✅           ✅
specialties (write)        ❌            ❌           ✅
doctors (read)             ✅            ✅           ✅
doctors (write)            ❌            ❌           ✅
patients (own)             ✅            —            ✅ (todos)
patients (otros)           ❌            ✅ read      ✅
patients (delete)          ❌            ❌           ✅
appointments (propias)     ✅            ✅           ✅ (todas)
appointments (globales)    ❌            ❌           ✅
```

---

## 7. Notas de seguridad relevantes (contexto del branch `security/jwt-hardening`)

- Autenticación con **JWT access (15min) + refresh (7d)** con secretos separados, `iss`/`aud` pineados, algoritmo `HS256` forzado.
- **Rotación de refresh** + **reuse detection** (si llega un refresh ya rotado, se revoca toda la familia).
- **Blocklist en Valkey** del `jti` del access token al hacer logout (cierra la ventana de 15min).
- Cookie `refresh_token` con `httpOnly + secure + sameSite=strict + path=/api/v1/auth/refresh`.
- Rate‑limit en `/auth/register`, `/auth/login` y `/auth/refresh`.
- Soft‑delete consistente en todos los recursos (`user.isActive = false`); las queries hacen `inner join` filtrando activos para no exponer "eliminados".
- Validación global con `whitelist + forbidNonWhitelisted` para impedir payloads con campos no declarados (p. ej. `role` en register).
