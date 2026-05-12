# Bloque 2 — JWT: Access Token y Refresh Token

### 45 minutos — 09:30 a 10:15

---

## Parte A — ¿Qué es un JWT y qué contiene? (10 min)

Un JWT es un string que tiene exactamente tres partes separadas por puntos:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.
eyJzdWIiOiJ1dWlkLXVzdWFyaW8iLCJlbWFpbCI6Im1pZ3VlbEBjbGluaWNhLmNvbSIsInJvbGUiOiJwYXRpZW50IiwianRpIjoiYWJjLTEyMyJ9.
SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

```
PARTE 1 → Header   → algoritmo usado
PARTE 2 → Payload  → datos del usuario (claims)
PARTE 3 → Firma    → garantía criptográfica
```

**Lo crítico que los estudiantes deben entender:**

El payload **no está cifrado — está codificado en Base64**. Cualquier persona puede decodificarlo en https://jwt.io y leer su contenido. Lo que **no puede hacer** es modificarlo sin invalidar la firma, porque no tiene el secreto del servidor.

En este proyecto el payload del access token contiene exactamente esto:

```typescript
// src/auth/auth.service.ts — método issueTokens()
const payload: JwtPayload = {
  sub: user.id,       // UUID del usuario — identificador principal
  email: user.email,  // evita un DB lookup extra en algunos casos
  role: user.role,    // ADMIN | DOCTOR | PATIENT — para control de acceso
  jti: randomUUID(),  // JWT ID — identificador único de este token específico
};
```

**Pregunta para el aula:** ¿Por qué el payload lleva el `role` si podría consultarse desde la DB en cada request?

Respuesta esperada: porque evita un DB lookup adicional en los guards de roles. El rol viene firmado criptográficamente — si alguien lo modifica, la firma se invalida y el request es rechazado.

**Segunda pregunta:** ¿Para qué sirve el `jti`?

Respuesta esperada: es el identificador único de ese token específico. Permite al servidor referirse a un token concreto — por ejemplo para revocarlo en una blocklist sin esperar a que expire. Lo veremos en la Escena 4.

---

## Parte B — Dual token: por qué dos tokens con secretos distintos (10 min)

Este proyecto no usa un solo token — usa dos con propósitos completamente diferentes:

```typescript
// src/config/jwt.config.ts
export default registerAs('jwt', () => ({
  secret: assertSecret('JWT_SECRET', process.env.JWT_SECRET),
  expiration: process.env.JWT_EXPIRATION || '15m',

  refreshSecret: assertSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET),
  refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',

  //  ↑ dos secretos validados por separado (mínimo 32 caracteres)
  //    si alguno es débil en producción, el proceso falla al arrancar

  issuer: process.env.JWT_ISSUER   || 'clinic-api',
  audience: process.env.JWT_AUDIENCE || 'clinic-web',
}));
```

| | Access Token | Refresh Token |
|---|---|---|
| **Duración** | 15 minutos | 7 días |
| **Transporte** | Header `Authorization: Bearer` | Cookie `HttpOnly` |
| **Secreto** | `JWT_SECRET` | `JWT_REFRESH_SECRET` |
| **Payload** | sub + email + role + jti | solo sub |
| **Dónde vive** | Memoria RAM del cliente | Cookie del navegador |
| **Propósito** | Autorizar requests | Obtener nuevos access tokens |

**¿Por qué secretos separados?**

Si un atacante compromete `JWT_SECRET` puede forjar access tokens — pero no refresh tokens, porque están firmados con `JWT_REFRESH_SECRET`. La brecha queda contenida. Con un solo secreto, comprometerlo significa comprometer todo el sistema de autenticación.

**¿Por qué el refresh token en cookie HttpOnly y no en el body?**

```
Cookie HttpOnly → JavaScript NO puede leerla
                → XSS no puede robar el refresh token
                → el browser la envía automáticamente al path correcto

Body de respuesta → JavaScript SÍ puede leerla
                 → XSS puede robarla y exfiltrarla
```

El access token vive en memoria RAM — no en localStorage, no en sessionStorage. Si la página se cierra, desaparece. Eso es intencional.

---

## Parte C — Flujo completo de login hasta refresh (25 min)

Esta es la parte central. Vamos a seguir el código real del proyecto en cuatro escenas.

---

### ESCENA 1 — Login: el usuario se autentica

**Endpoint:** `POST /api/v1/auth/login`

```typescript
// src/auth/auth.controller.ts
@Public()                 // ← no requiere JWT, es el punto de entrada
@UseGuards(LocalAuthGuard) // ← LocalStrategy verifica email + contraseña
@Post('login')
@HttpCode(HttpStatus.OK)
async login(
  @Body() loginDto: LoginDto,
  @Res({ passthrough: true }) res: Response,
) {
  const tokens = await this.authService.login(
    loginDto.email,
    loginDto.password,
  );
  this.setRefreshCookie(res, tokens.refreshToken); // ← cookie se setea AQUÍ
  return {
    accessToken: tokens.accessToken,
    user: tokens.user,
  };
}
```

`@Public()` excluye al endpoint del guard global de JWT. `@UseGuards(LocalAuthGuard)` corre `LocalStrategy` que verifica email y contraseña antes de llegar al handler.

**Punto importante:** el controller recibe los tokens del servicio y es el responsable de **setear la cookie**. El servicio no sabe nada de cookies ni de `Response` — esa es una responsabilidad del controller.

Dentro del servicio:

```typescript
// src/auth/auth.service.ts — método login()
async login(email: string, password: string): Promise<AuthTokens> {
  this.logger.log(`Intento de login para: ${email}`);

  const user = await this.validateUser(email, password);

  if (!user) {
    this.logger.warn(`Login fallido para email: ${email}`);
    throw new UnauthorizedException('Credenciales inválidas');
  }

  return this.issueTokens(user);
}
```

**Punto importante para mencionar:** el mensaje de error es idéntico para "usuario no existe" y "contraseña incorrecta". Esto es intencional — si fueran mensajes distintos, un atacante podría confirmar qué emails están registrados. Se llama **enumeración de usuarios** y es una vulnerabilidad catalogada en OWASP.

Ahora `issueTokens()` — el corazón del sistema:

```typescript
// src/auth/auth.service.ts — método issueTokens()
private async issueTokens(user: User): Promise<AuthTokens> {

  // Payload del ACCESS TOKEN — lleva identidad completa + jti único
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    jti: randomUUID(),  // identificador único de este token específico
  };

  // Firma el access token — configService lee el secreto del .env
  const accessToken = await this.jwtService.signAsync(payload, {
    secret: this.configService.getOrThrow<string>('jwt.secret'),
    expiresIn: this.configService.getOrThrow<string>('jwt.expiration'), // '15m'
    algorithm: 'HS256',  // algoritmo pineado — cierra algorithm confusion attacks
    issuer: this.configService.getOrThrow<string>('jwt.issuer'),
    audience: this.configService.getOrThrow<string>('jwt.audience'),
  } as JwtSignOptions);

  // Firma el refresh token con SU secreto — diferente al del access token
  const refreshToken = await this.jwtService.signAsync(
    { sub: user.id },   // payload minimalista — solo el ID
    {
      secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
      expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiration'), // '7d'
      algorithm: 'HS256',
      issuer: this.configService.getOrThrow<string>('jwt.issuer'),
      audience: this.configService.getOrThrow<string>('jwt.audience'),
    } as JwtSignOptions,
  );

  // Hashea el refresh token con Argon2id antes de guardarlo en DB.
  // Nunca se guarda el token en texto plano — igual que las contraseñas.
  const refreshTokenHash = await argon2.hash(refreshToken, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  });

  // Persiste el hash usando el repositorio de TypeORM directamente
  await this.userRepository.update(user.id, { refreshTokenHash });

  // Retorna los dos tokens + datos públicos del usuario.
  // El controller recibirá refreshToken para meterlo en la cookie.
  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  };
}
```

**Detalles críticos:**

- `issueTokens` no recibe `res` ni sabe de cookies — eso es responsabilidad del controller.
- Los secretos se leen siempre con `configService.getOrThrow` — si no están definidos, el proceso falla antes de emitir el primer token.
- El método devuelve el refresh token en texto plano **solo para que el controller lo ponga en la cookie**. En DB ya viaja el hash.

**¿Por qué se hashea el refresh token en DB?**

Si la base de datos es comprometida, el atacante obtiene los hashes — no los tokens reales. Sin el token original no puede hacer refresh. Es exactamente el mismo principio que hashear contraseñas.

**¿Por qué el `path` de la cookie es `/api/v1/auth/refresh`?**

```typescript
// src/auth/auth.controller.ts — método setRefreshCookie()
res.cookie('refresh_token', token, {
  httpOnly: true,
  secure: ...,
  sameSite: 'strict',
  path: '/api/v1/auth/refresh', // ← solo viaja a este endpoint
  maxAge: 7 * 24 * 60 * 60 * 1000,
});
```

La cookie solo se adjunta automáticamente cuando el request va a ese path. Si el cliente hace `GET /api/v1/patients`, el browser **no adjunta la cookie** — el refresh token no viaja por la red innecesariamente.

---

### ESCENA 2 — Requests normales: usando el access token

Durante 15 minutos el cliente usa el access token para todos sus requests:

```
GET /api/v1/appointments
Headers:
  Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

El guard global intercepta cada request:

```typescript
// src/auth/guards/jwt-auth.guard.ts
canActivate(context: ExecutionContext) {
  // ¿Tiene el decorador @Public()? → dejar pasar sin verificar
  const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  if (isPublic) return true;

  // No es público → verificar JWT normalmente
  return super.canActivate(context);
}
```

Si el token pasa la verificación de firma, Passport ejecuta `validate()` en `JwtStrategy`. Este método tiene **dos capas de verificación en orden**:

```typescript
// src/auth/strategies/jwt.strategy.ts
async validate(payload: JwtPayload) {

  // CAPA 1 — ¿El usuario sigue activo en la DB?
  // DB lookup deliberado — si el admin desactiva al usuario,
  // este check lo detiene en el próximo request inmediatamente.
  const user = await this.usersService.findOne(payload.sub);

  if (!user.isActive) {
    throw new UnauthorizedException('Usuario desactivado');
  }

  // CAPA 2 — ¿El token fue revocado explícitamente en logout?
  // Consulta la blocklist en Valkey usando el jti del token.
  // Si el jti está en Valkey → el usuario ya hizo logout →
  // este token fue invalidado aunque su firma sea válida y no haya expirado.
  try {
    const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
    if (blocked) {
      throw new UnauthorizedException('Token revocado');
    }
  } catch (err) {
    // Fail-open deliberado: si Valkey no responde, dejamos pasar.
    // La Capa 1 (isActive) sigue siendo la defensa principal.
    if (err instanceof UnauthorizedException) throw err;
    this.logger.error(
      `Valkey blocklist check fallido — fail-open: ${(err as Error).message}`,
    );
  }

  // Todo válido → poblar req.user con la identidad verificada
  return {
    id: user.id,
    email: user.email,
    role: user.role,
  };
}
```

**Punto clave sobre las dos capas:**

```
CAPA 1 — isActive check     → ¿puede este usuario usar el sistema?
CAPA 2 — blocklist check    → ¿fue este token específico revocado?
```

Cada capa protege contra un escenario distinto. La Capa 1 protege contra usuarios desactivados por el admin. La Capa 2 protege contra tokens cuyo propietario ya hizo logout. Si Valkey se cae, la Capa 1 sigue activa — el sistema no queda desprotegido.

**Pregunta para el aula:** ¿Qué pasa si Valkey se cae en producción?

Respuesta esperada: el sistema continúa funcionando — fail-open deliberado. La blocklist queda temporalmente degradada, pero el `isActive` check sigue siendo la defensa principal. Un usuario desactivado no puede acceder aunque la blocklist esté caída. El error queda registrado en los logs.

---

### ESCENA 3 — Access token expirado: el refresh

Después de 15 minutos el access token expira. El cliente llama a:

**Endpoint:** `POST /api/v1/auth/refresh`

```typescript
// src/auth/auth.controller.ts
@Public()   // ← no lleva access token en el header
@Post('refresh')
@HttpCode(HttpStatus.OK)
async refresh(
  @Req() req: Request,                            // ← se extrae la cookie manualmente
  @Res({ passthrough: true }) res: Response,
) {
  // La cookie 'refresh_token' viene en req.cookies (cookie-parser)
  const refreshToken = req.cookies?.['refresh_token'];

  if (!refreshToken) {
    throw new UnauthorizedException('Refresh token no presente');
  }

  // CAPA 1 — verifica firma + expiración DEL REFRESH TOKEN aquí en el controller
  // Si el token está vencido (7 días pasados) → lanza error aquí
  // El servicio nunca llega a consultar la DB
  let payload: { sub: string };
  try {
    payload = await this.jwtService.verifyAsync(refreshToken, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      algorithms: ['HS256'],
      issuer: this.configService.getOrThrow<string>('jwt.issuer'),
      audience: this.configService.getOrThrow<string>('jwt.audience'),
    });
  } catch {
    throw new UnauthorizedException('Refresh token inválido o expirado');
  }

  // CAPA 2 — verifica el hash contra la DB (responsabilidad del servicio)
  const tokens = await this.authService.refreshToken(payload.sub, refreshToken);
  this.setRefreshCookie(res, tokens.refreshToken);
  return {
    accessToken: tokens.accessToken,
    user: tokens.user,
  };
}
```

**Punto importante:** la verificación de firma del refresh token ocurre **en el controller**, no en el servicio. El servicio recibe `(userId, refreshToken)` — el `userId` ya fue extraído del payload verificado.

En el servicio, la verificación es solo contra la DB:

```typescript
// src/auth/auth.service.ts — método refreshToken()
async refreshToken(userId: string, refreshToken: string): Promise<AuthTokens> {

  // Cargamos el usuario directo del repositorio para tener refreshTokenHash
  const user = await this.userRepository.findOne({ where: { id: userId } });

  if (!user || !user.isActive) {
    throw new UnauthorizedException('Refresh token inválido');
  }

  // refreshTokenHash es null → el usuario hizo logout (o fue revocado)
  if (!user.refreshTokenHash) {
    this.logger.warn(
      `Refresh sin hash activo para userId ${userId} — posible reuso post-logout`,
    );
    throw new UnauthorizedException('Refresh token inválido');
  }

  // Compara el refresh token recibido contra el hash guardado en DB
  const valid = await argon2.verify(user.refreshTokenHash, refreshToken);

  if (!valid) {
    // Hash no coincide → token viejo reutilizado — reuse detection.
    // Revocamos toda la familia para forzar nuevo login en todos los dispositivos.
    this.logger.error(`Refresh reuse detectado para userId ${userId}. Revocando familia.`);
    await this.userRepository.update(userId, { refreshTokenHash: null });
    throw new UnauthorizedException('Reuso de refresh token detectado. Sesión revocada.');
  }

  // Todo válido → emite un par nuevo y rota el hash en DB
  return this.issueTokens(user);
}
```

**El flujo visual completo:**

```
POST /auth/refresh
      │
      ▼
[CONTROLLER] jwtService.verifyAsync()  ← firma + expiración del RT
      │
      ├─ Token vencido (7d) → 401 aquí — el servicio no se toca
      │
      └─ Firma válida, no expirado → pasa al servicio con (userId, refreshToken)
                    │
                    ▼
            [SERVICIO] argon2.verify(hashEnDB, tokenRecibido)
                    │
                    ├─ refreshTokenHash es null → logout previo → 401
                    │
                    ├─ Hash no coincide → reuse detection → revoca familia → 401
                    │
                    └─ Hash coincide → issueTokens(user) → par nuevo → 200 OK
```

---

### ESCENA 4 — Logout: cerrar la sesión correctamente

**Endpoint:** `POST /api/v1/auth/logout`

Este endpoint **requiere** un access token válido en el header — sin él el sistema no sabe quién está haciendo logout ni qué token debe invalidar.

```typescript
// src/auth/auth.controller.ts
@UseGuards(JwtAuthGuard)   // ← SÍ requiere access token — NO tiene @Public()
@Post('logout')
@HttpCode(HttpStatus.NO_CONTENT)
async logout(
  @Req() req: Request & { user: { id: string } },
  @Res({ passthrough: true }) res: Response,
) {
  // Extrae el Bearer del header — ya fue validado por JwtAuthGuard
  const authHeader = req.headers['authorization'] ?? '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  await this.authService.logout(req.user.id, accessToken);
  res.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });
}
```

En el servicio, el logout hace **dos cosas en paralelo**:

```typescript
// src/auth/auth.service.ts — método logout()
async logout(userId: string, accessToken: string): Promise<void> {

  // ACCIÓN 1 — Agrega el jti del access token a la blocklist de Valkey
  // decode() no verifica firma — solo extrae el payload.
  // El token ya fue validado por JwtAuthGuard antes de llegar aquí.
  const decoded = this.jwtService.decode<{ jti?: string; exp?: number }>(accessToken);

  if (decoded?.jti && decoded?.exp) {
    // TTL = segundos que le quedan al token hasta su expiración natural.
    // La entrada en Valkey se auto-elimina al expirar — sin acumulación de datos.
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);

    if (ttl > 0) {
      try {
        await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
      } catch (err) {
        // Fail-open: el refresh se invalida igual en DB.
        // El access token quedará activo hasta su expiración natural (15min).
        this.logger.error(`Blocklist Valkey error en logout: ${(err as Error).message}`);
      }
    }
  }

  // ACCIÓN 2 — Invalida el refresh token en DB
  // Próximo intento de POST /auth/refresh → refreshTokenHash es null → 401
  await this.userRepository.update(userId, { refreshTokenHash: null });
  this.logger.log(`Logout para userId: ${userId}`);
}
```

**Lo que sucede exactamente al hacer logout:**

```
POST /auth/logout (con access token válido en el header)
      │
      ├─ ACCIÓN 1: jti del AT → SET blocklist:at:{jti} en Valkey (TTL = tiempo restante)
      │            → próximo request con ese AT → validate() lo detecta → 401 inmediato
      │
      └─ ACCIÓN 2: refreshTokenHash = null en DB
                   → próximo POST /auth/refresh → hash es null → 401 inmediato
```

**¿Por qué el TTL en Valkey es igual al tiempo restante del token?**

Porque después de que el token expire naturalmente ya no puede usarse — la firma lo rechazaría. Guardar la entrada en Valkey más allá de ese punto desperdiciaría memoria. Con `EX ttl` la entrada se auto-elimina exactamente cuando el token hubiera expirado de todos modos.

**¿Qué pasa si Valkey falla durante el logout?**

El refresh token se invalida igual en DB — eso nunca falla. Lo único que queda activo es el access token hasta su expiración de 15 minutos. Para un sistema clínico es un riesgo acotado y aceptable, mucho mejor que tumbar el logout completo por un fallo de infraestructura.

**Pregunta para el aula:** ¿Por qué `logout` NO tiene el decorador `@Public()` si también es un endpoint de auth?

Respuesta esperada: porque logout necesita saber quién está cerrando sesión. Sin un JWT válido en el header, el sistema no sabe a quién pertenece el `userId` ni qué access token debe agregar a la blocklist. El guard tiene que ejecutarse para extraer esa identidad del token antes de que llegue al servicio.

---

## Cierre del Bloque 2 — tabla resumen para el aula

```
ACCIÓN              ENDPOINT               TOKEN QUE USA
──────────────────────────────────────────────────────────
Login               POST /auth/login       ninguno (credenciales)
Request normal      GET  /cualquier/ruta   access token (header)
Renovar sesión      POST /auth/refresh     refresh token (cookie)
Logout              POST /auth/logout      access token (header)
```

```
CICLO DE VIDA COMPLETO:
Login → access token (15min) + refresh token (7d en cookie)
     → requests con access token
     → validate() verifica isActive + blocklist en cada request
     → access token expira → POST /auth/refresh → nuevo par
     → logout → AT bloqueado en Valkey + RT nulo en DB
     → refresh token expira → volver a login
```

```
DEFENSA EN PROFUNDIDAD — tres líneas que trabajan juntas:
isActive en DB      → revocación por desactivación de usuario
blocklist en Valkey → revocación por logout explícito
Argon2id en RT hash → protección si la DB es comprometida
```

---

## Errores comunes al implementar este patrón

| Error | Por qué es incorrecto |
|---|---|
| Setear la cookie dentro de `issueTokens()` | El servicio no debe depender de `Response` — eso rompe separación de responsabilidades y hace imposible llamar a `issueTokens` desde tests unitarios |
| Verificar el refresh token en el servicio | El servicio recibe datos ya verificados — la verificación de firma ocurre en el controller antes de llamar al servicio |
| Llamar a `login(loginDto, res)` desde el controller | La firma real es `login(email, password)` — el servicio solo maneja lógica, la cookie la setea el controller |
| Nombre de cookie inconsistente | La constante `REFRESH_COOKIE = 'refresh_token'` garantiza que `set`, `clear` y la lectura del request usen exactamente el mismo nombre |
| `argon2.hash()` sin opciones | Sin especificar `type: argon2.argon2id` la librería puede usar un tipo de Argon2 menos seguro — siempre pasar las opciones explícitamente |
