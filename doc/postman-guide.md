# Guía Postman — Clinic API

> **Base URL:** `http://localhost:3000/api/v1`  
> **Swagger (solo dev):** `http://localhost:3000/api/docs` (credenciales en `.env`: `SWAGGER_USER` / `SWAGGER_PASSWORD`)

---

## Tabla de Contenidos

1. [Configuración del Entorno en Postman](#1-configuracion-del-entorno-en-postman)
2. [Sistema de Autenticación](#2-sistema-de-autenticacion)
3. [Auth — Registro, Login, Refresh, Logout](#3-auth)
4. [Users — Gestión de Usuarios (Admin)](#4-users)
5. [Specialties — Especialidades](#5-specialties)
6. [Doctors — Médicos](#6-doctors)
7. [Patients — Pacientes](#7-patients)
8. [Appointments — Citas](#8-appointments)
9. [Flujos Completos de Prueba](#9-flujos-completos-de-prueba)
10. [Errores Comunes y Soluciones](#10-errores-comunes-y-soluciones)

---

## 1. Configuración del Entorno en Postman

### Variables de Entorno

Crea un entorno en Postman llamado **`Clinic API - Local`** con estas variables:

| Variable | Valor inicial | Descripción |
|---|---|---|
| `baseUrl` | `http://localhost:3000/api/v1` | URL base de la API |
| `accessToken` | *(vacío)* | Se rellena automáticamente al hacer login |
| `refreshToken` | *(vacío)* | Token de refresco (solo referencia, va en cookie) |
| `adminUserId` | *(vacío)* | ID del usuario admin después de crearlo |
| `patientUserId` | *(vacío)* | ID de usuario con rol patient |
| `doctorUserId` | *(vacío)* | ID de usuario con rol doctor |
| `patientId` | *(vacío)* | ID del perfil de paciente |
| `doctorId` | *(vacío)* | ID del perfil de médico |
| `specialtyId` | *(vacío)* | ID de una especialidad |
| `appointmentId` | *(vacío)* | ID de una cita |

### Script de Post-Request para guardar el token automáticamente

En las peticiones de **login**, **register** y **refresh**, pega esto en la pestaña **Tests**:

```javascript
if (pm.response.code === 200 || pm.response.code === 201) {
    const json = pm.response.json();
    if (json.accessToken) {
        pm.environment.set("accessToken", json.accessToken);
        console.log("✅ accessToken guardado");
    }
    if (json.user && json.user.id) {
        pm.environment.set("lastUserId", json.user.id);
    }
}
```

### Configuración de Autorización Global (Collection)

En tu colección de Postman → pestaña **Authorization**:
- Type: `Bearer Token`
- Token: `{{accessToken}}`

Todos los requests heredarán este header automáticamente. Solo las peticiones públicas (register, login, refresh) no lo necesitan.

---

## 2. Sistema de Autenticación

### Cómo funciona

La API usa **doble token JWT**:

| Token | Ubicación | Duración | Propósito |
|---|---|---|---|
| **Access Token** | `Authorization: Bearer <token>` (header) | 15 minutos | Autorizar cada request |
| **Refresh Token** | Cookie `HttpOnly` automática | 7 días | Renovar el access token |

**Flujo típico:**
1. `POST /auth/register` o `POST /auth/login` → recibes `accessToken` en body + cookie `refresh_token` automática
2. Usas `accessToken` en el header `Authorization: Bearer` para todas las peticiones protegidas
3. Cuando el access token expira (15 min), llamas `POST /auth/refresh` → recibes un nuevo par de tokens
4. Al terminar, `POST /auth/logout` invalida ambos tokens

> **Importante en Postman:** Para que las cookies funcionen (refresh token), activa **"Automatically follow redirects"** y asegúrate de que la Cookie Jar de Postman esté habilitada (lo está por defecto).

---

## 3. Auth

### 3.1 Registro de Usuario

```
POST {{baseUrl}}/auth/register
```

**Headers:**
```
Content-Type: application/json
```

**Body (JSON):**
```json
{
  "email": "paciente@ejemplo.com",
  "password": "MiPassword1@"
}
```

**Reglas de contraseña:** mínimo 8 caracteres, debe incluir:
- Al menos una mayúscula (A-Z)
- Al menos una minúscula (a-z)
- Al menos un número (0-9)
- Al menos un carácter especial: `@$!%*?&`

**Respuesta exitosa `201`:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "paciente@ejemplo.com",
    "role": "patient"
  }
}
```

> El registro **siempre crea un usuario con rol `patient`**. Para crear admins o doctores usa `POST /users` (requiere ser admin).

**Rate limit:** 5 peticiones cada 10 minutos por IP.

---

### 3.2 Login

```
POST {{baseUrl}}/auth/login
```

**Headers:**
```
Content-Type: application/json
```

**Body (JSON):**
```json
{
  "email": "paciente@ejemplo.com",
  "password": "MiPassword1@"
}
```

**Respuesta exitosa `200`:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "paciente@ejemplo.com",
    "role": "patient"
  }
}
```

Además se establece automáticamente una **cookie HttpOnly** `refresh_token`.

**Rate limit:** 5 peticiones por minuto por IP.

---

### 3.3 Renovar Token (Refresh)

```
POST {{baseUrl}}/auth/refresh
```

**No requiere body ni Authorization header.**  
La cookie `refresh_token` se envía automáticamente.

**Respuesta exitosa `200`:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...(nuevo token)...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "paciente@ejemplo.com",
    "role": "patient"
  }
}
```

> Cada llamada a `/refresh` **invalida el refresh token anterior** y emite uno nuevo (rotación de tokens). Si intentas usar el refresh token anterior recibirás `401`.

**Rate limit:** 10 peticiones por minuto por IP.

---

### 3.4 Logout

```
POST {{baseUrl}}/auth/logout
```

**Headers:**
```
Authorization: Bearer {{accessToken}}
```

**No requiere body.**

**Respuesta exitosa `204 No Content`** (sin body).

Esto invalida el access token actual añadiéndolo a la blocklist en Valkey, y borra el refresh token de la base de datos.

---

## 4. Users

> **Requiere rol:** `admin`  
> **Header obligatorio:** `Authorization: Bearer {{accessToken}}`

### 4.1 Crear Usuario

```
POST {{baseUrl}}/users
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON):**
```json
{
  "email": "doctor@clinica.com",
  "password": "DoctorPass1@",
  "role": "doctor"
}
```

**Valores válidos para `role`:** `admin` | `doctor` | `patient`

**Respuesta exitosa `201`:**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "email": "doctor@clinica.com",
  "role": "doctor",
  "isActive": true,
  "createdAt": "2026-04-27T10:00:00.000Z",
  "updatedAt": "2026-04-27T10:00:00.000Z"
}
```

> La contraseña **no** se devuelve en la respuesta.

---

### 4.2 Listar Todos los Usuarios

```
GET {{baseUrl}}/users
```

**Headers:**
```
Authorization: Bearer {{accessToken}}
```

**Respuesta exitosa `200`:**
```json
[
  {
    "id": "a1b2c3d4-...",
    "email": "admin@clinica.com",
    "role": "admin",
    "isActive": true,
    "createdAt": "2026-04-27T10:00:00.000Z",
    "updatedAt": "2026-04-27T10:00:00.000Z"
  },
  {
    "id": "b2c3d4e5-...",
    "email": "doctor@clinica.com",
    "role": "doctor",
    "isActive": true,
    "createdAt": "2026-04-27T10:01:00.000Z",
    "updatedAt": "2026-04-27T10:01:00.000Z"
  }
]
```

---

### 4.3 Obtener Usuario por ID

```
GET {{baseUrl}}/users/:id
```

**Ejemplo:**
```
GET {{baseUrl}}/users/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Headers:**
```
Authorization: Bearer {{accessToken}}
```

**Respuesta exitosa `200`:** objeto usuario individual.

---

### 4.4 Actualizar Usuario

```
PATCH {{baseUrl}}/users/:id
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON) — todos los campos son opcionales:**
```json
{
  "email": "nuevoemail@clinica.com",
  "role": "admin"
}
```

**Respuesta exitosa `200`:** objeto usuario actualizado.

---

### 4.5 Eliminar Usuario (Soft Delete)

```
DELETE {{baseUrl}}/users/:id
```

**Headers:**
```
Authorization: Bearer {{accessToken}}
```

**Respuesta exitosa `204 No Content`** (sin body).

> El usuario no se borra físicamente de la BD, solo se marca `isActive: false`.

---

## 5. Specialties

### 5.1 Crear Especialidad

> **Requiere rol:** `admin`

```
POST {{baseUrl}}/specialties
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON):**
```json
{
  "name": "Cardiología",
  "description": "Especialidad médica dedicada al diagnóstico y tratamiento de enfermedades del corazón"
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `name` | string | Sí | 2–100 caracteres, único |
| `description` | string | No | máx. 255 caracteres |

**Respuesta exitosa `201`:**
```json
{
  "id": "c3d4e5f6-a1b2-3456-cdef-789012345678",
  "name": "Cardiología",
  "description": "Especialidad médica dedicada al diagnóstico y tratamiento de enfermedades del corazón",
  "createdAt": "2026-04-27T10:05:00.000Z",
  "updatedAt": "2026-04-27T10:05:00.000Z"
}
```

---

### 5.2 Listar Especialidades

> **Requiere:** cualquier usuario autenticado

```
GET {{baseUrl}}/specialties
```

**Headers:**
```
Authorization: Bearer {{accessToken}}
```

**Respuesta exitosa `200`:** array de especialidades.

---

### 5.3 Obtener Especialidad por ID

```
GET {{baseUrl}}/specialties/:id
```

**Headers:**
```
Authorization: Bearer {{accessToken}}
```

---

### 5.4 Actualizar Especialidad

> **Requiere rol:** `admin`

```
PATCH {{baseUrl}}/specialties/:id
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON) — todos opcionales:**
```json
{
  "name": "Cardiología Pediátrica",
  "description": "Descripción actualizada"
}
```

---

### 5.5 Eliminar Especialidad

> **Requiere rol:** `admin`

```
DELETE {{baseUrl}}/specialties/:id
```

**Respuesta exitosa `204 No Content`.**

---

## 6. Doctors

### 6.1 Crear Médico

> **Requiere rol:** `admin`  
> **Prerequisito:** El `userId` debe corresponder a un usuario con rol `doctor` creado previamente en `/users`.

```
POST {{baseUrl}}/doctors
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON):**
```json
{
  "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "firstName": "Carlos",
  "lastName": "González",
  "licenseNumber": "MD-12345",
  "phone": "+56912345678"
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `userId` | UUID | Sí | Debe existir en la tabla users |
| `firstName` | string | Sí | 2–100 caracteres |
| `lastName` | string | Sí | 2–100 caracteres |
| `licenseNumber` | string | Sí | 5–50 caracteres, único |
| `phone` | string | No | Formato chileno: `+56XXXXXXXXX` o `56XXXXXXXXX` |

**Respuesta exitosa `201`:**
```json
{
  "id": "d4e5f6a1-b2c3-4567-def0-123456789012",
  "userId": "a1b2c3d4-...",
  "firstName": "Carlos",
  "lastName": "González",
  "licenseNumber": "MD-12345",
  "phone": "+56912345678",
  "specialties": [],
  "createdAt": "2026-04-27T10:10:00.000Z",
  "updatedAt": "2026-04-27T10:10:00.000Z"
}
```

---

### 6.2 Listar Médicos

> **Requiere:** cualquier usuario autenticado

```
GET {{baseUrl}}/doctors
```

---

### 6.3 Obtener Médico por ID

```
GET {{baseUrl}}/doctors/:id
```

---

### 6.4 Obtener Médicos por Especialidad

```
GET {{baseUrl}}/doctors/specialty/:specialtyId
```

**Ejemplo:**
```
GET {{baseUrl}}/doctors/specialty/c3d4e5f6-a1b2-3456-cdef-789012345678
```

Devuelve todos los médicos que tienen asignada esa especialidad.

---

### 6.5 Actualizar Médico

> **Requiere rol:** `admin`

```
PATCH {{baseUrl}}/doctors/:id
```

**Body (JSON) — todos opcionales:**
```json
{
  "firstName": "Carlos Andrés",
  "phone": "+56987654321"
}
```

---

### 6.6 Asignar Especialidad a Médico

> **Requiere rol:** `admin`

```
POST {{baseUrl}}/doctors/:doctorId/specialties/:specialtyId
```

**Ejemplo:**
```
POST {{baseUrl}}/doctors/d4e5f6a1-b2c3-4567-def0-123456789012/specialties/c3d4e5f6-a1b2-3456-cdef-789012345678
```

**No requiere body.**

**Respuesta exitosa `200`:** objeto doctor actualizado con el array `specialties` incluyendo la nueva.

---

### 6.7 Quitar Especialidad de Médico

> **Requiere rol:** `admin`

```
DELETE {{baseUrl}}/doctors/:doctorId/specialties/:specialtyId
```

**Respuesta exitosa `200`:** objeto doctor actualizado.

---

### 6.8 Eliminar Médico

> **Requiere rol:** `admin`

```
DELETE {{baseUrl}}/doctors/:id
```

**Respuesta exitosa `204 No Content`.**

---

## 7. Patients

### 7.1 Crear Perfil de Paciente

> **Requiere:** cualquier usuario autenticado  
> **Prerequisito:** `userId` debe ser el ID del usuario autenticado (o de cualquier usuario si eres admin).

```
POST {{baseUrl}}/patients
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON):**
```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "firstName": "Ana",
  "lastName": "Martínez",
  "birthDate": "1990-05-15",
  "gender": "female",
  "phone": "+56998765432",
  "address": "Av. Principal 123, Santiago"
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `userId` | UUID | Sí | Debe existir en la tabla users |
| `firstName` | string | Sí | 2–100 caracteres |
| `lastName` | string | Sí | 2–100 caracteres |
| `birthDate` | string | No | Formato ISO: `YYYY-MM-DD` |
| `gender` | string | No | `male` \| `female` \| `other` |
| `phone` | string | No | Formato chileno: `+56XXXXXXXXX` |
| `address` | string | No | máx. 255 caracteres |

**Respuesta exitosa `201`:**
```json
{
  "id": "e5f6a1b2-c3d4-5678-ef01-234567890123",
  "userId": "550e8400-...",
  "firstName": "Ana",
  "lastName": "Martínez",
  "birthDate": "1990-05-15",
  "gender": "female",
  "phone": "+56998765432",
  "address": "Av. Principal 123, Santiago",
  "createdAt": "2026-04-27T10:15:00.000Z",
  "updatedAt": "2026-04-27T10:15:00.000Z"
}
```

---

### 7.2 Listar Todos los Pacientes

> **Requiere rol:** `admin`

```
GET {{baseUrl}}/patients
```

---

### 7.3 Obtener Paciente por ID

> **Requiere:** ser el dueño del perfil o admin

```
GET {{baseUrl}}/patients/:id
```

---

### 7.4 Obtener Paciente por User ID

> **Requiere:** ser el mismo usuario o admin

```
GET {{baseUrl}}/patients/user/:userId
```

**Ejemplo:**
```
GET {{baseUrl}}/patients/user/550e8400-e29b-41d4-a716-446655440000
```

Útil para obtener el perfil de paciente desde el ID de usuario (por ejemplo, justo después del login).

---

### 7.5 Actualizar Paciente

> **Requiere:** ser el dueño del perfil o admin

```
PATCH {{baseUrl}}/patients/:id
```

**Body (JSON) — todos opcionales:**
```json
{
  "phone": "+56911223344",
  "address": "Calle Nueva 456, Providencia"
}
```

---

### 7.6 Eliminar Paciente (Soft Delete)

> **Requiere rol:** `admin`

```
DELETE {{baseUrl}}/patients/:id
```

**Respuesta exitosa `204 No Content`.**

---

## 8. Appointments

### 8.1 Crear Cita

> **Requiere:** cualquier usuario autenticado (el servicio verifica que el patientId corresponda al usuario actual o que sea admin)

```
POST {{baseUrl}}/appointments
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON):**
```json
{
  "patientId": "e5f6a1b2-c3d4-5678-ef01-234567890123",
  "doctorId": "d4e5f6a1-b2c3-4567-def0-123456789012",
  "date": "2026-05-10",
  "startTime": "09:00",
  "endTime": "09:30",
  "status": "scheduled",
  "notes": "Consulta de revisión anual"
}
```

| Campo | Tipo | Requerido | Reglas |
|---|---|---|---|
| `patientId` | UUID | Sí | Debe existir en la tabla patients |
| `doctorId` | UUID | Sí | Debe existir en la tabla doctors |
| `date` | string | Sí | Formato `YYYY-MM-DD` |
| `startTime` | string | Sí | Formato `HH:MM` (24h), ej: `09:00`, `14:30` |
| `endTime` | string | Sí | Formato `HH:MM` (24h), ej: `09:30`, `15:00` |
| `status` | string | No | `scheduled` (default) \| `confirmed` \| `cancelled` \| `completed` \| `no_show` |
| `notes` | string | No | máx. 2000 caracteres |

**Respuesta exitosa `201`:**
```json
{
  "id": "f6a1b2c3-d4e5-6789-f012-345678901234",
  "patientId": "e5f6a1b2-...",
  "doctorId": "d4e5f6a1-...",
  "date": "2026-05-10",
  "startTime": "09:00:00",
  "endTime": "09:30:00",
  "status": "scheduled",
  "notes": "Consulta de revisión anual",
  "createdAt": "2026-04-27T10:20:00.000Z",
  "updatedAt": "2026-04-27T10:20:00.000Z"
}
```

---

### 8.2 Listar Todas las Citas

> **Requiere rol:** `admin`

```
GET {{baseUrl}}/appointments
```

---

### 8.3 Obtener Cita por ID

> **Requiere:** ser paciente o médico de la cita, o admin

```
GET {{baseUrl}}/appointments/:id
```

---

### 8.4 Obtener Citas de un Paciente

> **Requiere:** ser el mismo paciente (verificado por userId) o admin

```
GET {{baseUrl}}/appointments/patient/:patientId
```

**Ejemplo:**
```
GET {{baseUrl}}/appointments/patient/e5f6a1b2-c3d4-5678-ef01-234567890123
```

---

### 8.5 Obtener Citas de un Médico

> **Requiere:** ser el mismo médico o admin

```
GET {{baseUrl}}/appointments/doctor/:doctorId
```

**Ejemplo:**
```
GET {{baseUrl}}/appointments/doctor/d4e5f6a1-b2c3-4567-def0-123456789012
```

---

### 8.6 Obtener Citas por Fecha

> **Requiere rol:** `admin`

```
GET {{baseUrl}}/appointments/date/:date
```

**Ejemplo:**
```
GET {{baseUrl}}/appointments/date/2026-05-10
```

La fecha debe estar en formato `YYYY-MM-DD`.

---

### 8.7 Actualizar Estado de una Cita

> **Requiere:** ser parte de la cita (paciente o médico) o admin

```
PATCH {{baseUrl}}/appointments/:id/status
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {{accessToken}}
```

**Body (JSON):**
```json
{
  "status": "confirmed"
}
```

**Valores válidos para `status`:**
| Valor | Descripción |
|---|---|
| `scheduled` | Cita programada (estado inicial) |
| `confirmed` | Cita confirmada |
| `cancelled` | Cita cancelada |
| `completed` | Cita completada |
| `no_show` | El paciente no se presentó |

**Respuesta exitosa `200`:** objeto de cita actualizado.

---

### 8.8 Actualizar Detalles de una Cita

> **Requiere:** ser parte de la cita o admin

```
PATCH {{baseUrl}}/appointments/:id
```

**Body (JSON) — todos opcionales:**
```json
{
  "date": "2026-05-15",
  "startTime": "10:00",
  "endTime": "10:30",
  "notes": "Notas clínicas actualizadas"
}
```

---

### 8.9 Cancelar / Eliminar Cita (Soft Delete)

> **Requiere:** ser parte de la cita o admin

```
DELETE {{baseUrl}}/appointments/:id
```

**Respuesta exitosa `204 No Content`.**

---

## 9. Flujos Completos de Prueba

### Flujo 1: Primer Setup del Sistema (como Admin)

> Ejecuta en orden, guardando los IDs en variables de entorno.

**Paso 1 — Registrar el primer usuario (será patient):**
```
POST /auth/register
{ "email": "admin@clinica.com", "password": "AdminPass1@" }
```
> Guarda el `accessToken` en `{{accessToken}}`. El rol es `patient` por defecto — debes cambiar manualmente en la BD o usar un seed script.

**Paso 2 — Crear usuario admin (desde un admin existente):**
```
POST /users
{ "email": "admin2@clinica.com", "password": "AdminPass2@", "role": "admin" }
```

**Paso 3 — Crear usuario doctor:**
```
POST /users
{ "email": "doctor@clinica.com", "password": "DoctorPass1@", "role": "doctor" }
```
Guarda el `id` del doctor en `{{doctorUserId}}`.

**Paso 4 — Crear usuario paciente:**
```
POST /users
{ "email": "paciente@clinica.com", "password": "PacientePass1@", "role": "patient" }
```
Guarda el `id` en `{{patientUserId}}`.

**Paso 5 — Crear especialidad:**
```
POST /specialties
{ "name": "Cardiología", "description": "Enfermedades del corazón" }
```
Guarda el `id` en `{{specialtyId}}`.

**Paso 6 — Crear perfil de médico:**
```
POST /doctors
{ "userId": "{{doctorUserId}}", "firstName": "Carlos", "lastName": "González", "licenseNumber": "MD-001" }
```
Guarda el `id` en `{{doctorId}}`.

**Paso 7 — Asignar especialidad al médico:**
```
POST /doctors/{{doctorId}}/specialties/{{specialtyId}}
```

---

### Flujo 2: Ciclo de Vida de una Cita (como Paciente)

**Paso 1 — Login como paciente:**
```
POST /auth/login
{ "email": "paciente@clinica.com", "password": "PacientePass1@" }
```
→ `{{accessToken}}` se actualiza automáticamente con el script de Tests.

**Paso 2 — Crear perfil de paciente:**
```
POST /patients
{ "userId": "{{patientUserId}}", "firstName": "Ana", "lastName": "Pérez", "birthDate": "1985-03-20" }
```
Guarda el `id` en `{{patientId}}`.

**Paso 3 — Ver médicos disponibles:**
```
GET /doctors
GET /doctors/specialty/{{specialtyId}}
```

**Paso 4 — Crear cita:**
```
POST /appointments
{
  "patientId": "{{patientId}}",
  "doctorId": "{{doctorId}}",
  "date": "2026-05-10",
  "startTime": "09:00",
  "endTime": "09:30"
}
```
Guarda el `id` en `{{appointmentId}}`.

**Paso 5 — Verificar mis citas:**
```
GET /appointments/patient/{{patientId}}
```

**Paso 6 — Cancelar la cita:**
```
PATCH /appointments/{{appointmentId}}/status
{ "status": "cancelled" }
```

---

### Flujo 3: Renovación de Token

**Paso 1 — El access token ha expirado (15 min). Llamar refresh:**
```
POST /auth/refresh
(sin body, la cookie se envía automáticamente)
```
→ Nuevo `accessToken` en la respuesta. Guárdalo con el script de Tests.

**Paso 2 — Continuar con el nuevo token normalmente.**

---

## 10. Errores Comunes y Soluciones

### `400 Bad Request`
```json
{
  "statusCode": 400,
  "message": ["password must match /^(?=.*[a-z]).../ regular expression"],
  "error": "Bad Request"
}
```
**Causa:** La contraseña no cumple los requisitos (mayúscula, minúscula, número, carácter especial, mínimo 8 chars).  
**Solución:** Usa una contraseña como `MiPassword1@`.

---

### `400 Bad Request` — Propiedades extra
```json
{
  "statusCode": 400,
  "message": ["property extraField should not exist"],
  "error": "Bad Request"
}
```
**Causa:** Enviaste un campo que no existe en el DTO. La API tiene `forbidNonWhitelisted: true`.  
**Solución:** Elimina los campos extra del body.

---

### `401 Unauthorized`
```json
{
  "statusCode": 401,
  "message": "Unauthorized",
  "error": "Unauthorized"
}
```
**Causas posibles:**
- No enviaste el header `Authorization: Bearer <token>`.
- El access token expiró (duración: 15 minutos). Usa `/auth/refresh`.
- Hiciste logout y el token fue invalidado (en blocklist de Valkey).

---

### `403 Forbidden`
```json
{
  "statusCode": 403,
  "message": "Forbidden resource",
  "error": "Forbidden"
}
```
**Causa:** Tu usuario no tiene el rol requerido (ej: intentar `POST /users` sin ser admin) o intentas acceder al recurso de otro usuario.  
**Solución:** Haz login con un usuario que tenga el rol correcto.

---

### `404 Not Found`
```json
{
  "statusCode": 404,
  "message": "Patient with id xxx not found",
  "error": "Not Found"
}
```
**Causa:** El recurso no existe o fue eliminado (soft delete).

---

### `409 Conflict`
```json
{
  "statusCode": 409,
  "message": "User with email xxx already exists",
  "error": "Conflict"
}
```
**Causa:** Email o `licenseNumber` duplicado.

---

### `429 Too Many Requests`
```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests",
  "error": "Too Many Requests"
}
```
**Causa:** Superaste el rate limit (5 login/min, 5 register/10min, 60 req/min global).  
**Solución:** Espera el tiempo indicado antes de reintentar.

---

## Referencia Rápida de Permisos

| Endpoint | public | patient | doctor | admin |
|---|:---:|:---:|:---:|:---:|
| `POST /auth/register` | ✅ | ✅ | ✅ | ✅ |
| `POST /auth/login` | ✅ | ✅ | ✅ | ✅ |
| `POST /auth/refresh` | ✅ | ✅ | ✅ | ✅ |
| `POST /auth/logout` | ❌ | ✅ | ✅ | ✅ |
| `POST /users` | ❌ | ❌ | ❌ | ✅ |
| `GET /users` | ❌ | ❌ | ❌ | ✅ |
| `GET /users/:id` | ❌ | ❌ | ❌ | ✅ |
| `PATCH /users/:id` | ❌ | ❌ | ❌ | ✅ |
| `DELETE /users/:id` | ❌ | ❌ | ❌ | ✅ |
| `POST /specialties` | ❌ | ❌ | ❌ | ✅ |
| `GET /specialties` | ❌ | ✅ | ✅ | ✅ |
| `GET /specialties/:id` | ❌ | ✅ | ✅ | ✅ |
| `PATCH /specialties/:id` | ❌ | ❌ | ❌ | ✅ |
| `DELETE /specialties/:id` | ❌ | ❌ | ❌ | ✅ |
| `POST /doctors` | ❌ | ❌ | ❌ | ✅ |
| `GET /doctors` | ❌ | ✅ | ✅ | ✅ |
| `GET /doctors/:id` | ❌ | ✅ | ✅ | ✅ |
| `POST /doctors/:id/specialties/:sid` | ❌ | ❌ | ❌ | ✅ |
| `DELETE /doctors/:id/specialties/:sid` | ❌ | ❌ | ❌ | ✅ |
| `PATCH /doctors/:id` | ❌ | ❌ | ❌ | ✅ |
| `DELETE /doctors/:id` | ❌ | ❌ | ❌ | ✅ |
| `POST /patients` | ❌ | ✅* | ✅ | ✅ |
| `GET /patients` | ❌ | ❌ | ❌ | ✅ |
| `GET /patients/:id` | ❌ | ✅* | ✅ | ✅ |
| `GET /patients/user/:userId` | ❌ | ✅* | ✅ | ✅ |
| `PATCH /patients/:id` | ❌ | ✅* | ✅ | ✅ |
| `DELETE /patients/:id` | ❌ | ❌ | ❌ | ✅ |
| `POST /appointments` | ❌ | ✅* | ✅* | ✅ |
| `GET /appointments` | ❌ | ❌ | ❌ | ✅ |
| `GET /appointments/:id` | ❌ | ✅* | ✅* | ✅ |
| `GET /appointments/patient/:id` | ❌ | ✅* | ❌ | ✅ |
| `GET /appointments/doctor/:id` | ❌ | ❌ | ✅* | ✅ |
| `GET /appointments/date/:date` | ❌ | ❌ | ❌ | ✅ |
| `PATCH /appointments/:id/status` | ❌ | ✅* | ✅* | ✅ |
| `PATCH /appointments/:id` | ❌ | ✅* | ✅* | ✅ |
| `DELETE /appointments/:id` | ❌ | ✅* | ✅* | ✅ |

> `*` = solo sobre sus propios recursos (ownership check)
