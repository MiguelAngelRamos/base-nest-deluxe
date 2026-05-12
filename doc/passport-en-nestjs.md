# Passport en NestJS — Qué es y cómo actúa en este proyecto

## 1. ¿De dónde viene Passport?

**Passport no es de NestJS.** Es una librería de Node.js que existe desde 2011 y que funciona en cualquier framework (Express, Fastify, etc.). Su único propósito es autenticar requests: dado un mecanismo de autenticación (contraseña, JWT, OAuth, etc.), Passport lo abstrae en algo llamado **estrategia**.

NestJS no reinventa la rueda: usa Passport tal cual mediante el paquete `@nestjs/passport`, que simplemente lo envuelve con decoradores e inyección de dependencias para que se integre limpiamente con el sistema de módulos y guards de NestJS.

```
Node.js          NestJS
──────────       ──────────────────────────────
passport         @nestjs/passport   ← wrapper oficial
passport-local   LocalStrategy      ← estrategia email/password
passport-jwt     JwtStrategy        ← estrategia Bearer tokens
```

Dependencias en este proyecto (`package.json`):

```json
"@nestjs/passport": "^11.0.5",
"passport":         "^0.7.0",
"passport-local":   "^1.0.0",
"passport-jwt":     "^4.0.1"
```

---

## 2. El concepto central: Strategy

Una **Strategy** en Passport responde a una sola pregunta: *¿cómo verifico que este request viene de quien dice ser?*

Cada estrategia tiene un método `validate()` que tú implementas. Passport se encarga de extraer las credenciales del request (del body, del header, de una cookie...) y llama a tu `validate()` con esas credenciales. Si `validate()` retorna algo, ese algo queda en `req.user`. Si lanza una excepción, Passport responde 401.

---

## 3. Las dos estrategias de este proyecto

### 3.1 LocalStrategy — email y contraseña

**Archivo:** `src/auth/strategies/local.strategy.ts`

```typescript
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly authService: AuthService) {
    // Le decimos que el campo "username" se llama "email" en el body
    super({ usernameField: 'email' });
  }

  async validate(email: string, password: string) {
    const user = await this.authService.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    return user;  // → adjuntado a req.user
  }
}
```

**Cómo actúa:**

```
POST /auth/login  { email: "a@b.com", password: "1234" }
        │
        ▼
LocalAuthGuard activa LocalStrategy
        │
        ▼
passport-local extrae email y password del body
        │
        ▼
        validate(email, password)
        │
        ├─ authService.validateUser() → busca user en DB
        │                             → argon2.verify(hash, password)
        │
        ├─ ✅ retorna user  → adjunta a req.user → handler ejecuta
        └─ ❌ lanza error   → Passport responde 401 automáticamente
```

El nombre `'local'` en `PassportStrategy(Strategy, 'local')` es el identificador de esta estrategia. Ese mismo nombre se usa al crear el guard.

---

### 3.2 JwtStrategy — Bearer tokens

**Archivo:** `src/auth/strategies/jwt.strategy.ts`

```typescript
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    @Inject('VALKEY_CLIENT')
    private readonly valkeyClient: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), // ← extrae el token del header
      ignoreExpiration: false,                                  // ← tokens expirados = 401
      secretOrKey:      secret,                                 // ← clave para verificar firma
      algorithms:       ['HS256'],                              // ← solo HS256 aceptado
      issuer:           configService.getOrThrow('jwt.issuer'), // ← valida claim "iss"
      audience:         configService.getOrThrow('jwt.audience'),// ← valida claim "aud"
    });
  }

  async validate(payload: JwtPayload) {
    // passport-jwt ya verificó firma, expiración, iss y aud
    // aquí añadimos verificaciones de negocio

    const user = await this.usersService.findOne(payload.sub);
    if (!user.isActive) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
    if (blocked) {
      throw new UnauthorizedException('Token revocado');
    }

    return { id: user.id, email: user.email, role: user.role }; // → req.user
  }
}
```

**Cómo actúa:**

```
GET /users  Authorization: Bearer eyJhbGci...
        │
        ▼
JwtAuthGuard activa JwtStrategy
        │
        ▼
passport-jwt extrae token del header Authorization
        │
        ▼
Verifica automáticamente:
  • Firma (HS256 con JWT_SECRET)
  • exp (expiración)
  • iss (issuer del .env)
  • aud (audience del .env)
  • algoritmo pinned a HS256
        │
        ▼
        validate(payload)
        │
        ├─ ¿usuario activo?        ── no → 401
        ├─ ¿jti en blocklist?      ── sí → 401
        └─ ✅ retorna { id, email, role } → req.user → handler ejecuta
```

El trabajo de Passport es la primera capa (firma, expiración, claims). Tu `validate()` añade la segunda capa (estado del usuario, blocklist de logout).

---

## 4. Guards — la puerta de entrada

Un **Guard** en NestJS es una clase que decide si un request puede pasar a su handler. Devuelve `true` (pasa) o `false`/excepción (bloquea).

`@nestjs/passport` proporciona `AuthGuard(nombreEstrategia)` — un guard que activa esa estrategia de Passport. El patrón en este proyecto es envolver ese guard en una clase propia:

### LocalAuthGuard

**Archivo:** `src/auth/guards/local-auth.guard.ts`

```typescript
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
```

Hereda todo de `AuthGuard('local')`. Solo añade un nombre semántico. Se usa únicamente en `POST /auth/login`.

### JwtAuthGuard

**Archivo:** `src/auth/guards/jwt-auth.guard.ts`

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;          // @Public() → salta JWT
    return super.canActivate(context);  // sin @Public() → activa JwtStrategy
  }
}
```

Este guard hace algo más: antes de activar Passport, lee el metadata del decorador `@Public()`. Si el endpoint lo tiene, deja pasar sin verificar nada. Si no lo tiene, delega a Passport (que ejecuta `JwtStrategy.validate()`).

---

## 5. El decorador @Public()

**Archivo:** `src/common/decorators/public.decorator.ts`

```typescript
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Es un decorador de metadata. Escribe el valor `true` con la clave `'isPublic'` en el handler o la clase donde se coloca. El `JwtAuthGuard` lo lee con el `Reflector` de NestJS.

```typescript
@Public()                    // ← escribe metadata "isPublic: true"
@Post('login')
async login() { ... }        // ← JwtAuthGuard lee el metadata → deja pasar
```

---

## 6. Guard global — default-deny

**Archivo:** `src/app.module.ts`

```typescript
providers: [
  {
    provide: APP_GUARD,
    useClass: JwtAuthGuard,  // ← registrado globalmente
  },
],
```

`JwtAuthGuard` se registra como `APP_GUARD` (guard a nivel de aplicación). Esto significa que **todos los endpoints del proyecto requieren JWT válido por defecto**, sin necesidad de poner `@UseGuards(JwtAuthGuard)` en cada controlador.

La consecuencia es un modelo **default-deny**: todo bloqueado excepto lo que explícitamente se abre con `@Public()`.

```
Todos los endpoints
        │
        ▼
   JwtAuthGuard (global)
        │
        ├─ ¿tiene @Public()? ── sí → pasa directamente
        │
        └─ no → Passport verifica JWT
                   │
                   ├─ ✅ válido → pasa con req.user cargado
                   └─ ❌ inválido → 401
```

---

## 7. Resumen de archivos y su rol

| Archivo | Qué hace |
|---|---|
| `src/auth/strategies/local.strategy.ts` | Verifica email + contraseña contra la DB (Argon2id) |
| `src/auth/strategies/jwt.strategy.ts` | Verifica token JWT + estado usuario + blocklist Valkey |
| `src/auth/guards/local-auth.guard.ts` | Activa LocalStrategy en el endpoint de login |
| `src/auth/guards/jwt-auth.guard.ts` | Activa JwtStrategy en todos los endpoints (excepto @Public) |
| `src/common/decorators/public.decorator.ts` | Marca endpoints que no requieren autenticación |
| `src/app.module.ts` | Registra JwtAuthGuard como guard global (APP_GUARD) |
| `src/auth/auth.module.ts` | Registra PassportModule, JwtModule y las dos estrategias |

---

## 8. Flujo completo de una request autenticada

```
Cliente                NestJS                  Passport              DB / Valkey
───────                ──────                  ────────              ───────────
GET /users
Authorization: Bearer <token>
        │
        ▼
  Middleware pipeline
        │
        ▼
  JwtAuthGuard.canActivate()
  ¿@Public()? No
        │
        ▼
  AuthGuard('jwt').canActivate()
        │
        ▼
  passport-jwt extrae token del header
        │
        ▼
  Verifica: firma + exp + iss + aud + alg
        │
        ▼
  JwtStrategy.validate(payload)
        │                                                     findOne(payload.sub) ──→ DB
        │                                                     ¿isActive?
        │                                                     GET blocklist:at:jti ──→ Valkey
        │
        ├─ ❌ cualquier check falla → UnauthorizedException → 401
        │
        └─ ✅ retorna { id, email, role }
               │
               ▼
         req.user = { id, email, role }
               │
               ▼
         UsersController.findAll()   ← handler ejecuta con req.user disponible
               │
               ▼
         200 OK + datos
```

---

## 9. Qué hace Passport vs. qué haces tú

| Quién | Qué hace |
|---|---|
| **Passport** | Extrae las credenciales del request (body, header, cookie) |
| **Passport** | Verifica la firma del JWT, expiración, issuer, audience, algoritmo |
| **Passport** | Llama a tu `validate()` con el payload ya limpio |
| **Passport** | Adjunta el retorno de `validate()` a `req.user` |
| **Passport** | Responde 401 automáticamente si `validate()` lanza excepción |
| **Tu código** | Implementas `validate()` con lógica de negocio (isActive, blocklist) |
| **Tu código** | Configuras qué extraer, qué verificar, qué secreto usar |
| **Tu código** | Decides qué endpoints requieren autenticación (`@Public()`, `APP_GUARD`) |

Passport es la infraestructura. Tu `validate()` es la política.
