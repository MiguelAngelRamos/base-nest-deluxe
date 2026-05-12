# Flujo completo JWT — De login a validación

---

## 1. El proceso de login paso a paso

El login empieza en el controller, pasa por una estrategia de Passport y termina firmando dos tokens.

### Paso 1 — El cliente envía las credenciales

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "usuario@clinica.com",
  "password": "MiPass123!"
}
```

### Paso 2 — El controller recibe la petición

**Archivo:** `src/auth/auth.controller.ts`

> **Nota sobre los decoradores:** el código real lleva además `@Throttle({ default: { ttl: 60_000, limit: 5 } })` (rate limiting: 5 intentos/min/IP), `@Public()` (este endpoint no exige token previo), `@HttpCode(HttpStatus.OK)` y varios `@ApiOperation` / `@ApiBody` / `@ApiResponse` para Swagger. Aquí se muestran solo los decoradores relevantes al flujo de autenticación; los demás se explican más adelante (`@Public()` en la sección de `JwtAuthGuard` global).

```typescript
@UseGuards(LocalAuthGuard)   // ← primero pasa por Passport Local
@Post('login')
async login(
  @Body() loginDto: LoginDto,
  @Res({ passthrough: true }) res: Response,
) {
  const tokens = await this.authService.login(
    loginDto.email,
    loginDto.password,
  );
  this.setRefreshCookie(res, tokens.refreshToken); // ← refresh va en cookie HttpOnly
  return {
    accessToken: tokens.accessToken, // ← access token va en el body
    user: tokens.user,
  };
}
```

---

#### ¿Qué significa `@Res({ passthrough: true }) res: Response`?

Esta línea tiene tres partes que trabajan juntas:

**`@Res()`** — decorator de NestJS que inyecta el objeto `Response` de Express directamente en el método. Por defecto, en cuanto usas `@Res()`, NestJS sale del camino y asume que **tú** vas a gestionar la respuesta completa — tienes que llamar `res.json(...)` o `res.send(...)` manualmente. Si haces `return { ... }` sin más, la respuesta nunca llega al cliente.

**`{ passthrough: true }`** — la opción que cambia ese comportamiento. Le dice a NestJS: *"quiero acceder al objeto `res` para setear cookies o headers, pero tú sigues gestionando la respuesta. El `return` del método lo serializas a JSON como siempre."* Sin este flag, el `return { accessToken, user }` del método no llegaría al cliente.

**`res: Response`** — el tipo de TypeScript importado de `'express'`. Da autocompletado para métodos como `res.cookie()`, `res.clearCookie()`, `res.redirect()`, etc.

**Resumen práctico:**

```typescript
// SIN passthrough — tienes que enviar tú la respuesta manualmente
async login(@Res() res: Response) {
  const tokens = await ...;
  res.cookie('refresh_token', tokens.refreshToken, { httpOnly: true });
  res.json({ accessToken: tokens.accessToken }); // ← obligatorio, si no el cliente no recibe nada
}

// CON passthrough — NestJS envía el return, tú solo tocas la cookie
async login(@Res({ passthrough: true }) res: Response) {
  const tokens = await ...;
  res.cookie('refresh_token', tokens.refreshToken, { httpOnly: true }); // ← solo lo que necesitas
  return { accessToken: tokens.accessToken }; // ← NestJS lo serializa y envía
}
```

En este proyecto se usa `passthrough: true` en `login`, `register`, `refresh` y `logout` porque todos necesitan manipular la cookie `refresh_token` sin perder el mecanismo automático de respuesta de NestJS.

---

### Paso 2.5 — ¿Qué es Passport Local? ¿Qué hace `LocalAuthGuard`?

Antes de entrar al body del método `login()`, la petición pasa por `@UseGuards(LocalAuthGuard)`. Para entender qué hace, hay que entender Passport.

**¿Qué es Passport?**

Passport es una librería de Node.js que estandariza la autenticación a través del concepto de **estrategias** (*strategies*). Cada estrategia sabe cómo extraer y verificar credenciales de un tipo concreto: `passport-local` sabe leer `email` y `password` del body; `passport-jwt` sabe leer un Bearer token del header. Tú defines *qué hacer con esas credenciales* en el método `validate()`, y Passport se encarga del resto.

En NestJS, Passport se integra vía `@nestjs/passport`. El patrón siempre es el mismo: un **Guard** activa una **Strategy**.

---

**Archivo:** `src/auth/guards/local-auth.guard.ts`

```typescript
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
```

`AuthGuard('local')` es una clase base de `@nestjs/passport`. El string `'local'` le dice a Passport qué estrategia tiene que ejecutar — la estrategia registrada con el nombre `'local'`. La clase no necesita ningún código propio porque todo el trabajo está en la estrategia.

Cuando NestJS encuentra `@UseGuards(LocalAuthGuard)` en un endpoint:
1. Llama a `canActivate()` del guard (heredado de `AuthGuard`).
2. `AuthGuard` invoca `passport.authenticate('local', ...)`.
3. Passport localiza la estrategia registrada como `'local'` — que es `LocalStrategy`.
4. Passport extrae `email` y `password` del body y los pasa a `LocalStrategy.validate()`.
5. Si `validate()` retorna un usuario, Passport lo adjunta a `req.user` y el guard permite el acceso.
6. Si `validate()` lanza una excepción, Passport devuelve `401` y el método del controlador **nunca se ejecuta**.

---

**Archivo:** `src/auth/strategies/local.strategy.ts`

```typescript
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {

  constructor(private readonly authService: AuthService) {
    // Por defecto passport-local espera los campos 'username' y 'password'.
    // Renombramos username → email porque nuestra API autentica por email.
    super({ usernameField: 'email' });
  }

  // Passport llama a validate() automáticamente con los valores del body.
  // Si retorna user → Passport lo adjunta a req.user → el handler se ejecuta.
  // Si lanza excepción → Passport responde 401 → el handler nunca se ejecuta.
  async validate(email: string, password: string) {
    const user = await this.authService.validateUser(email, password);

    if (!user) {
      // OWASP A07:2021 — Identification and Authentication Failures
      // Mensaje genérico intencional — no revelar si el email existe
      // o si solo la contraseña es incorrecta previene enumeración de cuentas.
      throw new UnauthorizedException('Credenciales inválidas');
    }

    return user; // ← este objeto llega a req.user en el controlador
  }
}
```

`PassportStrategy(Strategy, 'local')` registra esta clase como la estrategia `'local'`. Ese nombre es exactamente el string que usa `AuthGuard('local')` para encontrarla.

**Flujo completo de `@UseGuards(LocalAuthGuard)` hasta el body del método:**

```
POST /api/v1/auth/login
        │
        ▼
LocalAuthGuard.canActivate()
  └─ hereda de AuthGuard('local')
        │
        ▼
passport.authenticate('local')
  └─ busca la estrategia registrada como 'local' → LocalStrategy
        │
        ▼
passport-local extrae email y password del body de la petición
        │
        ▼
LocalStrategy.validate(email, password)
  ├── authService.validateUser() → null   →  throw UnauthorizedException → 401
  └── authService.validateUser() → User   →  return user → req.user = user
        │
        ▼
El handler login() se ejecuta — req.user contiene el usuario validado
```

---

### Paso 3 — `LocalStrategy` llama a `authService.validateUser()`

`LocalStrategy.validate()` delega la comprobación real de credenciales a `authService.validateUser()`. Este es el puente entre Passport y la lógica de negocio.

**Quién llama a quién:**

```
LocalStrategy.validate(email, password)
        │
        └─ llama a ──▶  authService.validateUser(email, password)
```

**Archivo:** `src/auth/strategies/local.strategy.ts` — el punto de entrada desde Passport

```typescript
async validate(email: string, password: string) {
  const user = await this.authService.validateUser(email, password);

  if (!user) {
    throw new UnauthorizedException('Credenciales inválidas');
  }

  return user;
}
```

**Archivo:** `src/auth/auth.service.ts` — donde ocurre la verificación real

```typescript
async validateUser(email: string, password: string): Promise<User | null> {
  // Busca el usuario en la base de datos por email
  const user = await this.usersService.findByEmail(email);

  // Si el usuario no existe o está desactivado, retorna null
  // sin indicar al atacante cuál de las dos condiciones falla —
  // mismo mensaje genérico para ambos casos (previene enumeración)
  if (!user || !user.isActive) {
    return null;
  }

  // argon2.verify() compara en tiempo constante el password recibido
  // contra el hash guardado en DB — evita timing attacks (OWASP A02:2025)
  const valid = await argon2.verify(user.passwordHash, password);

  if (!valid) return null;

  return user; // ← Passport lo adjunta a req.user
}
```

**Resultado:**
- Si `validateUser()` devuelve `null` → `LocalStrategy.validate()` lanza `UnauthorizedException` → Passport responde `401` → el método `login()` del controller no se ejecuta.
- Si devuelve el usuario → `LocalStrategy.validate()` lo retorna → Passport lo guarda en `req.user` → el método `login()` se ejecuta.

---

### Paso 4 — `authService.login()` llama a `issueTokens()`

Una vez que `validate()` permitió el acceso, el handler `login()` llama a `authService.login()`, que llama a `issueTokens()`.

#### Antes del código: las dos interfaces que aparecen en el método

**`JwtPayload`** — definida en `src/auth/strategies/jwt.strategy.ts`. Es la forma del payload que se firma dentro del access token:

```typescript
export interface JwtPayload {
  sub: string;   // userId — claim estándar de JWT (subject)
  email: string; // se incluye para evitar lookup en DB en cada request
  role: string;  // idem — usado por guards de autorización por rol
  jti: string;   // JWT ID — identificador único, prerequisito para blocklist
}
```

**`AuthTokens`** — definida en `src/auth/auth.service.ts`. Es la forma del objeto que devuelve el método al controlador:

```typescript
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: string;
  };
}
```

Importante: `AuthTokens` **nunca** incluye `passwordHash` ni `refreshTokenHash`. Es el objeto que el cliente recibe (filtrado, seguro).

---

**Archivo:** `src/auth/auth.service.ts` — método `issueTokens()`

```typescript
private async issueTokens(user: User): Promise<AuthTokens> {
  // El payload del ACCESS TOKEN incluye: userId, email, rol, y jti (ID único)
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    jti: randomUUID(), // ← identificador único por token, necesario para blocklist
  };

  // issuer y audience se leen una sola vez de la config y se reutilizan
  // en accessOptions y refreshOptions — los dos tokens deben llevar los
  // mismos claims 'iss' y 'aud' para que JwtStrategy los valide correctamente
  const issuer = this.configService.getOrThrow<string>('jwt.issuer');
  const audience = this.configService.getOrThrow<string>('jwt.audience');

  // Opciones del ACCESS TOKEN — secreto propio, expira en 15m
  const accessOptions = {
    secret: this.configService.getOrThrow<string>('jwt.secret'),
    expiresIn: this.configService.getOrThrow<string>('jwt.expiration'), // '15m'
    algorithm: 'HS256',
    issuer,
    audience,
  } as JwtSignOptions;

  // Opciones del REFRESH TOKEN — secreto DISTINTO, expira en 7d
  const refreshOptions = {
    secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
    expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiration'), // '7d'
    algorithm: 'HS256',
    issuer,
    audience,
  } as JwtSignOptions;

  // Firma del access token
  const accessToken = await this.jwtService.signAsync(payload, accessOptions);

  // Firma del refresh token — payload mínimo: solo sub (userId)
  const refreshToken = await this.jwtService.signAsync(
    { sub: user.id },
    refreshOptions,
  );

  // El refresh token se hashea con Argon2id y se guarda en DB.
  // Si la DB es robada, los tokens en texto plano no están ahí.
  const refreshTokenHash = await argon2.hash(refreshToken, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  await this.userRepository.update(user.id, { refreshTokenHash });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  };
}
```

### Paso 5 — Lo que recibe el cliente

```
HTTP Response 200

Body (JSON):
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ...",
  "user": { "id": "uuid", "email": "...", "role": "PATIENT" }
}

Set-Cookie: refresh_token=eyJhbGciOiJIUzI1...; 
            HttpOnly; Secure; SameSite=Strict; 
            Path=/api/v1/auth/refresh; 
            Max-Age=604800
```

> El refresh token **nunca aparece en el body**. Solo existe en la cookie `HttpOnly`, que JavaScript no puede leer — protección contra XSS.

---

### Paso 5.1 — De dónde salen los flags de la cookie (`setRefreshCookie` y `buildRefreshCookieOptions`)

Los flags `HttpOnly`, `Secure`, `SameSite=Strict`, `Path` y `Max-Age` que aparecen en la respuesta no son mágicos. El controller los construye en dos métodos privados que viven al final de `auth.controller.ts`.

**Archivo:** `src/auth/auth.controller.ts` — método `setRefreshCookie()`

```typescript
private setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    ...this.buildRefreshCookieOptions(),
    // maxAge solo aplica al setear la cookie (Set-Cookie con duración).
    // clearCookie lo ignora — por eso lo dejamos fuera del helper compartido.
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días en milisegundos
  });
}
```

**Archivo:** `src/auth/auth.controller.ts` — método `buildRefreshCookieOptions()`

```typescript
private buildRefreshCookieOptions() {
  // Lee NODE_ENV del config para decidir si la cookie exige HTTPS
  const env = this.configService.get<string>('app.nodeEnv');

  // secure = true en cualquier entorno que NO sea development o test.
  // Producción, staging y preview todos exigen HTTPS automáticamente.
  // Esto cierra el hueco de que un NODE_ENV mal configurado (ej. 'prod'
  // en lugar de 'production') hiciera viajar el refresh en HTTP plano.
  const secure = env !== 'development' && env !== 'test';

  return {
    httpOnly: true,                            // Inaccesible desde JS — anti-XSS
    secure,                                    // Solo HTTPS fuera de dev/test
    sameSite: 'strict' as const,               // Anti-CSRF — no se envía cross-site
    path: REFRESH_COOKIE_PATH,                 // '/api/v1/auth/refresh' — least privilege
  };
}
```

**¿Por qué se separó en dos métodos en lugar de uno solo?**

Porque hay **dos sitios** donde se manipula la cookie y los dos deben ser consistentes:

1. `setRefreshCookie()` — al hacer login, register o refresh.
2. `res.clearCookie(REFRESH_COOKIE, this.buildRefreshCookieOptions())` — al hacer logout.

El navegador identifica una cookie por la combinación `(nombre, dominio, path)`. Si setearas la cookie con `path: '/api/v1/auth/refresh'` pero al borrarla usaras `path: '/'`, el navegador **no la borraría** — son cookies distintas para él. Compartir las opciones en `buildRefreshCookieOptions()` garantiza que el set y el clear usen exactamente los mismos flags.

**¿Por qué `Path: /api/v1/auth/refresh` en lugar de `Path: /`?**

Por *least privilege* aplicado a cookies. La cookie del refresh token solo se necesita en el endpoint de renovación. Limitar el `Path` significa que el navegador la enviará **únicamente** cuando haga peticiones a `/api/v1/auth/refresh` — no en cada petición a la API. Reduce la superficie de exposición y mitiga riesgos en caso de bugs en otros endpoints. (OWASP A04 — Insecure Design.)

---

## 2. Cómo se envía el access token en cada petición

Una vez logueado, el cliente guarda el `accessToken` en memoria (NO en localStorage) y lo añade al header en cada petición.

### Ejemplo en Postman / curl

```http
GET /api/v1/users
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4ZmU...
```

### Ejemplo en JavaScript (fetch)

```javascript
const response = await fetch('/api/v1/users', {
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
});
```

### Ejemplo en JavaScript (Axios con interceptor automático)

```javascript
// Se configura una vez — luego todas las peticiones llevan el token solas
axios.interceptors.request.use((config) => {
  config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

// Si el servidor devuelve 401, el interceptor pide un nuevo token
axios.interceptors.response.use(null, async (error) => {
  if (error.response?.status === 401) {
    await axios.post('/api/v1/auth/refresh'); // cookie httpOnly se envía automáticamente
    return axios.request(error.config);      // reintenta la petición original
  }
});
```

> La cookie con el refresh token **se envía automáticamente** por el navegador al llamar a `/api/v1/auth/refresh`. El cliente no necesita gestionarla.

---

## 3. Cómo valida la API cada petición autenticada

Cada petición con `Authorization: Bearer ...` pasa por tres capas antes de llegar al controlador.

### Capa 1 — JwtAuthGuard (global)

**Archivo:** `src/auth/guards/jwt-auth.guard.ts`

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super(); }

  canActivate(context: ExecutionContext) {
    // Si el endpoint tiene @Public(), lo deja pasar sin token
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Para todo lo demás, delega a Passport con la estrategia 'jwt'
    return super.canActivate(context);
  }
}
```

**¿Por qué este guard se aplica a todos los endpoints sin ponerlo en cada controlador?**

Porque está registrado como **guard global** en `src/app.module.ts` usando el token especial `APP_GUARD` de NestJS:

**Archivo:** `src/app.module.ts` — sección `providers`

```typescript
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';

@Module({
  // ...
  providers: [
    // ThrottlerGuard — rate limiting global (60 req/min por IP por defecto)
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // JwtAuthGuard global — todo endpoint exige token válido por defecto.
    // Los endpoints públicos (login, register, refresh) se marcan con @Public().
    // Cierra el riesgo de crear un controller nuevo sin @UseGuards y dejarlo abierto.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule { }
```

`APP_GUARD` es un token de inyección de dependencias de NestJS. Al registrar una clase con ese token, NestJS la aplica **antes de cada handler** de toda la aplicación, como si hubieras puesto `@UseGuards(JwtAuthGuard)` en todos y cada uno de los controladores. Los endpoints que no necesitan token usan el decorator `@Public()` para saltar el guard.

---

### ¿Qué pasa cuando se ejecuta `return super.canActivate(context)`?

Esta es la línea que conecta el guard con Passport y con `JwtStrategy`. Veamos qué ocurre paso a paso:

```typescript
// En JwtAuthGuard:
return super.canActivate(context);
//     ↑
// Esto llama a AuthGuard('jwt').canActivate()
// que internamente ejecuta: passport.authenticate('jwt', ...)
```

`super.canActivate(context)` llama al método de la clase base `AuthGuard('jwt')`, que a su vez invoca `passport.authenticate('jwt')`. Passport busca la estrategia registrada con el nombre `'jwt'` — que es `JwtStrategy` — y ejecuta el siguiente flujo en dos fases:

**Fase 1 — Validaciones automáticas de `passport-jwt` (antes de llegar a tu código)**

El constructor de `JwtStrategy` configura qué tiene que hacer Passport automáticamente:

**Archivo:** `src/auth/strategies/jwt.strategy.ts` — constructor

```typescript
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    @Inject('VALKEY_CLIENT')
    private readonly valkeyClient: Redis,
  ) {
    const secret = configService.get<string>('jwt.secret');

    if (!secret) {
      throw new Error('JWT_SECRET no está definido en .env');
    }

    super({
      // Lee el token del header: Authorization: Bearer <token>
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),

      // false = los tokens expirados se rechazan con 401 automáticamente
      // sin llegar a validate()
      ignoreExpiration: false,

      // El secreto con el que se firmó el token — si la firma no coincide → 401
      secretOrKey: secret,

      // Bloquea ataques de algorithm confusion (alg:none, HS256/RS256 mix)
      // Solo acepta tokens firmados con HMAC-SHA256
      algorithms: ['HS256'],

      // Valida que el campo 'iss' del token sea esta API
      // Si un token de otra aplicación llega aquí → 401
      issuer: configService.getOrThrow<string>('jwt.issuer'),

      // Valida que el campo 'aud' del token sea el esperado
      // Si el token fue emitido para otro cliente → 401
      audience: configService.getOrThrow<string>('jwt.audience'),
    });
  }
```

Passport-jwt realiza estas comprobaciones **antes** de llamar a `validate()`. Si cualquiera falla, devuelve `401` directamente — tu código `validate()` nunca se ejecuta.

| Comprobación | ¿Qué valida? | Si falla |
|---|---|---|
| `fromAuthHeaderAsBearerToken()` | Que exista el header `Authorization: Bearer ...` | 401 |
| `secretOrKey` | Que la firma HMAC-SHA256 sea correcta | 401 |
| `ignoreExpiration: false` | Que el campo `exp` no haya pasado | 401 |
| `algorithms: ['HS256']` | Que `alg` en el header del token sea exactamente `HS256` | 401 |
| `issuer` | Que el campo `iss` coincida | 401 |
| `audience` | Que el campo `aud` coincida | 401 |

**Fase 2 — `validate()` — tu código, ejecutado solo si la Fase 1 pasó**

**Archivo:** `src/auth/strategies/jwt.strategy.ts` — método `validate()`

```typescript
// validate() recibe el payload ya decodificado y verificado por passport-jwt.
// Lo que retornemos aquí se convierte en req.user en el controlador.
async validate(payload: JwtPayload) {
  // Comprobación 1: el usuario sigue existiendo en DB y sigue activo.
  // Un usuario desactivado (soft delete, baja médica, etc.) no debe
  // poder usar su token aunque aún no haya expirado. OWASP A01.
  const user = await this.usersService.findOne(payload.sub);

  if (!user.isActive) {
    throw new UnauthorizedException('Usuario desactivado');
  }

  // Comprobación 2: el jti del token no está en la blocklist de Valkey.
  // Si está ahí, el usuario hizo logout y el token fue revocado explícitamente.
  // Fail-open deliberado: si Valkey no responde, dejamos pasar.
  // isActive sigue siendo la defensa principal — un usuario desactivado
  // no pasa aunque Valkey esté caído. OWASP A07:2021.
  try {
    const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
    if (blocked) {
      throw new UnauthorizedException('Token revocado');
    }
  } catch (err) {
    if (err instanceof UnauthorizedException) throw err;
    // Solo se absorben errores de infraestructura (Valkey caído, timeout)
    // Los errores de negocio (token revocado) se re-lanzan arriba
    this.logger.error(
      `Valkey blocklist check fallido — fail-open: ${(err as Error).message}`,
    );
  }

  // Este objeto pasa a ser req.user en todos los controladores protegidos
  return {
    id: user.id,
    email: user.email,
    role: user.role,
  };
}
```

---

### Resumen visual del flujo completo desde `super.canActivate(context)`

```
return super.canActivate(context)
        │
        ▼
AuthGuard('jwt').canActivate()
  └─ passport.authenticate('jwt', ...)
        │
        ▼
passport-jwt extrae el token del header Authorization: Bearer <token>
  └─ No hay header / no hay Bearer → 401
        │
        ▼
Verifica firma HMAC-SHA256 con JWT_SECRET
  └─ Firma inválida → 401
        │
        ▼
Verifica que exp no haya pasado
  └─ Token expirado → 401
        │
        ▼
Verifica algorithm === 'HS256'
  └─ algorithm confusion detectado → 401
        │
        ▼
Verifica issuer y audience
  └─ No coincide → 401
        │
        ▼
JwtStrategy.validate(payload)   ← tu código empieza aquí
  ├── usersService.findOne(sub) → !isActive → 401 Usuario desactivado
  ├── Valkey GET blocklist:at:{jti}
  │     └── "1" encontrado → 401 Token revocado
  └── Todo OK → retorna { id, email, role }
        │
        ▼
req.user = { id, email, role }
        │
        ▼
El controlador ejecuta la lógica de negocio
```

---

### Capa 2 — JwtStrategy (Passport valida firma, exp, iss, aud)

Ver la explicación completa en la sección anterior — "Fase 1" del constructor de `JwtStrategy`.

### Capa 3 — `validate()` comprueba estado del usuario y blocklist Valkey

Ver la explicación completa en la sección anterior — "Fase 2" del método `validate()` de `JwtStrategy`.

---

### ¿Qué pasa si Valkey está caído? — El bloque catch explicado

```typescript
} catch (err) {
  if (err instanceof UnauthorizedException) throw err;
  // Fail-open: si Valkey cae, el access token puede seguir pasando
  // El refresh token sigue bloqueado por la DB (refreshTokenHash = null)
  this.logger.error(`Valkey blocklist check fallido — fail-open`);
}
```

**La línea `if (err instanceof UnauthorizedException) throw err`**

No es obvia pero es crítica. Cuando se ejecuta `throw new UnauthorizedException('Token revocado')` *dentro* del `try`, esa excepción llega al `catch` como cualquier otro error. Sin este `if`, el `catch` la absorbería y la convertiría en un log silencioso — el token revocado pasaría como si no estuviera en la blocklist. Esta línea garantiza que los errores de negocio (token revocado) siempre se re-lanzan, y solo se absorben los errores de infraestructura (Valkey caído, timeout, conexión rechazada).

**Fail-open — ¿cuánto riesgo hay?**

| Situación cuando Valkey está caído | Qué ocurre |
|---|---|
| Token **nunca fue revocado** | Ningún impacto — el flujo normal no escribe ni lee blocklist |
| Token **revocado en logout** | Puede seguir siendo usado hasta que expire de forma natural |
| Atacante intenta usar el **refresh token** para renovar | Bloqueado por la DB — Valkey no interviene |

La ventana de riesgo real es el tiempo de vida **restante** del access token en el momento del fallo. Si el token expiraba en 15 minutos y el usuario hizo logout con 8 minutos de vida restante, el token queda "activo" esos 8 minutos máximo mientras Valkey está caído. Pasados esos 8 minutos, expira por sí solo y la blocklist deja de ser necesaria.

**Por qué el refresh token sigue bloqueado aunque Valkey esté caído**

El refresh token no se gestiona en Valkey. Se invalida escribiendo `refreshTokenHash = null` en la base de datos dentro de `logout()`. Esa operación ocurre **fuera del bloque `try/catch`** de Valkey, lo que significa que se ejecuta siempre, independientemente de si Valkey responde o no:

```typescript
async logout(userId: string, accessToken: string): Promise<void> {
  // ...
  try {
    await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
    //                                                               ↑
    //            puede fallar si Valkey está caído — se registra pero no lanza
  } catch (err) {
    this.logger.error(`Blocklist Valkey error en logout`);
    // No se re-lanza: la ejecución continúa hacia la línea siguiente
  }

  // Esta línea se ejecuta SIEMPRE — con Valkey funcionando o caído
  await this.userRepository.update(userId, { refreshTokenHash: null });
  //                                                              ↑
  //              El refresh queda bloqueado en DB sin importar qué pase en Valkey
}
```

La consecuencia: aunque Valkey falle y el access token existente pueda pasar temporalmente, el atacante **no puede obtener un nuevo access token** porque el refresh está bloqueado en DB y sin refresh no hay renovación posible. La cadena de emisión de nuevos tokens está cortada.

**Resumen del peor caso con Valkey caído durante un logout:**

```
Usuario hace logout
        │
        ├─ Valkey.SET falla  ←  Valkey caído
        │    └─ El jti NO queda en blocklist
        │    └─ El access token existente puede seguir pasando (máx. hasta expiración)
        │
        └─ DB: refreshTokenHash = null  ←  se ejecuta SIEMPRE
             └─ El refresh queda bloqueado

Atacante intenta renovar con el refresh token:
        │
        └─ refreshTokenHash es null en DB  →  401 inmediato
             └─ Sin opción de conseguir un nuevo access token

Atacante intenta usar el access token robado:
        │
        └─ Valkey.GET falla  ←  Valkey sigue caído
             └─ Fail-open: el request pasa
             └─ Ventana de riesgo: segundos/minutos hasta que el access expire
             └─ Una vez expirado: el ataque termina solo, sin acción manual
```

---

## 4. Qué pasa cuando el access token expira — renovación con refresh token

El cliente detecta el `401`, llama a `/auth/refresh`, y el servidor renueva el par.

### Petición de renovación

```http
POST /api/v1/auth/refresh
Cookie: refresh_token=eyJhbGciOiJIUzI1NiJ9...
(el navegador envía la cookie automáticamente por el path configurado)
```

### El controller verifica el refresh antes de ir a la DB

**Archivo:** `src/auth/auth.controller.ts` — método `refresh()`

```typescript
async refresh(
  @Req() req: Request,
  @Res({ passthrough: true }) res: Response,
) {
  // Express parsea la cookie en req.cookies gracias al middleware
  // cookie-parser. El cast es necesario porque el tipo Request por
  // defecto no incluye 'cookies' — lo añade el middleware en runtime.
  const cookies = (req as Request & {
    cookies?: Record<string, string>;
  }).cookies;
  const refreshToken = cookies?.[REFRESH_COOKIE];

  if (!refreshToken) {
    throw new UnauthorizedException('Refresh token no presente');
  }

  // Verifica firma y expiración con el secreto PROPIO del refresh
  // Si el token expiró (7 días) o la firma es inválida → 401 aquí mismo
  let payload: { sub: string };
  try {
    payload = await this.jwtService.verifyAsync(refreshToken, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      // Pineamos HS256 + iss + aud igual que en JwtStrategy — bloquea
      // algorithm confusion y rechaza tokens emitidos por otra API
      algorithms: ['HS256'],
      issuer: this.configService.getOrThrow<string>('jwt.issuer'),
      audience: this.configService.getOrThrow<string>('jwt.audience'),
    });
  } catch {
    throw new UnauthorizedException('Refresh token inválido o expirado');
  }

  // Si la firma es válida, va a la DB a verificar el hash y rotar
  const tokens = await this.authService.refreshToken(payload.sub, refreshToken);
  this.setRefreshCookie(res, tokens.refreshToken);
  return { accessToken: tokens.accessToken, user: tokens.user };
}
```

### `authService.refreshToken()` compara el hash y detecta reuso

**Archivo:** `src/auth/auth.service.ts` — método `refreshToken()`

```typescript
async refreshToken(userId: string, refreshToken: string): Promise<AuthTokens> {
  const user = await this.userRepository.findOne({ where: { id: userId } });

  if (!user || !user.isActive) {
    throw new UnauthorizedException('Refresh token inválido');
  }

  // Sin hash → el usuario hizo logout o la familia fue revocada por reuso
  if (!user.refreshTokenHash) {
    throw new UnauthorizedException('Refresh token inválido');
  }

  // Compara el token recibido con el hash guardado en DB (Argon2id)
  const valid = await argon2.verify(user.refreshTokenHash, refreshToken);

  if (!valid) {
    // El hash no coincide: alguien está usando un token ya rotado → posible robo
    // Revocamos la familia completa para forzar re-login en todos los dispositivos
    await this.userRepository.update(userId, { refreshTokenHash: null });
    throw new UnauthorizedException('Reuso de refresh token detectado. Sesión revocada.');
  }

  // Todo correcto → emite nuevo par y el refresh anterior queda inválido
  return this.issueTokens(user);
}
```

### Qué devuelve el servidor al renovar

```
HTTP Response 200

Body (JSON):
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9.NUEVO_PAYLOAD...",
  "user": { "id": "uuid", "email": "...", "role": "PATIENT" }
}

Set-Cookie: refresh_token=eyJhbGciOiJIUzI1NiJ9.NUEVO_REFRESH...;
            HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/refresh
```

---

## 5. Cuándo y cómo usa Valkey este proyecto

Valkey (compatible con Redis) se usa **únicamente para la blocklist de access tokens**. No almacena sesiones, usuarios ni ningún dato de negocio.

### Cuándo se escribe en Valkey — en el logout

**Archivo:** `src/auth/auth.service.ts` — método `logout()`

```typescript
async logout(userId: string, accessToken: string): Promise<void> {
  // decode() no verifica firma — el token ya fue validado por JwtAuthGuard
  const decoded = this.jwtService.decode<{ jti?: string; exp?: number }>(accessToken);

  if (decoded?.jti && decoded?.exp) {
    // TTL = segundos que le quedan al token hasta su expiración natural
    // La clave en Valkey se auto-elimina cuando el TTL llega a cero — sin acumulación
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);

    if (ttl > 0) {
      try {
        // ── OPERACIÓN 1: Escribir jti en Valkey ──────────────────────────
        // Clave namespaced: blocklist:at:{jti}  →  valor: "1"  →  TTL: segundos restantes
        // Puede fallar si Valkey está caído o con timeout
        await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
      } catch (err) {
        // Fail-open intencionado: el refresh se invalida igualmente (ver debajo)
        // El access token existente seguirá pasando hasta que expire de forma natural
        this.logger.error(`Blocklist Valkey error en logout: ${(err as Error).message}`);
        // No se re-lanza — la ejecución continúa hacia la operación 2
      }
    }
  }

  // ── OPERACIÓN 2: Nulificar refreshTokenHash en DB ────────────────────────
  // Esta línea está FUERA del try/catch de Valkey → se ejecuta SIEMPRE
  // Es la defensa principal: aunque Valkey falle, el usuario no puede renovar tokens
  await this.userRepository.update(userId, { refreshTokenHash: null });
}
```

Las dos operaciones son independientes a propósito. La operación 2 (DB) no depende del resultado de la operación 1 (Valkey). Si Valkey está caído, el logout sigue siendo efectivo: el refresh queda bloqueado en DB y la renovación de tokens se corta. El único riesgo aceptado es que el access token actual pueda seguir pasando durante su vida residual (máximo los minutos que le quedaban al token cuando se hizo logout).

### Cuándo se lee de Valkey — en cada petición autenticada

**Archivo:** `src/auth/strategies/jwt.strategy.ts` — método `validate()`

```typescript
const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
if (blocked) {
  throw new UnauthorizedException('Token revocado');
}
```

### Qué hay almacenado en Valkey y cómo consultarlo

| Clave | Valor | TTL |
|---|---|---|
| `blocklist:at:{jti}` | `"1"` | Segundos restantes del access token |

Solo existen claves de tokens que aún no han expirado. Cuando el TTL llega a cero, Valkey las borra automáticamente. No hay acumulación.

**Consultar Valkey desde la terminal:**

```bash
# Ver todas las claves de la blocklist
redis-cli KEYS "blocklist:at:*"

# Ver si un jti concreto está bloqueado
redis-cli GET "blocklist:at:550e8400-e29b-41d4-a716-446655440000"
# Devuelve: "1" si está bloqueado, (nil) si no existe o ya expiró

# Ver cuántos segundos le quedan a una clave
redis-cli TTL "blocklist:at:550e8400-e29b-41d4-a716-446655440000"
# Devuelve: número de segundos, -2 si no existe

# Ver todas las claves con su TTL de forma legible
redis-cli --scan --pattern "blocklist:at:*" | while read key; do
  echo "$key → TTL: $(redis-cli TTL "$key")s"
done
```

> Si usas Valkey en lugar de Redis directamente, el CLI es idéntico: `valkey-cli` en lugar de `redis-cli`. Los comandos son los mismos.

---

## 6. Resumen de dónde ocurre cada cosa

| Acción | Archivo | Método |
|---|---|---|
| Recibir credenciales | `auth.controller.ts` | `login()` |
| Activar Passport Local | `guards/local-auth.guard.ts` | `canActivate()` (heredado) |
| Extraer email/password del body | `strategies/local.strategy.ts` | `validate()` |
| Validar email + password | `auth.service.ts` | `validateUser()` |
| Firmar access + refresh token | `auth.service.ts` | `issueTokens()` |
| Guardar refresh hash en DB | `auth.service.ts` | `issueTokens()` |
| Setear cookie `refresh_token` | `auth.controller.ts` | `setRefreshCookie()` |
| Construir flags `HttpOnly/Secure/SameSite/Path` | `auth.controller.ts` | `buildRefreshCookieOptions()` |
| Leer configuración JWT | `config/jwt.config.ts` | — |
| Interceptar toda petición (global) | `app.module.ts` → `APP_GUARD` | — |
| Comprobar @Public() / delegar a Passport | `guards/jwt-auth.guard.ts` | `canActivate()` |
| Validar firma, exp, alg, iss, aud | `strategies/jwt.strategy.ts` | constructor (`super({...})`) |
| Verificar usuario activo | `strategies/jwt.strategy.ts` | `validate()` |
| Consultar blocklist Valkey | `strategies/jwt.strategy.ts` | `validate()` |
| Renovar tokens (refresh) | `auth.controller.ts` + `auth.service.ts` | `refresh()` + `refreshToken()` |
| Detectar reuso de refresh | `auth.service.ts` | `refreshToken()` |
| Bloquear token en Valkey | `auth.service.ts` | `logout()` |
| Invalidar refresh en DB | `auth.service.ts` | `logout()` |
