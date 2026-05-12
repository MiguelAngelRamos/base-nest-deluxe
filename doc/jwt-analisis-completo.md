# JWT — Análisis Completo de la Implementación

> **Rama:** `security/jwt-hardening`  
> **Fecha de análisis:** 2026-04-23  
> **Stack:** NestJS · @nestjs/jwt · Passport · Valkey (Redis) · Argon2id

---

## Índice

1. [Visión general — el sistema dual de tokens](#1-visión-general--el-sistema-dual-de-tokens)
2. [Creación de tokens — payload y firma](#2-creación-de-tokens--payload-y-firma)
3. [Secrets — dónde se definen y cómo se validan](#3-secrets--dónde-se-definen-y-cómo-se-validan)
4. [Expiración — tiempos y configuración](#4-expiración--tiempos-y-configuración)
5. [Validación — Guards y Strategies](#5-validación--guards-y-strategies)
6. [Refresh token — rotación y almacenamiento](#6-refresh-token--rotación-y-almacenamiento)
7. [JTI — el identificador único por token](#7-jti--el-identificador-único-por-token)
8. [Blocklist — revocación con Valkey](#8-blocklist--revocación-con-valkey)
9. [Cómo llegan los tokens en cada request](#9-cómo-llegan-los-tokens-en-cada-request)
10. [Flujos completos end-to-end](#10-flujos-completos-end-to-end)
11. [Hardening de seguridad aplicado](#11-hardening-de-seguridad-aplicado)
12. [Mapa de archivos relevantes](#12-mapa-de-archivos-relevantes)
13. [Qué más deberías saber / preguntas frecuentes](#13-qué-más-deberías-saber--preguntas-frecuentes)

---

## 1. Visión general — el sistema dual de tokens

Esta API usa **dos tokens JWT con propósitos distintos**, una práctica estándar en APIs modernas que equilibra seguridad y usabilidad:

| Característica       | Access Token                   | Refresh Token                   |
|----------------------|--------------------------------|---------------------------------|
| Propósito            | Autenticar cada request        | Obtener un nuevo access token   |
| Duración             | **15 minutos**                 | **7 días**                      |
| Secret de firma      | `JWT_SECRET`                   | `JWT_REFRESH_SECRET`            |
| Payload              | id, email, role, **jti**       | solo id del usuario             |
| Dónde viaja          | Header `Authorization: Bearer` | Cookie HttpOnly `refresh_token` |
| Almacenado en server | Blocklist Valkey (al revocar)  | Hash Argon2 en base de datos    |
| Quién lo lee         | JwtStrategy en cada request    | Solo el endpoint `/auth/refresh`|

La separación en dos tokens resuelve un problema fundamental: si el access token tuviera vida larga, un robo comprometería la cuenta por horas o días. Con 15 minutos de vida, el daño se acota, y el refresh token —guardado en cookie HttpOnly— renueva el acceso de forma transparente sin pedir credenciales al usuario.

---

## 2. Creación de tokens — payload y firma

**Archivo:** [src/auth/auth.service.ts](../src/auth/auth.service.ts)

El método `issueTokens()` es el único lugar donde se crean tokens. Firma ambos con `JwtService.signAsync()`:

### Access Token — payload completo

```typescript
const jti = randomUUID();   // UUID v4 único por token

const accessToken = await this.jwtService.signAsync(
  {
    sub:   user.id,     // UUID del usuario (no int secuencial)
    email: user.email,
    role:  user.role,   // 'admin' | 'doctor' | 'patient'
    jti,               // identificador único del token
  },
  {
    secret:    jwtConfig.secret,
    expiresIn: jwtConfig.expiration,   // '15m'
    algorithm: 'HS256',
    issuer:    'clinic-api',
    audience:  'clinic-web',
  }
);
```

### Refresh Token — payload mínimo

```typescript
const refreshToken = await this.jwtService.signAsync(
  {
    sub: user.id,   // solo el ID
  },
  {
    secret:    jwtConfig.refreshSecret,
    expiresIn: jwtConfig.refreshExpiration,   // '7d'
    algorithm: 'HS256',
    issuer:    'clinic-api',
    audience:  'clinic-web',
  }
);
```

**Por qué el refresh token tiene payload mínimo:** en caso de que llegue a interceptarse (improbable dado que viaja en cookie HttpOnly + HTTPS), expone la información mínima posible. El access token puede tener más datos porque su ventana de exposición es de 15 minutos.

### Estructura real de un JWT (las tres partes)

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9   ← Header (Base64)
.
eyJzdWIiOiJ1dWlkLWRlbC11c3VhcmlvIiwiZW1haWwiOiJ1c2VyQGV4LmNvbSIsInJvbGUiOiJkb2N0b3IiLCJqdGkiOiJ1dWlkLXVuaWNvIiwiaWF0IjoxNzE0MDAwMDAwLCJleHAiOjE3MTQwMDA5MDB9
.                                         ← Payload (Base64, visible sin secret)
HMACSHA256(header + "." + payload, JWT_SECRET)   ← Signature (verificable solo con secret)
```

> **Dato clave:** el payload de un JWT es Base64 *codificado*, no cifrado. Cualquiera puede decodificarlo. Por eso nunca se mete información sensible (contraseñas, datos privados). La firma garantiza que nadie lo modificó, no que sea secreto.

---

## 3. Secrets — dónde se definen y cómo se vinculan a cada token

### Pregunta clave: ¿cómo sé que `JWT_SECRET` es para el access token y `JWT_REFRESH_SECRET` para el refresh?

La respuesta está en el método `issueTokens()` de [src/auth/auth.service.ts](../src/auth/auth.service.ts) (líneas 231–257). Lee el código en orden:

```typescript
// auth.service.ts — issueTokens() — líneas 231-257

// ① Opciones para el ACCESS token: usa 'jwt.secret'
const accessOptions = {
  secret:    this.configService.getOrThrow<string>('jwt.secret'),      // ← JWT_SECRET
  expiresIn: this.configService.getOrThrow<string>('jwt.expiration'),  // ← '15m'
  algorithm: 'HS256',
  issuer,
  audience,
};

// ② Opciones para el REFRESH token: usa 'jwt.refreshSecret'
const refreshOptions = {
  secret:    this.configService.getOrThrow<string>('jwt.refreshSecret'),      // ← JWT_REFRESH_SECRET
  expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiration'),  // ← '7d'
  algorithm: 'HS256',
  issuer,
  audience,
};

// ③ Se firma cada token con su propio objeto de opciones
const accessToken  = await this.jwtService.signAsync(payload,        accessOptions);
//                                                    ↑ id+email+role+jti    ↑ usa JWT_SECRET

const refreshToken = await this.jwtService.signAsync({ sub: user.id }, refreshOptions);
//                                                    ↑ solo el id      ↑ usa JWT_SECRET_REFRESH
```

El vínculo es explícito y manual: el programador elige qué secret pasa a cada `signAsync()`. No hay ninguna convención de nombres mágica — la asociación ocurre porque `accessOptions` y `refreshOptions` son dos objetos distintos construidos líneas antes, y cada uno recibe el secret correcto de `configService`.

---

### ¿Qué hace `registerAs` y cómo conecta todo?

`registerAs` es una función de NestJS que crea un **namespace de configuración con nombre**. En [src/config/jwt.config.ts](../src/config/jwt.config.ts):

```typescript
// jwt.config.ts — líneas 34-50

export default registerAs('jwt', () => ({         // ← nombre del namespace: 'jwt'
  secret:            assertSecret('JWT_SECRET',         process.env.JWT_SECRET),
  //       ↑ clave dentro del namespace            ↑ variable de entorno del sistema operativo
  refreshSecret:     assertSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET),
  expiration:        process.env.JWT_EXPIRATION         || '15m',
  refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
  issuer:            process.env.JWT_ISSUER             || 'clinic-api',
  audience:          process.env.JWT_AUDIENCE           || 'clinic-web',
}));
```

La cadena completa es:

```
.env                  jwt.config.ts                  auth.service.ts
─────────────────     ──────────────────────────     ─────────────────────────────────────
JWT_SECRET=abc…  →    secret: assertSecret(…)   →   configService.get('jwt.secret')
                      (dentro del namespace 'jwt')    (lee 'jwt' → 'secret')

JWT_REFRESH_SECRET=xyz… → refreshSecret: …      →   configService.get('jwt.refreshSecret')
```

En resumen: `registerAs('jwt', ...)` define el objeto; `configService.get('jwt.secret')` lo consume usando `namespace.clave`. Sin `registerAs`, tendrías que leer `process.env.JWT_SECRET` directamente en cada sitio, sin validación ni tipado.

---

### La función `assertSecret()` — validación al arrancar

```typescript
// jwt.config.ts — líneas 19-31

function assertSecret(name: string, value: string | undefined): string {
  if (!value || value.length < 32) {
    const msg = `${name} debe tener al menos 32 caracteres aleatorios`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);   // ← la app no arranca
    }
    console.warn(`[jwt.config] WARN ${msg}`);   // ← solo avisa en dev/test
  }
  return value ?? '';
}
```

| Entorno        | Secret < 32 bytes     | Sin secret            |
|----------------|-----------------------|-----------------------|
| `development`  | Warning en consola    | Warning en consola    |
| `test`         | Warning en consola    | Warning en consola    |
| `production`   | **Falla al arrancar** | **Falla al arrancar** |

Esto cumple con OWASP ASVS V2.10: secretos de mínimo 256 bits (32 bytes = 256 bits). En producción la app no puede arrancar con secrets débiles.

### Variables de entorno requeridas

```bash
# .env (nunca subir al repositorio)
JWT_SECRET=<mínimo-32-caracteres-aleatorios>
JWT_REFRESH_SECRET=<mínimo-32-caracteres-aleatorios-diferentes>
JWT_EXPIRATION=15m           # opcional, default 15m
JWT_REFRESH_EXPIRATION=7d    # opcional, default 7d
```

**Por qué dos secrets distintos:** si usaran el mismo, un access token válido podría presentarse como refresh token (y viceversa). Secrets separados crean compartimentos estancos: comprometer uno no afecta al otro.

---

## 3b. Cookie del refresh token — dónde se setean HttpOnly, Secure y SameSite

Esto ocurre exclusivamente en [src/auth/auth.controller.ts](../src/auth/auth.controller.ts), en dos métodos privados (líneas 224–254).

### El método que configura los flags

```typescript
// auth.controller.ts — líneas 245-254

private buildRefreshCookieOptions() {
  const env = this.configService.get<string>('app.nodeEnv');
  const secure = env !== 'development' && env !== 'test';   // false solo en dev/test
  return {
    httpOnly: true,          // ← JavaScript NO puede leer esta cookie (bloquea XSS)
    secure,                  // ← Solo viaja por HTTPS (true en producción)
    sameSite: 'strict',      // ← NO se envía en requests cross-site (bloquea CSRF)
    path: '/api/v1/auth/refresh',   // ← Cookie solo se envía a este endpoint
  };
}
```

### El método que setea la cookie en la respuesta

```typescript
// auth.controller.ts — líneas 224-231

private setRefreshCookie(res: Response, token: string) {
  res.cookie('refresh_token', token, {
    ...this.buildRefreshCookieOptions(),   // ← los 4 flags de seguridad
    maxAge: 7 * 24 * 60 * 60 * 1000,      // ← 7 días en milisegundos
  });
}
```

### Quién llama a `setRefreshCookie`

```
authController.register()  → línea 86  → this.setRefreshCookie(res, tokens.refreshToken)
authController.login()     → línea 127 → this.setRefreshCookie(res, tokens.refreshToken)
authController.refresh()   → línea 185 → this.setRefreshCookie(res, tokens.refreshToken)
```

### Qué aspecto tiene el header HTTP resultante

Cuando el servidor ejecuta `res.cookie(...)`, Express añade este header a la respuesta:

```
Set-Cookie: refresh_token=eyJ...; Path=/api/v1/auth/refresh; HttpOnly; Secure; SameSite=Strict; Max-Age=604800
```

El navegador guarda la cookie con esos atributos. Cuando el cliente hace `POST /api/v1/auth/refresh`, el navegador la incluye automáticamente porque el path coincide. JavaScript nunca puede leerla ni robarla porque el flag `HttpOnly` lo impide.

### Relación con `registerAs` — no hay ninguna

`registerAs` es solo para leer configuración (secrets, expiración, issuer). Los flags de la cookie son constantes en el controlador y solo dependen del entorno (`app.nodeEnv`) para decidir si `secure` es `true` o `false`. Son dos sistemas completamente separados que solo se unen en el controlador.

---

## 4. Expiración — tiempos y configuración

### Dónde se establece

La expiración se configura en `signAsync()` con el campo `expiresIn`. NestJS/jsonwebtoken convierte el string (`'15m'`, `'7d'`) en el claim `exp` del JWT, que es un Unix timestamp (segundos desde epoch):

```
exp = iat + 900        // para '15m' (900 segundos)
exp = iat + 604800     // para '7d' (604800 segundos)
```

### Quién valida la expiración

- **JwtStrategy** (Passport): rechaza automáticamente tokens con `exp` en el pasado. La opción `ignoreExpiration: false` está explícita para que sea imposible olvidar habilitarla.
- **Refresh endpoint:** `JwtService.verifyAsync()` con el refresh secret también valida expiración.

### Qué pasa cuando expira

| Token expirado   | Resultado                                          |
|------------------|----------------------------------------------------|
| Access Token     | 401 Unauthorized en el siguiente request           |
| Refresh Token    | 401 Unauthorized en `/auth/refresh`, fuerza re-login|

### Auto-expiración en la blocklist

Cuando se hace logout, el access token va a la blocklist de Valkey con un TTL calculado:

```typescript
const ttl = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
await this.valkey.set(`blocklist:at:${jti}`, '1', 'EX', ttl);
```

Así la clave en Valkey desaparece exactamente cuando el token habría expirado de todas formas. No hay limpieza manual ni acumulación de memoria.

---

## 5. Validación — Guards y Strategies

### El flujo de autenticación de un request

```
Request con Authorization: Bearer <token>
    │
    ▼
JwtAuthGuard (APP_GUARD global)
    │   ¿Tiene @Public()? → pasa sin validar
    │
    ▼
JwtStrategy (Passport)
    │
    ├─ 1. Extrae Bearer token del header
    ├─ 2. Verifica firma con JWT_SECRET
    ├─ 3. Verifica expiración (exp claim)
    ├─ 4. Verifica algoritmo = HS256
    ├─ 5. Verifica iss = 'clinic-api'
    ├─ 6. Verifica aud = 'clinic-web'
    │
    ▼
JwtStrategy.validate(payload)
    │
    ├─ 7. Busca usuario en DB (¿existe? ¿isActive?)
    ├─ 8. Consulta blocklist Valkey con jti
    │       ¿Está en blocklist? → 401
    │
    ▼
req.user = { id, email, role }   ← disponible en controller
```

**Archivos involucrados:**
- [src/auth/guards/jwt-auth.guard.ts](../src/auth/guards/jwt-auth.guard.ts) — guard global
- [src/auth/strategies/jwt.strategy.ts](../src/auth/strategies/jwt.strategy.ts) — validación Passport
- [src/app.module.ts](../src/app.module.ts) — registro como `APP_GUARD`

### El patrón whitelist (global guard + @Public)

```typescript
// Endpoint público — sin autenticación
@Public()
@Post('login')
async login() { ... }

// Endpoint protegido — autenticación requerida por defecto
@Get('me')
async getProfile(@CurrentUser() user: UserPayload) { ... }
```

Este patrón es más seguro que marcar endpoints como protegidos: si olvidas anotar un endpoint nuevo, queda protegido por defecto. Con el enfoque inverso (opt-in), un olvido deja un endpoint expuesto.

### Local Strategy — login inicial

Para el endpoint de login existe `LocalStrategy` con `LocalAuthGuard`. Valida email + contraseña antes de emitir tokens:

1. Busca usuario por email
2. Verifica contraseña con `argon2.verify()` (tiempo constante, previene timing attacks)
3. Devuelve el usuario si es válido

---

## 6. Refresh token — rotación y almacenamiento

### Por qué el refresh token no va en header como el access token

El refresh token viaja exclusivamente en una cookie HttpOnly, que tiene estas propiedades:
- **HttpOnly:** JavaScript no puede leerla. Un ataque XSS que robe tokens del localStorage no puede tocar esta cookie.
- **Secure:** Solo viaja por HTTPS (en producción).
- **SameSite=strict:** No se envía en requests cross-site. Protege contra CSRF.
- **Path=/api/v1/auth/refresh:** Solo se envía al único endpoint que lo necesita.

### Almacenamiento del refresh token en base de datos

El token completo nunca se guarda en la DB. Se guarda un **hash Argon2id**:

```typescript
const hash = await argon2.hash(refreshToken, {
  type:      argon2.argon2id,
  memoryCost: 65536,   // 64 MB RAM por hash (hace brute-force caro)
  timeCost:   3,
  parallelism: 4,
});
user.refreshTokenHash = hash;
await this.usersRepository.save(user);
```

Si la base de datos se compromete, el atacante obtiene hashes que no puede revertir fácilmente a tokens válidos.

### Token rotation — renovación en cada uso

Cada vez que se llama `/auth/refresh`:

```
Cliente envía refresh token (cookie)
    │
    ├─ 1. Verifica firma con JWT_REFRESH_SECRET
    ├─ 2. Carga usuario y su refreshTokenHash
    ├─ 3. argon2.verify(hash, tokenRecibido)
    │       No coincide → reuse detection (ver abajo)
    │
    ├─ 4. Emite nuevo par access + refresh token
    ├─ 5. Hashea y guarda el nuevo refresh token en DB
    ├─ 6. Invalida el anterior (sobrescribe hash)
    │
    ▼
Devuelve nuevo accessToken en body
Envía nuevo refresh token en Set-Cookie
```

El refresh token anterior queda inutilizable inmediatamente después de la renovación.

### Reuse detection — detección de robo de refresh token

Si el hash guardado en DB no coincide con el token recibido, significa que alguien está intentando usar un refresh token que ya fue rotado. Esto es señal de un posible robo:

```typescript
if (!hashMatch) {
  // Revocación de familia completa: todos los tokens del usuario quedan inválidos
  user.refreshTokenHash = null;
  await this.usersRepository.save(user);
  // El usuario debe hacer login de nuevo
  throw new UnauthorizedException('Refresh token inválido');
}
```

**Escenario que esto cubre:** atacante roba el refresh token de un usuario. El usuario legítimo lo usa (rotation normal). El atacante intenta usarlo después — hash no coincide — toda la sesión se invalida. Ambos son expulsados; el usuario legítimo verá un 401 y tendrá que re-autenticarse, lo que es una señal clara de que algo pasó.

---

## 7. JTI — el identificador único por token

**Archivo:** [src/auth/auth.service.ts](../src/auth/auth.service.ts)

```typescript
const jti = randomUUID();   // crypto.randomUUID() — UUID v4
```

El JTI (JWT ID) es un UUID que se genera nuevo para cada access token emitido. Vive en el payload del JWT y sirve como **clave primaria del token** sin necesidad de guardarlo en ningún lado mientras no se revoque.

### Para qué sirve

Sin JTI, revocar un token requeriría guardar en la blocklist el ID del usuario, pero un usuario puede tener múltiples sesiones (móvil, web, etc.). Con JTI:

- Cada token es individualmente identificable
- El logout revoca **ese token específico**, no todos los del usuario
- La blocklist es compacta: solo contiene tokens activamente revocados

### Cómo se usa en la blocklist

```typescript
// Logout: añadir a blocklist
await this.valkey.set(`blocklist:at:${jti}`, '1', 'EX', ttl);

// Validate: consultar blocklist
const revoked = await this.valkey.get(`blocklist:at:${jti}`);
if (revoked) throw new UnauthorizedException('Token revocado');
```

El JTI solo viaja en el **access token**. El refresh token no necesita JTI porque su revocación se gestiona sobreescribiendo el hash en la DB.

---

## 8. Blocklist — revocación con Valkey

**Archivos:** [src/valkey/valkey.module.ts](../src/valkey/valkey.module.ts) · [src/auth/auth.service.ts](../src/auth/auth.service.ts) · [src/auth/strategies/jwt.strategy.ts](../src/auth/strategies/jwt.strategy.ts)

Valkey es un fork open-source de Redis mantenido por la Linux Foundation, compatible con la API de Redis/ioredis.

### Por qué se necesita una blocklist

JWT es stateless por diseño: una vez firmado, el servidor no puede "des-validarlo". Si no hubiera blocklist, un access token robado seguiría siendo válido hasta que expire (15 minutos). La blocklist añade state mínimo para cerrar esa ventana.

### Estructura de la clave en Valkey

```
blocklist:at:{jti}  →  '1'   (TTL = segundos restantes del token)
```

### Flujo de logout

```typescript
async logout(accessToken: string, userId: string): Promise<void> {
  const payload = this.jwtService.decode(accessToken);
  const ttl = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));

  // Añadir access token a blocklist
  if (ttl > 0) {
    await this.valkey.set(`blocklist:at:${payload.jti}`, '1', 'EX', ttl);
  }

  // Invalidar refresh token en DB
  await this.usersService.clearRefreshToken(userId);
}
```

### Comportamiento fail-open

Si Valkey no está disponible, la consulta a la blocklist falla silenciosamente y el token **se considera válido**. Esto es una decisión deliberada: la disponibilidad del servicio tiene prioridad sobre la revocación inmediata. El `isActive` del usuario sigue siendo la defensa principal para casos urgentes.

```typescript
try {
  const revoked = await this.valkey.get(`blocklist:at:${jti}`);
  if (revoked) throw new UnauthorizedException();
} catch (err) {
  if (err instanceof UnauthorizedException) throw err;
  this.logger.error('Valkey unavailable during token check', err);
  // fail-open: continúa
}
```

---

## 9. Cómo llegan los tokens en cada request

### Login / Register — emisión inicial

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "secret" }
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Set-Cookie: refresh_token=eyJ...; Path=/api/v1/auth/refresh; HttpOnly; Secure; SameSite=Strict; Max-Age=604800

{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "user": { "id": "uuid", "email": "...", "role": "doctor" }
}
```

### Request autenticado — usando el access token

```http
GET /api/v1/users/me
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

```http
HTTP/1.1 200 OK

{ "id": "uuid", "email": "...", "role": "doctor" }
```

### Renovar tokens — usando el refresh token

```http
POST /api/v1/auth/refresh
Cookie: refresh_token=eyJ...
```

```http
HTTP/1.1 200 OK
Set-Cookie: refresh_token=eyJ...(nuevo); Path=/api/v1/auth/refresh; HttpOnly; ...

{
  "accessToken": "eyJ...(nuevo)",
  "user": { ... }
}
```

### Logout

```http
POST /api/v1/auth/logout
Authorization: Bearer eyJ...
Cookie: refresh_token=eyJ...
```

```http
HTTP/1.1 204 No Content
Set-Cookie: refresh_token=; Path=/api/v1/auth/refresh; HttpOnly; Max-Age=0
```

El `Max-Age=0` borra la cookie del navegador. El access token queda en la blocklist de Valkey.

---

## 10. Flujos completos end-to-end

### Flujo de sesión normal

```
Usuario                   API                          DB / Valkey
   │                       │                               │
   │── POST /auth/login ──►│                               │
   │   { email, password } │── SELECT user by email ──────►│
   │                       │◄── user row ─────────────────│
   │                       │── argon2.verify(hash, pwd)    │
   │                       │── randomUUID() → jti          │
   │                       │── signAsync(payload, secret)  │
   │                       │── signAsync(sub, refreshSec)  │
   │                       │── argon2.hash(refreshToken)   │
   │                       │── UPDATE users SET refresh_token_hash ──►│
   │◄── 200 + accessToken ─│                               │
   │    Set-Cookie: rt     │                               │
   │                       │                               │
   │── GET /users/me ─────►│                               │
   │   Authorization: Bearer│── verify(token, secret) OK   │
   │                       │── SELECT user WHERE isActive  │
   │                       │── GET blocklist:at:{jti} ─────►│
   │                       │◄── nil (no revocado) ─────────│
   │◄── 200 + user data ───│                               │
   │                       │                               │
   │   [15min después]     │                               │
   │── GET /users/me ─────►│                               │
   │   Authorization: Bearer│── verify → TokenExpiredError  │
   │◄── 401 Unauthorized ──│                               │
   │                       │                               │
   │── POST /auth/refresh ►│                               │
   │   Cookie: rt          │── verify(rt, refreshSecret)   │
   │                       │── SELECT user.refreshTokenHash│
   │                       │── argon2.verify(hash, rt) OK  │
   │                       │── emitir nuevos tokens        │
   │                       │── UPDATE refresh_token_hash ──►│
   │◄── 200 + accessToken ─│                               │
   │    Set-Cookie: rt(new)│                               │
```

### Flujo de logout

```
Usuario                   API                       DB / Valkey
   │                       │                            │
   │── POST /auth/logout ─►│                            │
   │   Authorization: Bearer│── decode(token) → jti, exp │
   │   Cookie: rt          │── ttl = exp - now()         │
   │                       │── SET blocklist:at:{jti} ──►│
   │                       │   EX ttl                    │
   │                       │── UPDATE refresh_token_hash = null ──►│
   │◄── 204 + cookie borrada│                            │
   │                       │                            │
   │── GET /users/me ─────►│                            │
   │   Authorization: Bearer│── verify → OK (firma válida)│
   │   (mismo token)       │── GET blocklist:at:{jti} ──►│
   │                       │◄── '1' (revocado) ──────────│
   │◄── 401 Unauthorized ──│                            │
```

---

## 11. Hardening de seguridad aplicado

Esta implementación cubre múltiples categorías del OWASP Top 10 2025:

### A02 — Cryptographic Failures

| Medida | Implementación |
|--------|----------------|
| Algoritmo fijado | `algorithm: 'HS256'` explícito — bloquea "algorithm confusion" (ninguno puede poner `alg: none`) |
| Secrets robustos | Mínimo 32 bytes, validados al arrancar |
| Secrets separados | `JWT_SECRET` ≠ `JWT_REFRESH_SECRET` — compartimentación |
| Argon2id | Hash de contraseñas con parámetros fuertes (64MB RAM, 3 iteraciones) |
| Hash de refresh token | Nunca se guarda el token en claro en DB |

### A07 — Identification and Authentication Failures

| Medida | Implementación |
|--------|----------------|
| Vida corta del access token | 15 minutos — ventana de exposición mínima |
| Rotación de refresh token | Cada uso emite un token nuevo, el anterior se invalida |
| Reuse detection | Refresh usado dos veces → revocación de toda la familia |
| Blocklist JTI | Logout inmediato incluso antes de expiración |
| Issuer/Audience | `iss = clinic-api`, `aud = clinic-web` — tokens no son intercambiables entre servicios |
| Rate limiting | 5 intentos/min en login, 5 registros/10min |

### A04 — Insecure Design

| Medida | Implementación |
|--------|----------------|
| Role en server-side | `RegisterDto` no incluye campo `role` — el cliente no puede autoelevarse |
| UUID IDs | No IDs secuenciales — previene enumeración de usuarios |
| Global guard por defecto | Endpoints privados por defecto; `@Public()` es la excepción |
| Cookie HttpOnly | Refresh token inaccesible desde JavaScript |

### A09 — Security Logging

- Login, refresh y logout producen logs con `userId` (nunca contraseñas)
- Reuse detection loguea el intento con `userId`
- Errores de Valkey se loguean aunque no interrumpan el flujo

---

## 12. Mapa de archivos relevantes

```
src/
├── app.module.ts                    ← Registro de APP_GUARD global (JwtAuthGuard)
├── auth/
│   ├── auth.module.ts               ← JwtModule.registerAsync(), importa config
│   ├── auth.service.ts              ← issueTokens(), refreshToken(), logout()
│   ├── auth.controller.ts           ← Endpoints: login, refresh, logout, register
│   ├── guards/
│   │   ├── jwt-auth.guard.ts        ← Guard global, respeta @Public()
│   │   └── local-auth.guard.ts      ← Guard para endpoint de login
│   ├── strategies/
│   │   ├── jwt.strategy.ts          ← Validación, consulta blocklist Valkey
│   │   └── local.strategy.ts        ← Validación email+password
│   └── decorators/
│       ├── public.decorator.ts      ← @Public() — marca endpoint como público
│       └── current-user.decorator.ts← @CurrentUser() — extrae req.user
├── config/
│   └── jwt.config.ts                ← registerAs('jwt'), assertSecret(), defaults
├── users/
│   ├── entities/user.entity.ts      ← Campo refreshTokenHash, isActive, role enum
│   └── users.service.ts             ← findOne(), clearRefreshToken(), saveRefreshHash()
└── valkey/
    └── valkey.module.ts             ← Proveedor ioredis, conexión lazy
```

---

## 13. Qué más deberías saber / preguntas frecuentes

### ¿Por qué no se usa RS256 en lugar de HS256?

RS256 (asimétrico) tiene sentido cuando varios servicios necesitan verificar tokens pero solo uno los firma — el secret de firma queda aislado. En una API monolítica donde el mismo proceso firma y verifica, HS256 es más simple y igual de seguro, siempre que el secret tenga suficiente entropía (aquí: mínimo 32 bytes = 256 bits).

### ¿Qué pasa si Valkey cae en producción?

El sistema funciona en "fail-open": la blocklist no se consulta, pero los tokens siguen validándose por firma y expiración. El riesgo es que tokens revocados (logout) sigan siendo válidos hasta su expiración natural (máximo 15 min). Para casos urgentes (cuenta comprometida), el campo `isActive = false` sí se verifica en cada request y no depende de Valkey.

### ¿Por qué se hashea el refresh token con Argon2 si es un JWT firmado?

Un JWT firmado con HMAC-SHA256 y un secret fuerte no se puede falsificar. Pero si la base de datos se filtra, el atacante obtendría tokens válidos y vivos (hasta 7 días). Al guardar el hash, el atacante solo obtiene hashes que no puede revertir eficientemente. El coste extra de un verify Argon2 en cada refresh es aceptable (es una operación poco frecuente).

### ¿El JTI se guarda en base de datos?

No. Solo vive en el payload del JWT. Solo pasa a la base de Valkey cuando el token se revoca (logout). Esto mantiene el sistema stateless en el happy path: login y requests autenticados no tocan Valkey ni la tabla de JTIs.

### ¿Puede un token de un entorno usarse en otro?

No, porque los claims `iss` (issuer) y `aud` (audience) se validan en cada request. Un token emitido por un servicio diferente (aunque tuviese el mismo secret) sería rechazado por tener `iss` distinto. Esto protege en arquitecturas multi-servicio.

### ¿Qué token hace qué exactamente?

```
Access Token  → "soy el usuario X, puedo hacer requests autenticados por 15 min"
Refresh Token → "puedo pedir un nuevo access token durante 7 días"
```

El refresh token no autentica requests normales. Si se intenta usar como Bearer token, falla porque su firma usa `JWT_REFRESH_SECRET`, distinto del `JWT_SECRET` que usa JwtStrategy.

### ¿Cómo se protege el access token de XSS?

El access token vive en memoria del cliente (variable JavaScript, nunca en `localStorage` ni `sessionStorage`). Si hay un ataque XSS, el script malicioso podría robarlo de memoria, pero no puede acceder al refresh token (HttpOnly). La ventana de ataque está acotada a 15 minutos.

### ¿Cuándo debería cambiar la expiración del access token?

- **Acortarla (< 15min):** si el sistema es de alta seguridad (finanzas, salud). Incrementa frecuencia de refreshes.
- **Alargarla (> 15min):** si los usuarios se quejan de sesiones que parecen cerrarse solas. Aumenta la ventana de exposición.
- **Regla general:** 5–15 min es el rango estándar para APIs de producción. 7 días para refresh token es conservador-normal; algunos sistemas usan 30 días.
