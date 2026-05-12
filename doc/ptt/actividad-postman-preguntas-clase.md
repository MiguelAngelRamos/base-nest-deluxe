# Actividad práctica en Postman — Validación empírica de `preguntas.md` (Demostración en clases)

Esta guía traduce las dos preguntas teóricas de [`preguntas.md`](preguntas.md) en una secuencia de peticiones HTTP reales contra el API. Al final de cada actividad podrás afirmar — con pruebas en mano — que el comportamiento descrito en el documento es **exactamente** lo que ocurre.

No se asume ningún paso previo: la guía cubre desde el arranque del API hasta el cleanup de los usuarios de prueba.

---

## Objetivo

| Pregunta del documento | Lo que vamos a demostrar empíricamente |
|---|---|
| **Pregunta 1** — Logout con 10 minutos de vida restante | Un access token criptográficamente válido es rechazado con `401 Token revocado` **inmediatamente** después del logout, antes de que su `exp` natural se cumpla. |
| **Pregunta 2** — Usuario desactivado por un admin | Los tres vectores (access token actual, refresh, login con email/password) quedan bloqueados al instante en que `isActive = false` se persiste en la BD. |

---

## Prerrequisitos

Antes de empezar necesitas tener corriendo y accesible:

| Componente | Cómo verificar |
|---|---|
| **API NestJS** en `http://localhost:3000` | `GET http://localhost:3000/api/v1/specialties` debería responder con `401` si no hay token (señal de que está vivo) |
| **PostgreSQL** con la BD del proyecto | Conexión vía `psql`, DBeaver o pgAdmin con las credenciales del `.env` |
| **Valkey** (o Redis compatible) | `redis-cli ping` debe responder `PONG`. Si usas Valkey nativo: `valkey-cli ping` |
| **Postman** | Versión 10+ recomendada. Funciona también con Insomnia o Bruno con ajustes mínimos |
| **`NODE_ENV=development`** en el `.env` del API | Necesario para que la cookie del refresh token NO sea `Secure` (en HTTP local sin TLS la cookie con `Secure` no se envía) |

> **Tip:** si tienes el API corriendo, abre `http://localhost:3000/api/docs` (Swagger) y autentícate con el Basic Auth (`admin` / `change-me` por defecto, o lo que tengas en `SWAGGER_USER`/`SWAGGER_PASSWORD`). Sirve como segundo método de prueba si Postman da problemas.

---

## Setup inicial

### Variables de entorno en Postman

Crea una **Environment** llamada `Clinic API - Demo Clase` con estas variables:

| Variable | Valor inicial | Propósito |
|---|---|---|
| `baseUrl` | `http://localhost:3000/api/v1` | Prefijo común de todos los endpoints |
| `sofiaAccessToken` | *(vacío)* | Se rellena tras el login de Sofía |
| `catalinaAccessToken` | *(vacío)* | Se rellena tras el login de Catalina |
| `catalinaUserId` | *(vacío)* | UUID de Catalina — necesario para el `DELETE /users/:id` |
| `superAdminAccessToken` | *(vacío)* | Se rellena tras el login del admin |
| `sofiaJti` | *(vacío)* | jti decodificado del access token de Sofía — verificación opcional en Valkey |

Selecciona esta environment como activa en la esquina superior derecha de Postman.

### Configuración de cookies en Postman

Postman maneja cookies automáticamente por dominio. Para esta guía:

1. Ve a **Settings → General → Working directory** y asegúrate de que **"Automatically follow redirects"** esté en `ON`.
2. En la pestaña **Cookies** (junto al panel de Send), verifica que `localhost` esté listado. Si no, lo añadirá automáticamente la primera petición que reciba un `Set-Cookie`.

> La cookie `refresh_token` se setea con `Path=/api/v1/auth/refresh`, así que **solo se enviará** cuando hagas peticiones a ese endpoint. Esto es por diseño (least privilege) — no es un fallo.

---

## Crear el usuario ADMIN — vía SQL

El endpoint `POST /auth/register` fuerza el rol a `PATIENT` por seguridad ([`auth.service.ts:68`](src/auth/auth.service.ts#L68)). Para tener un ADMIN hay que crear un usuario normal y luego promover su rol directamente en la BD.

### Paso A — Registrar un usuario que será nuestro ADMIN

Petición en Postman:

```http
POST {{baseUrl}}/auth/register
Content-Type: application/json

{
  "email": "super.admin@clinica.cl",
  "password": "SuperAdmin2026!"
}
```

**Respuesta esperada:** `201 Created`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "user": {
    "id": "...",
    "email": "super.admin@clinica.cl",
    "role": "patient"
  }
}
```

Observa que `role` viene como `"patient"` aunque queramos un admin. Eso es lo que vamos a corregir con SQL.

### Paso B — Promover el usuario a ADMIN con SQL

Conéctate a la BD del proyecto y ejecuta:

```sql
-- Promueve el usuario a rol ADMIN
UPDATE users
SET role = 'admin'
WHERE email = 'super.admin@clinica.cl';

-- Verifica el cambio
SELECT id, email, role, is_active
FROM users
WHERE email = 'super.admin@clinica.cl';
```

Resultado esperado del `SELECT`:

| id | email | role | is_active |
|---|---|---|---|
| `<uuid>` | `super.admin@clinica.cl` | `admin` | `true` |

> **Importante:** el access token que recibiste al registrar (Paso A) sigue diciendo `role: 'patient'` en su payload firmado. Como la firma incluye el rol antiguo, **ese token ya no sirve** para operaciones de admin — pero `JwtStrategy.validate()` lee el rol *actual* desde la BD y lo coloca en `req.user`. Para evitar ambigüedad y para que el frontend tenga un token coherente, **descártalo** y haz un login nuevo (paso C).

### Paso C — Login del admin (con el rol ya promovido)

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json

{
  "email": "super.admin@clinica.cl",
  "password": "SuperAdmin2026!"
}
```

**Respuesta esperada:** `200 OK`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "user": {
    "id": "...",
    "email": "super.admin@clinica.cl",
    "role": "admin"
  }
}
```

Ahora `role` viene como `"admin"`. Copia el `accessToken` y guárdalo en `{{superAdminAccessToken}}` en la environment de Postman.

---

# Pregunta 1 — Logout y blocklist Valkey

> *"Si alguien cierra sesión y a su access token le quedan 10 minutos, ¿cómo lo resuelve este proyecto?"*

## Paso 1 — Crear y autenticar a Sofía (usuario PATIENT)

Vamos a usar a Sofía como usuario normal. Primero la registramos:

```http
POST {{baseUrl}}/auth/register
Content-Type: application/json

{
  "email": "sofia.demo@clinica.cl",
  "password": "Sofia2026!"
}
```

**Respuesta esperada:** `201 Created` con un `accessToken` y `user.role = "patient"`.

Copia el `accessToken` a la variable `{{sofiaAccessToken}}`.

> El registro también setea una cookie `refresh_token` HttpOnly. Postman la guarda automáticamente; no necesitas tocarla.

## Paso 2 — Decodificar el JWT para ver el `jti` (paso pedagógico)

Esto **no** es estrictamente necesario para la prueba, pero es muy útil para entender qué viaja dentro del token.

Copia el `accessToken` y pégalo en [https://jwt.io](https://jwt.io). En el panel "PAYLOAD: DATA" verás algo como:

```json
{
  "sub": "8b3d4e9a-2f1c-4b7e-9d6a-3f8e1c5b7a2d",
  "email": "sofia.demo@clinica.cl",
  "role": "patient",
  "jti": "c2a4f6e8-1b3d-4f5a-8c9e-2d4f6a8b1c3e",
  "iat": 1745880000,
  "exp": 1745880900,
  "iss": "clinic-api",
  "aud": "clinic-frontend"
}
```

Anota el valor de `jti` en `{{sofiaJti}}` — lo usaremos para inspeccionar Valkey en el Paso 5.

**Lo que importa de este paso:** el `jti` es un UUID v4 único. Si haces logout y vuelves a hacer login, recibirás otro token con un `jti` diferente. Ese identificador único es la "matrícula" que permite invalidar este token específico sin tocar los demás.

## Paso 3 — Confirmar que el access token funciona

Hacemos una petición a un endpoint protegido pero sin restricción de rol — `GET /specialties` ([`specialties.controller.ts:59-63`](src/specialties/specialties.controller.ts#L59-L63)) — para confirmar que el token de Sofía funciona normalmente:

```http
GET {{baseUrl}}/specialties
Authorization: Bearer {{sofiaAccessToken}}
```

**Respuesta esperada:** `200 OK`

```json
[
  { "id": "...", "name": "Cardiología", ... },
  { "id": "...", "name": "Pediatría", ... }
]
```

(Si no hay especialidades creadas, recibirás `[]` — eso también vale como prueba de éxito; lo que confirma que el token funcionó es el `200`.)

> **Si recibes `401`:** revisa que pegaste el token correcto en `{{sofiaAccessToken}}` y que la environment de Postman está activa.

## Paso 4 — Hacer logout

Aquí es donde el `jti` se escribe en la blocklist de Valkey:

```http
POST {{baseUrl}}/auth/logout
Authorization: Bearer {{sofiaAccessToken}}
```

**Respuesta esperada:** `204 No Content` (sin body).

En el lado del servidor han pasado dos cosas (ver [`auth.service.ts:174-201`](src/auth/auth.service.ts#L174-L201)):

1. **Operación 1:** `SET blocklist:at:<jti> "1" EX <ttl>` en Valkey — donde `<ttl>` es exactamente los segundos que le quedan al token.
2. **Operación 2:** `UPDATE users SET refresh_token_hash = NULL WHERE id = ...` en Postgres.

## Paso 5 (opcional) — Verificar la entrada en Valkey

Esto es lo que diferencia "creo que pasa" de "veo que pasa". Abre una terminal con `redis-cli` (o `valkey-cli`):

```bash
# 1. Listar todas las claves de la blocklist
redis-cli KEYS "blocklist:at:*"

# Salida esperada — exactamente un jti, el de Sofía:
# 1) "blocklist:at:c2a4f6e8-1b3d-4f5a-8c9e-2d4f6a8b1c3e"

# 2. Ver el valor
redis-cli GET "blocklist:at:c2a4f6e8-1b3d-4f5a-8c9e-2d4f6a8b1c3e"
# "1"

# 3. Ver cuántos segundos le quedan
redis-cli TTL "blocklist:at:c2a4f6e8-1b3d-4f5a-8c9e-2d4f6a8b1c3e"
# (integer) 873   ← unos 14 minutos y medio si hiciste logout justo después de crear la cuenta
```

> **Lo que esto demuestra:** la entrada existe, tiene un valor mínimo (`"1"` — solo importa la existencia), y el TTL está sincronizado con la expiración natural del token JWT. Cuando ese TTL llegue a 0, la clave desaparece sola — sin proceso de limpieza, sin acumulación.

## Paso 6 — Confirmar que el mismo token ahora es rechazado

Repetimos **exactamente** la misma petición del Paso 3 con el **mismo** access token (que sigue siendo criptográficamente válido — su `exp` no ha pasado):

```http
GET {{baseUrl}}/specialties
Authorization: Bearer {{sofiaAccessToken}}
```

**Respuesta esperada:** `401 Unauthorized`

```json
{
  "statusCode": 401,
  "message": "Token revocado",
  "error": "Unauthorized"
}
```

## Veredicto de la Pregunta 1

| Afirmación del documento | Comprobación empírica |
|---|---|
| El token sigue siendo criptográficamente válido tras el logout | ✅ Lo decodificamos en jwt.io y la firma + `exp` siguen correctas |
| La blocklist en Valkey rechaza el token aunque sea válido | ✅ Paso 6 → `401 Token revocado` |
| El TTL de Valkey iguala la vida restante del JWT | ✅ Paso 5 → `TTL ≈ exp − now` |
| No hay basura acumulada — la clave caduca sola | ✅ El comando `TTL` muestra que la clave se auto-elimina al llegar a 0 |

**Conclusión:** la ventana de 10 minutos del enunciado de la Pregunta 1 queda cerrada en el instante exacto del logout. Sin la blocklist, el Paso 6 habría devuelto `200`.

---

# Pregunta 2 — Desactivación de un usuario y los tres vectores bloqueados

> *"Si alguien deja la organización, ¿qué pasa con sus refresh tokens y access tokens? ¿Cómo lo resuelve este proyecto?"*

## Paso 1 — Crear y autenticar a Catalina (la doctora que será desactivada)

```http
POST {{baseUrl}}/auth/register
Content-Type: application/json

{
  "email": "catalina.demo@clinica.cl",
  "password": "Catalina2026!"
}
```

**Respuesta esperada:** `201 Created`.

> En un sistema real Catalina sería DOCTOR, pero el endpoint público fuerza PATIENT. Para esta demostración el rol es irrelevante — lo que probamos es la desactivación, no los permisos. Si quieres realismo extra, ejecuta `UPDATE users SET role = 'doctor' WHERE email = 'catalina.demo@clinica.cl';` en Postgres antes de continuar.

Hacemos login para obtener tokens limpios:

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json

{
  "email": "catalina.demo@clinica.cl",
  "password": "Catalina2026!"
}
```

**Respuesta esperada:** `200 OK`. Copia:

- `accessToken` → `{{catalinaAccessToken}}`
- `user.id` → `{{catalinaUserId}}` (lo necesitamos para el DELETE)

> Postman habrá guardado automáticamente la cookie `refresh_token` de Catalina. Podemos verlo en la pestaña **Cookies → localhost**: aparecerá una entrada `refresh_token` con `HttpOnly`, `Path=/api/v1/auth/refresh`.

## Paso 2 — Confirmar que Catalina accede normalmente

```http
GET {{baseUrl}}/specialties
Authorization: Bearer {{catalinaAccessToken}}
```

**Respuesta esperada:** `200 OK` (lista de especialidades, posiblemente vacía).

## Paso 3 — Verificar que el admin sigue autenticado

Si ya hiciste el setup del admin, deberías tener `{{superAdminAccessToken}}` cargado. Si han pasado más de 15 minutos desde el login del admin, repite el paso C del Setup para refrescarlo.

Verifica el admin con un endpoint que solo él puede llamar — `GET /users` ([`users.controller.ts:63-67`](src/users/users.controller.ts#L63-L67)):

```http
GET {{baseUrl}}/users
Authorization: Bearer {{superAdminAccessToken}}
```

**Respuesta esperada:** `200 OK` con la lista de usuarios. Verás a `super.admin`, `sofia.demo` y `catalina.demo`.

> Si recibes `403 Forbidden`, el admin perdió el rol o el token usa un rol antiguo. Ejecuta el `UPDATE users SET role = 'admin' ...` y vuelve a hacer login.

## Paso 4 — Desactivar a Catalina (acción del admin)

Esta es la acción que dispara la desactivación. Como vimos en [`users.controller.ts:84-89`](src/users/users.controller.ts#L84-L89), el verbo es `DELETE` pero internamente solo cambia `is_active = false` (soft delete):

```http
DELETE {{baseUrl}}/users/{{catalinaUserId}}
Authorization: Bearer {{superAdminAccessToken}}
```

**Respuesta esperada:** `204 No Content`.

## Paso 5 (opcional) — Verificar el cambio en Postgres

```sql
SELECT id, email, role, is_active, refresh_token_hash IS NOT NULL AS has_refresh
FROM users
WHERE email = 'catalina.demo@clinica.cl';
```

| email | role | is_active | has_refresh |
|---|---|---|---|
| `catalina.demo@clinica.cl` | `patient` | `false` | `true` |

> **Detalle clave:** `is_active` es `false`, pero `refresh_token_hash` **sigue presente**. La desactivación NO toca el hash del refresh — la defensa la hace el `if (!user.isActive)` en `refreshToken()`. Esto significa que si reactivamos a Catalina (`UPDATE ... SET is_active = true`), su refresh token original vuelve a funcionar inmediatamente — un detalle interesante que no es obvio leyendo solo el código.

## Paso 6 — Vector 1: el access token actual de Catalina queda inválido

Catalina (o quien tenga su token) intenta hacer la misma petición que en el Paso 2:

```http
GET {{baseUrl}}/specialties
Authorization: Bearer {{catalinaAccessToken}}
```

**Respuesta esperada:** `401 Unauthorized`

```json
{
  "statusCode": 401,
  "message": "Usuario desactivado",
  "error": "Unauthorized"
}
```

> **Origen del rechazo:** [`jwt.strategy.ts:69-71`](src/auth/strategies/jwt.strategy.ts#L69-L71). `validate()` ejecuta `usersService.findOne(payload.sub)` en cada petición y, al encontrar `isActive: false`, lanza `UnauthorizedException('Usuario desactivado')`.

## Paso 7 — Vector 2: el refresh token de Catalina tampoco renueva

El frontend, al recibir el `401` del Paso 6, intentaría renovar automáticamente. Simulamos esa llamada:

```http
POST {{baseUrl}}/auth/refresh
```

(Sin body. Postman envía la cookie `refresh_token` automáticamente porque el endpoint coincide con el `Path` de la cookie.)

**Respuesta esperada:** `401 Unauthorized`

```json
{
  "statusCode": 401,
  "message": "Refresh token inválido",
  "error": "Unauthorized"
}
```

> **Origen del rechazo:** [`auth.service.ts:125-127`](src/auth/auth.service.ts#L125-L127). `refreshToken()` carga al usuario con el `userId` extraído del payload del refresh y rechaza si `!user.isActive`. El método nunca llega a comparar el hash con Argon2 — el corte es anterior.

> **Si recibes "Refresh token no presente":** la cookie no se está enviando. Causas comunes:
> - El path de la cookie no coincide. Verifica en Postman → Cookies → localhost que la cookie tenga `Path=/api/v1/auth/refresh` y que estás haciendo la petición a esa URL exacta.
> - `NODE_ENV` no es `development` y la cookie tiene `Secure: true`. En HTTP local sin TLS, las cookies con `Secure` no se envían. Pon `NODE_ENV=development` en el `.env` y reinicia el API.

## Paso 8 — Vector 3: Catalina no puede ni siquiera volver a hacer login

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json

{
  "email": "catalina.demo@clinica.cl",
  "password": "Catalina2026!"
}
```

**Respuesta esperada:** `401 Unauthorized`

```json
{
  "statusCode": 401,
  "message": "Credenciales inválidas",
  "error": "Unauthorized"
}
```

> **Origen del rechazo:** [`auth.service.ts:100-102`](src/auth/auth.service.ts#L100-L102). `validateUser()` retorna `null` cuando `!user.isActive`, sin llegar a verificar la contraseña con Argon2. `LocalStrategy.validate()` traduce ese `null` en `UnauthorizedException('Credenciales inválidas')`.
>
> **Detalle de seguridad importante:** el mensaje es genéricamente *"Credenciales inválidas"* — el mismo que se devuelve si el password fuera incorrecto. Esto es deliberado (OWASP A07): un atacante que pruebe el email de Catalina no puede deducir si el usuario existe, si está desactivado o si el password está mal.

## Veredicto de la Pregunta 2

| Vector del documento | Endpoint probado | Status | Mensaje | ¿Coincide con preguntas.md? |
|---|---|---|---|---|
| Access token actual | `GET /specialties` | 401 | "Usuario desactivado" | ✅ |
| Refresh token | `POST /auth/refresh` | 401 | "Refresh token inválido" | ✅ |
| Login con email/password | `POST /auth/login` | 401 | "Credenciales inválidas" | ✅ |

**Conclusión:** los tres vectores quedan cerrados en el instante exacto en que el `UPDATE users SET is_active = false` se confirma en Postgres. No hace falta tocar tokens individualmente, no hace falta esperar a que expiren, no hace falta limpiar nada.

---

## Cleanup — Volver al estado inicial

Cuando termines la actividad, puedes restaurar los usuarios de prueba con SQL:

```sql
-- Reactivar a Catalina (si quieres reusarla en otra sesión)
UPDATE users
SET is_active = true
WHERE email = 'catalina.demo@clinica.cl';

-- O eliminar todos los usuarios de prueba — solo si no han creado
-- recursos relacionados (citas, etc.) que romperían la integridad referencial
DELETE FROM users
WHERE email IN (
  'sofia.demo@clinica.cl',
  'catalina.demo@clinica.cl',
  'super.admin@clinica.cl'
);
```

Y opcionalmente vaciar la blocklist de Valkey:

```bash
# Borra solo las claves de la blocklist — deja intacto cualquier
# otro dato que pueda haber en Valkey
redis-cli --scan --pattern "blocklist:at:*" | xargs -r redis-cli DEL
```

---

## Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `Cannot POST /api/v1/...` o `404` en todo | Falta el prefijo `api/v1` en `{{baseUrl}}` | Verifica que `baseUrl` valga `http://localhost:3000/api/v1` |
| `401` en el primer GET, sin haber hecho logout | El `accessToken` se copió mal o expiró (15 min) | Decodifica el token en jwt.io — si `exp` ya pasó, vuelve a hacer login |
| `429 Too Many Requests` al hacer varios login | El throttle está activo: 5 logins/min/IP ([`auth.controller.ts:107`](src/auth/auth.controller.ts#L107)) | Espera 1 minuto o reinicia el API |
| `Refresh token no presente` en `/auth/refresh` | La cookie no se está enviando — ver Paso 7 | Comprueba `Path` de la cookie y `NODE_ENV` |
| `403 Forbidden` con el token del admin | El token fue emitido **antes** del UPDATE de rol | Vuelve a hacer login del admin tras el `UPDATE users SET role = 'admin'` |
| `Token revocado` cuando no esperas blocklist | Se reusó un token de un logout previo | Login nuevo — cada login emite un `jti` distinto |
| `valkey-cli`/`redis-cli` no encuentra la clave tras logout | Valkey no está conectado al API | Mira los logs del API al arrancar — debe decir `Valkey conectado en 127.0.0.1:6379`. Si no, revisa `VALKEY_HOST` y `VALKEY_PORT` en `.env` |
| Respuesta `Internal server error` sin detalle | El filtro global oculta los detalles en runtime | Revisa los logs del proceso de Node (`npm run start:dev`) — el stack trace está ahí |

---

## Resumen — Qué probaste con esta actividad

1. **El `jti` es real y único** — lo viste decodificado en jwt.io y como clave en Valkey.
2. **La blocklist funciona** — el mismo token devolvió 200 antes del logout y 401 después, sin que pasara el `exp` natural.
3. **El TTL es dinámico** — `redis-cli TTL` mostró segundos sincronizados con `exp − now`.
4. **`isActive` es la fuente de verdad** — un `UPDATE` de un solo campo cierra los tres vectores de acceso al instante.
5. **El mensaje de login es genérico** — desactivación y password incorrecto devuelven el mismo error, previniendo enumeración (OWASP A07).
6. **El refresh queda cortado por dos vías independientes**: en logout por nulificar el hash en BD; en desactivación por `if (!user.isActive)` en `refreshToken()`.

Cualquiera de estas afirmaciones puede ser reproducida en menos de 5 minutos siguiendo esta guía. Si alguna falla, el sistema tiene un bug — la guía sirve también como test de regresión manual.

---

## Tabla resumen de credenciales — Demo en clases

Para tenerlo todo a la vista durante la demostración:

| Usuario | Email | Password | Rol | Variable de Postman |
|---|---|---|---|---|
| Sofía (paciente, hace logout) | `sofia.demo@clinica.cl` | `Sofia2026!` | `patient` | `{{sofiaAccessToken}}` |
| Catalina (será desactivada) | `catalina.demo@clinica.cl` | `Catalina2026!` | `patient` (o `doctor`) | `{{catalinaAccessToken}}` |
| Super Admin | `super.admin@clinica.cl` | `SuperAdmin2026!` | `admin` (tras `UPDATE`) | `{{superAdminAccessToken}}` |
