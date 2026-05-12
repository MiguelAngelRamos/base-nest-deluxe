# TTL (Time To Live) — Qué es y dónde lo usa este proyecto

---

## Tu definición — validada y con un matiz importante

> *El TTL es la "fecha de caducidad" de un dato en Valkey. Cuando le asignas un tiempo de vida (por ejemplo, 300 segundos), Valkey cuenta hacia atrás automáticamente y, cuando llega a cero, borra el dato sin que ningún programador escriba código de limpieza. Como el token también tiene fecha de expiración, el TTL en Valkey se calcula para que coincida exactamente — así, cuando el token ya no es válido, la "marca de bloqueo" en Valkey desaparece sola, manteniendo la memoria limpia.*

La definición es **correcta**. Hay un matiz que conviene subrayar para que la afirmación quede precisa:

- En este proyecto **no se usa un valor fijo como 300 segundos**. El TTL se calcula **dinámicamente en cada logout**: son los segundos exactos que le quedan al token hasta su `exp` natural. Por eso "coincide exactamente" — no porque alguien haya configurado el mismo número en dos sitios, sino porque el código lo deriva de la propia expiración del JWT en cada llamada.

El resto de la idea — Valkey cuenta hacia atrás solo, borra la clave automáticamente, no hace falta un cron de limpieza — describe con precisión cómo funciona el motor.

---

## El concepto, en una frase

> Cada clave en Valkey puede llevar incrustada su fecha de caducidad. El motor la borra solo cuando llega esa hora. La aplicación nunca tiene que recordar limpiar nada.

Mismo principio que aparece en otras capas que ya conoces:

| Contexto | Qué caduca | Quién lo elimina |
|---|---|---|
| DNS | Registros cacheados | El resolver al expirar |
| HTTP Cache | Respuestas (`Cache-Control: max-age`) | El navegador / proxy |
| JWT | El propio token (claim `exp`) | La librería de verificación |
| Valkey | Claves en memoria | El motor internamente |
| Cookies | La cookie (`Max-Age`) | El navegador |

---

## Dónde se usa TTL en este proyecto — análisis por líneas de código

El proyecto usa la palabra `ttl` o el concepto de "tiempo de vida" en **tres sitios distintos**, con dos significados diferentes que conviene no mezclar:

| Sitio | Tipo de TTL | Quién lo aplica |
|---|---|---|
| 1. Blocklist de access tokens en Valkey | TTL real de una clave en memoria | El motor Valkey |
| 2. Expiración del JWT (`expiresIn`) | Claim `exp` dentro del token firmado | `passport-jwt` al verificar |
| 3. Ventana del rate limiter (`@Throttle`) | Ventana de tiempo del contador | `ThrottlerGuard` de NestJS |

Las tres son aplicaciones del mismo principio — *el dato se invalida solo al cumplirse un plazo* — pero solo la primera es TTL "de Valkey" en sentido estricto. Las explico por orden.

---

### 1. TTL en Valkey — el caso del que parte tu pregunta

Este es el TTL del que hablas: el que mantiene la memoria limpia sin código de limpieza.

#### Escritura — al hacer logout

**Archivo y líneas:** [src/auth/auth.service.ts:170-201](src/auth/auth.service.ts#L170-L201)

```typescript
async logout(userId: string, accessToken: string): Promise<void> {
  // decode() extrae el payload sin verificar firma — el guard ya lo validó antes
  const decoded = this.jwtService.decode<{ jti?: string; exp?: number }>(accessToken);

  if (decoded?.jti && decoded?.exp) {
    // ── ESTA ES LA LÍNEA CLAVE ──
    // exp = timestamp Unix (segundos) en el que el token expira de forma natural.
    // Date.now() / 1000 = momento actual en segundos.
    // La diferencia es exactamente cuánto le queda de vida al token.
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);

    if (ttl > 0) {
      try {
        // SET key value EX ttl  → Valkey guarda la clave con TTL en segundos.
        // Cuando ttl llegue a 0, Valkey la borra solo. No hay job de limpieza.
        await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
      } catch (err) {
        this.logger.error(
          `Blocklist Valkey error en logout: ${(err as Error).message}`,
        );
      }
    }
  }
  // ...invalidación del refresh en DB (sigue ejecutándose aunque Valkey falle)
}
```

**Las líneas exactas que implementan tu definición:**

- [src/auth/auth.service.ts:182](src/auth/auth.service.ts#L182) — `const ttl = decoded.exp - Math.floor(Date.now() / 1000);`
  → cálculo dinámico del TTL: segundos restantes hasta la expiración del JWT.
- [src/auth/auth.service.ts:184](src/auth/auth.service.ts#L184) — `if (ttl > 0)`
  → guard contra tokens que llegan al logout justo en el momento de su expiración.
- [src/auth/auth.service.ts:187](src/auth/auth.service.ts#L187) — `set('blocklist:at:${decoded.jti}', '1', 'EX', ttl)`
  → escritura de la clave **con TTL incrustado** mediante el flag `EX`.

El parámetro `'EX'` es la pieza Valkey-específica de la ecuación: le dice al motor "esta clave debe desaparecer en *N* segundos". Sin ese argumento, la clave viviría indefinidamente y haría falta un proceso externo para limpiarla.

#### Lectura — en cada petición autenticada

**Archivo y líneas:** [src/auth/strategies/jwt.strategy.ts:73-89](src/auth/strategies/jwt.strategy.ts#L73-L89)

```typescript
try {
  const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
  if (blocked) {
    throw new UnauthorizedException('Token revocado');
  }
} catch (err) {
  if (err instanceof UnauthorizedException) throw err;
  this.logger.error(
    `Valkey blocklist check fallido — fail-open: ${(err as Error).message}`,
  );
}
```

Aquí no aparece la palabra `ttl` — pero el TTL trabaja de forma invisible: si el token ya expiró, su clave en Valkey **ya no está**, así que `GET` devuelve `null` y el `if (blocked)` no entra. El motor ya hizo la limpieza por nosotros.

#### Por qué el TTL es dinámico y no fijo

Si en lugar de `EX ttl` se usara `EX 900` (15 minutos siempre), la clave en Valkey duraría 15 minutos *desde el logout*, sin importar cuánto le quedaba al token. Un usuario que hace logout a falta de 1 minuto de expiración crearía una clave que vive 14 minutos más de lo necesario — basura acumulada.

Con el cálculo `decoded.exp - ahora`, **la clave en Valkey y el JWT mueren a la vez**:

```
Token emitido a las 10:00:00 con expiresIn = '15m'
  → exp = 10:15:00

Logout a las 10:14:00 (queda 1 minuto al token)
  → ttl = exp - ahora = 60 segundos
  → SET blocklist:at:{jti} "1" EX 60

A las 10:15:00:
  → JWT rechazado por exp (passport-jwt)  → 401 sin ni mirar Valkey
  → Clave en Valkey ya desapareció (TTL = 0)
  → Cero acumulación, cero limpieza manual
```

---

### 2. TTL en el JWT — el claim `exp`

El JWT lleva su propia "fecha de caducidad" dentro del payload firmado. No la gestiona Valkey, la gestiona la librería `passport-jwt` al verificar la firma.

**Configuración del access token — al emitir:**

[src/auth/auth.service.ts:230-242](src/auth/auth.service.ts#L230-L242)

```typescript
const accessOptions: JwtSignOptions = {
  // ...
  expiresIn: this.configService.getOrThrow<string>('jwt.expiration'), // '15m'
};

const refreshOptions: JwtSignOptions = {
  // ...
  expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiration'), // '7d'
};
```

**Configuración por defecto a nivel de módulo:**

[src/auth/auth.module.ts:33-65](src/auth/auth.module.ts#L33-L65) — el `JwtModule` arranca con `expiresIn` leído de `jwt.expiration` para todos los tokens firmados con `jwtService.sign()` que no sobreescriban la opción.

| Token | TTL del JWT | Variable de entorno |
|---|---|---|
| Access token | `15m` | `JWT_EXPIRATION` |
| Refresh token | `7d` | `JWT_REFRESH_EXPIRATION` |

Este TTL es el que alimenta al cálculo dinámico de la sección 1: el `decoded.exp` que aparece en `logout()` viene exactamente de `expiresIn: '15m'`.

---

### 3. TTL en el rate limiter — la ventana del contador

`ThrottlerModule` de NestJS también usa la palabra `ttl`, pero con otro significado: es el **ancho de la ventana de tiempo** sobre la que se cuentan las peticiones. No tiene nada que ver con Valkey.

**Configuración global:**

[src/app.module.ts:115-121](src/app.module.ts#L115-L121)

```typescript
ThrottlerModule.forRoot([
  {
    name: 'default',
    ttl: 60_000,   // 60 segundos
    limit: 60,     // 60 peticiones permitidas en esa ventana → 60 rpm
  },
]),
```

**Overrides por endpoint:**

| Endpoint | Línea | Ventana / Límite |
|---|---|---|
| `POST /auth/login` | [src/auth/auth.controller.ts:70](src/auth/auth.controller.ts#L70) | `ttl: 600_000, limit: 5` → 5 intentos por cada 10 min |
| `POST /auth/register` | [src/auth/auth.controller.ts:107](src/auth/auth.controller.ts#L107) | `ttl: 60_000, limit: 5` → 5 por minuto |
| `POST /auth/refresh` | [src/auth/auth.controller.ts:138](src/auth/auth.controller.ts#L138) | `ttl: 60_000, limit: 10` → 10 por minuto |

Conceptualmente sigue siendo "tiempo tras el cual algo se reinicia solo" — el contador de peticiones se resetea al cumplirse el TTL — pero no es el TTL de una clave en memoria sino la duración de una ventana deslizante.

---

## Resumen — los TTL del proyecto en una imagen

```
┌───────────────────────────────────────────────────────────────┐
│  Petición autenticada                                         │
│                                                               │
│  ┌──────────────┐   ┌────────────────────┐  ┌──────────────┐  │
│  │ TTL ventana  │ → │ TTL del JWT (exp)  │→ │ TTL Valkey   │  │
│  │ rate limit   │   │ 15m / 7d           │  │ blocklist    │  │
│  │ (Throttler)  │   │                    │  │ (dinámico)   │  │
│  └──────────────┘   └────────────────────┘  └──────────────┘  │
│         │                    │                       │        │
│  Filtra exceso       Caduca el token         Revoca antes     │
│  de tráfico          al cumplirse exp        de exp si hay    │
│                                              logout           │
└───────────────────────────────────────────────────────────────┘
```

**La pieza que describe tu definición es la tercera:** el TTL de Valkey, calculado en [src/auth/auth.service.ts:182](src/auth/auth.service.ts#L182) como `decoded.exp - Math.floor(Date.now() / 1000)` y aplicado en [src/auth/auth.service.ts:187](src/auth/auth.service.ts#L187) con `EX ttl`. Esa coincidencia exacta entre el TTL de Valkey y el `exp` del token es lo que mantiene la memoria limpia sin un solo job de limpieza en el código.
