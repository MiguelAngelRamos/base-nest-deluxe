# Valkey — Qué es y qué hace en este proyecto

---

## ¿Qué es Valkey?

Valkey es una base de datos **en memoria** de clave-valor, de código abierto y alto rendimiento. Nació en 2024 como un fork comunitario de Redis, mantenido por la Linux Foundation, cuando Redis cambió su licencia a un modelo propietario. Valkey mantiene compatibilidad total con el protocolo y los comandos de Redis — cualquier cliente, librería o CLI que funcione con Redis funciona con Valkey sin modificaciones.

### Características fundamentales

**En memoria** — todos los datos viven en RAM. Las lecturas y escrituras son del orden de microsegundos, frente a los milisegundos de una base de datos relacional que opera sobre disco.

**Clave-valor** — el modelo de datos más simple posible: cada pieza de información se guarda bajo una clave (string) y se recupera por esa misma clave. No hay tablas, no hay relaciones, no hay SQL.

**TTL por clave** — cada clave puede tener un tiempo de vida (*Time To Live*). Cuando el TTL llega a cero, Valkey elimina la clave automáticamente sin que ningún proceso externo tenga que hacerlo. Este mecanismo es especialmente útil para datos que tienen caducidad natural, como tokens o sesiones.

**Persistencia opcional** — por defecto opera en modo puramente en memoria, pero puede configurarse para volcar datos a disco periódicamente (RDB snapshots) o registrar cada operación en un log (AOF). Para casos de uso como blocklists de tokens, la persistencia no es necesaria: si el servidor se reinicia, los tokens caducan por sí solos o el usuario hace login de nuevo.

**Atomic operations** — comandos como `SET`, `GET`, `DEL`, `INCR` son atómicos. En un servidor con múltiples peticiones concurrentes, no hay condiciones de carrera en operaciones individuales.

### Casos de uso habituales

| Caso de uso | Por qué encaja |
|---|---|
| Caché de respuestas de API | Evita consultas repetidas a la DB — respuesta en microsegundos |
| Gestión de sesiones | TTL automático, lecturas rápidas en cada petición |
| Rate limiting / throttling | Contadores atómicos por IP con ventana de tiempo |
| Blocklist de tokens JWT | TTL sincronizado con la expiración del token |
| Colas de tareas | Estructuras de datos como listas y sorted sets |
| Pub/Sub | Mensajería entre microservicios en tiempo real |

### Compatibilidad con Redis

Valkey implementa el mismo protocolo RESP (*REdis Serialization Protocol*). Esto significa que:

- El CLI `redis-cli` funciona contra un servidor Valkey sin ningún cambio.
- Las librerías de cliente como `ioredis`, `redis` (npm), `Jedis` (Java), `StackExchange.Redis` (.NET) funcionan contra Valkey directamente.
- Todos los comandos — `SET`, `GET`, `DEL`, `EXPIRE`, `TTL`, `KEYS`, `SCAN`, etc. — son idénticos.

---

## Qué hace Valkey en este proyecto

En esta API, Valkey tiene **un único propósito**: la **blocklist de access tokens JWT**.

No almacena sesiones de usuario, no hace caché de queries, no gestiona colas. Es una pieza quirúrgica enfocada en resolver un problema específico de seguridad.

### El problema que resuelve

Los access tokens JWT son **stateless** por diseño: el servidor los firma y luego los valida comprobando únicamente la firma y la fecha de expiración. No hay ningún estado en servidor que diga "este token sigue siendo válido". Esto es una ventaja de escalabilidad, pero genera un problema cuando un usuario hace **logout**: el token sigue siendo criptográficamente válido hasta que expira de forma natural (15 minutos en este proyecto).

Si un atacante intercepta un access token antes del logout, puede seguir usándolo esos 15 minutos aunque el usuario ya haya cerrado sesión. Valkey cierra esa ventana.

### Cómo funciona la blocklist

El mecanismo se basa en el campo `jti` (*JWT ID*) que lleva cada access token. Es un UUID único generado en el momento de firmar el token, incluido en el payload. Cuando el usuario hace logout, ese `jti` se escribe en Valkey con un TTL igual al tiempo de vida restante del token.

**Escritura — en el logout:**

**Archivo:** `src/auth/auth.service.ts` — método `logout()`

```typescript
// decode() extrae el payload sin verificar firma — el guard ya lo validó antes
const decoded = this.jwtService.decode<{ jti?: string; exp?: number }>(accessToken);

// Guard 1: si decode devolviera null o un payload sin estos campos no
// podemos calcular TTL ni identificar el token — saltamos la escritura
if (decoded?.jti && decoded?.exp) {
  // TTL = segundos hasta la expiración natural del token
  const ttl = decoded.exp - Math.floor(Date.now() / 1000);

  // Guard 2: si el token ya expiró (ttl <= 0) no tiene sentido bloquearlo —
  // passport-jwt lo rechazará por su claim exp en el siguiente uso
  if (ttl > 0) {
    try {
      // Escribe el jti en Valkey con TTL = vida restante del token
      await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
    } catch (err) {
      // Fail-open: si Valkey está caído, el SET falla pero el logout NO se aborta.
      // La invalidación del refresh en DB (más abajo en logout) sigue ejecutándose.
      this.logger.error(`Blocklist Valkey error en logout: ${(err as Error).message}`);
    }
  }
}
```

La clave tiene un namespace propio (`blocklist:at:`) para evitar colisiones con otras posibles claves futuras. El valor es simplemente `"1"` — lo que importa es la existencia de la clave, no su valor. El TTL garantiza que cuando el token habría expirado de todas formas, la clave desaparece sola de Valkey sin acumulación.

Las dos líneas defensivas (`if (decoded?.jti && decoded?.exp)` y `if (ttl > 0)`) cubren casos extremos: un token corrupto pasado a `decode()` o un token que llegue al logout justo en el momento de su expiración. El `try/catch` implementa el **fail-open** que veremos en la sección "Comportamiento cuando Valkey no está disponible".

**Lectura — en cada petición autenticada:**

**Archivo:** `src/auth/strategies/jwt.strategy.ts` — método `validate()`

```typescript
// Se ejecuta después de que passport-jwt verifica firma, expiración, iss y aud
try {
  const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
  if (blocked) {
    throw new UnauthorizedException('Token revocado');
  }
} catch (err) {
  // Línea crítica — re-lanzamos los errores de NEGOCIO (token revocado).
  // Sin este `if`, el catch los tragaría junto con los errores de infraestructura
  // y un token revocado pasaría como si la blocklist estuviera vacía.
  if (err instanceof UnauthorizedException) throw err;
  // Solo absorbemos errores de INFRAESTRUCTURA (Valkey caído, timeout) → fail-open
  this.logger.error(`Valkey blocklist check fallido — fail-open: ${(err as Error).message}`);
}
```

En el camino normal (usuario sin logout activo), la clave no existe y `GET` devuelve `null` — el token pasa. Solo si el usuario hizo logout antes de que el token expire, la clave existe y la petición se rechaza con `401`.

El `try/catch` implementa la lógica de **fail-open**: si Valkey está caído, el `GET` lanza un error de infraestructura que el catch absorbe y deja pasar el token. Pero los errores de negocio (`UnauthorizedException` por token revocado) se re-lanzan explícitamente — esa distinción la hace la línea `if (err instanceof UnauthorizedException) throw err`.

### Qué hay dentro de Valkey en este proyecto

| Clave | Valor | Cuándo se crea | Cuándo desaparece |
|---|---|---|---|
| `blocklist:at:{jti}` | `"1"` | En `logout()` | Cuando el TTL llega a 0 (expiración natural del token) |

Nada más. No hay usuarios, no hay sesiones, no hay datos de negocio.

### Cómo está configurado y conectado

**Configuración de la conexión:**

**Archivo:** `src/config/valkey.config.ts`

```typescript
export default registerAs('valkey', () => ({
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: Number.parseInt(process.env.VALKEY_PORT || '6379', 10),
  password: process.env.VALKEY_PASSWORD || undefined,
}));
```

Las variables de entorno que controlan la conexión son:

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `VALKEY_HOST` | `127.0.0.1` | Host del servidor Valkey |
| `VALKEY_PORT` | `6379` | Puerto (mismo que Redis por defecto) |
| `VALKEY_PASSWORD` | — | Contraseña si el servidor la requiere |

**Módulo de conexión:**

**Archivo:** `src/valkey/valkey.module.ts`

```typescript
@Global()
@Module({
  providers: [
    {
      provide: 'VALKEY_CLIENT',   // ← token de inyección de dependencias
      inject: [ConfigService],
      useFactory: async (cs: ConfigService) => {
        // Logger con contexto propio — facilita filtrar logs de Valkey
        // en producción mediante el campo "context" que añade NestJS.
        const logger = new Logger('ValkeyClient');

        // Lectura de la config 'valkey.*' definida en valkey.config.ts.
        // getOrThrow lanza si falta una variable obligatoria — fail-fast en arranque.
        const host = cs.getOrThrow<string>('valkey.host');
        const port = cs.getOrThrow<number>('valkey.port');
        const password = cs.get<string>('valkey.password');

        // lazyConnect: true — el cliente NO conecta dentro del constructor.
        // Permite controlar el momento del connect() y manejar el fallo
        // sin que ioredis tire una excepción no manejable durante el arranque.
        const client = new Redis({ host, port, password, lazyConnect: true });

        // Listener de errores POST-arranque (desconexiones, timeouts, etc.).
        // Sin esto, ioredis emite estos errores como 'error' events y si
        // nadie los escucha, Node los convierte en unhandled rejection
        // y puede caer el proceso entero. OWASP A09:2021 — observabilidad.
        client.on('error', (err: Error) => {
          logger.error(`Valkey error: ${err.message}`);
        });

        // Fail-open en arranque: si Valkey no está disponible la app inicia
        // igualmente — la blocklist queda degradada pero isActive sigue
        // siendo la defensa principal. Cualquier comando posterior que falle
        // en services/strategies se captura allí. OWASP A09:2021.
        try {
          await client.connect();
          logger.log(`Valkey conectado en ${host}:${port}`);
        } catch {
          logger.error(
            `Valkey no disponible al arrancar (${host}:${port}) — operando sin blocklist`,
          );
        }

        return client;
      },
    },
  ],
  exports: ['VALKEY_CLIENT'],
})
export class ValkeyModule {}
```

El decorador `@Global()` hace que el módulo sea visible en toda la aplicación sin necesidad de importarlo en cada módulo que lo use. El cliente se inyecta por token en `AuthService` y `JwtStrategy` usando `@Inject('VALKEY_CLIENT')`.

La librería usada para conectar es **ioredis**, que es compatible con Valkey porque habla el mismo protocolo RESP.

**Tres detalles de robustez que merecen atención:**

1. **`lazyConnect: true`** — sin esta opción, `new Redis(...)` intentaría conectar inmediatamente y, si Valkey está caído, lanzaría una excepción dentro del constructor que no podríamos capturar limpiamente. Con `lazyConnect`, la conexión se difiere a `client.connect()`, que sí podemos envolver en `try/catch`.

2. **`client.on('error', ...)`** — ioredis emite un evento `'error'` cada vez que hay un problema en runtime (Valkey se reinicia, la red falla, etc.). Si **nadie** escucha ese evento, Node.js lo convierte en *unhandled rejection* y, dependiendo de la versión y configuración, puede tirar el proceso entero. Este listener captura esos errores y los registra en el logger sin abortar la app.

3. **`getOrThrow` vs `get`** — `host` y `port` son obligatorios (la app no puede funcionar sin saber dónde está Valkey), por eso usan `getOrThrow`. `password` es opcional (un Valkey local en desarrollo puede no exigir contraseña), por eso usa `get` que devuelve `undefined` si no está definida.

### Comportamiento cuando Valkey no está disponible — Fail-open

El diseño del proyecto asume que Valkey es infraestructura auxiliar, no crítica. Si Valkey está caído o no responde:

1. La aplicación **arranca igualmente** — el `try/catch` del módulo absorbe el error de conexión.
2. En cada petición, el `try/catch` en `JwtStrategy.validate()` absorbe el error de `GET` y deja pasar el token (**fail-open**).
3. En cada logout, el `try/catch` en `AuthService.logout()` absorbe el error de `SET` pero **siempre ejecuta** la invalidación del refresh token en la base de datos.

La consecuencia del fail-open es que, si Valkey cae durante el tiempo en que un usuario tiene un token revocado en la blocklist, ese token puede volver a ser aceptado hasta que expire de forma natural. La ventana de riesgo es el tiempo de vida restante del token en el momento de la caída (máximo 15 minutos).

Lo que **no** se degrada aunque Valkey esté caído: la invalidación del refresh token en PostgreSQL. Sin refresh token válido, el atacante no puede conseguir nuevos access tokens aunque el actual siga pasando temporalmente.

```
Valkey caído
    │
    ├── Access token revocado puede pasar  →  riesgo: minutos hasta expiración
    │
    └── Refresh token bloqueado en DB      →  sin renovación posible → ataque muere solo
```

### Resumen del ciclo de vida de una clave en Valkey

```
1. Usuario hace login
        │
        └── Valkey: sin entrada para este token (nunca se escribe al login)

2. Usuario opera normalmente durante 15 minutos
        │
        └── Valkey: GET blocklist:at:{jti} → (nil) → token aceptado en cada petición

3. Usuario hace logout antes de que expire el token
        │
        └── Valkey: SET blocklist:at:{jti} "1" EX {segundos_restantes}
                       ← clave creada con TTL

4. Alguien intenta usar el token después del logout
        │
        └── Valkey: GET blocklist:at:{jti} → "1" → 401 Token revocado

5. El TTL llega a 0 (el token habría expirado de todas formas)
        │
        └── Valkey: elimina la clave automáticamente — sin acumulación
```

---

## TTL — Qué es y cómo lo usa este proyecto

### Definición general

TTL (*Time To Live*) es el tiempo de vida asignado a un recurso. Cuando ese tiempo llega a cero, el recurso se considera caducado y se elimina o rechaza automáticamente, sin intervención manual.

El concepto aparece en múltiples capas de la informática con el mismo significado esencial:

| Contexto | Qué caduca | Quién lo elimina |
|---|---|---|
| DNS | Registros cacheados | El resolver DNS al expirar |
| HTTP Cache | Respuestas cacheadas (`Cache-Control: max-age`) | El navegador o proxy |
| JWT | El propio token (claim `exp`) | La librería de verificación |
| Redis / Valkey | Claves en memoria | El motor internamente |
| Cookies | La cookie (`Max-Age`) | El navegador |

En todos los casos el principio es el mismo: el dato tiene una fecha de caducidad incorporada y el sistema la hace cumplir solo, sin que ningún proceso externo tenga que recorrer y limpiar datos viejos.

En Valkey, el TTL se establece al crear una clave con el parámetro `EX` (segundos) o `PX` (milisegundos):

```bash
SET clave valor EX 300   # la clave desaparece en 300 segundos (5 minutos)
```

El comando `TTL` permite consultar cuántos segundos le quedan:

```bash
TTL clave   # devuelve los segundos restantes
            # -1 si no tiene TTL configurado
            # -2 si la clave no existe (ya expiró o nunca existió)
```

Valkey gestiona los TTL con un mecanismo híbrido: comprueba la expiración en el momento de cada acceso (*lazy expiration*) y recorre periódicamente las claves expiradas para liberarlas de memoria (*active expiration*). El resultado desde fuera es que la clave desaparece cuando su TTL llega a cero, sin ningún coste operacional para la aplicación.

---

### Cómo usa TTL este proyecto

Este proyecto usa TTL en dos capas independientes: dentro del propio JWT y en las claves de Valkey.

#### TTL en el JWT — la expiración del token

Cada token que firma `issueTokens()` lleva el claim `exp` en su payload. Es un timestamp Unix (segundos desde 1970) que indica cuándo expira. La librería `passport-jwt` lo comprueba automáticamente en cada petición — si `exp` ya pasó, devuelve `401` sin llegar siquiera a `validate()`.

**Archivo:** `src/auth/auth.service.ts` — dentro de `issueTokens()`

> **Recorte enfocado:** este snippet muestra solo el campo `expiresIn`, que es lo relevante para la sección de TTL. La versión completa con `secret`, `algorithm`, `issuer`, `audience` y la firma de los tokens está documentada en `flujo-completo-jwt.md` → sección "Paso 4 — `issueTokens()`".

```typescript
const accessOptions: JwtSignOptions = {
  // ...resto de opciones (secret, algorithm, issuer, audience)
  expiresIn: this.configService.getOrThrow<string>('jwt.expiration'), // '15m'
};

const refreshOptions: JwtSignOptions = {
  // ...resto de opciones (secret distinto al de access, algorithm, issuer, audience)
  expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiration'), // '7d'
};
```

| Token | TTL configurado | Variable de entorno |
|---|---|---|
| Access token | `15m` (15 minutos) | `JWT_EXPIRATION` |
| Refresh token | `7d` (7 días) | `JWT_REFRESH_EXPIRATION` |

El access token tiene vida corta a propósito: si es interceptado, el atacante solo tiene 15 minutos para usarlo. El refresh token dura más porque no viaja en cada petición — solo se envía al endpoint `/auth/refresh` a través de una cookie `HttpOnly` con `SameSite=Strict`.

---

#### TTL en Valkey — la blocklist de access tokens

Cuando el usuario hace logout, el `jti` de su access token se escribe en Valkey **con un TTL calculado dinámicamente**: los segundos exactos que le quedan al token hasta su expiración natural.

**Archivo:** `src/auth/auth.service.ts` — método `logout()`

```typescript
const decoded = this.jwtService.decode<{ jti?: string; exp?: number }>(accessToken);

if (decoded?.jti && decoded?.exp) {
  // exp es un timestamp Unix en segundos. Date.now() / 1000 es el momento actual.
  // La diferencia es exactamente el tiempo que le queda al token.
  const ttl = decoded.exp - Math.floor(Date.now() / 1000);

  if (ttl > 0) {
    try {
      await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
      //                                                                  ↑
      //                                      TTL en segundos — calculado dinámicamente
    } catch (err) {
      this.logger.error(`Blocklist Valkey error: ${(err as Error).message}`);
    }
  }
}
```

> El cálculo `decoded.exp - Math.floor(Date.now() / 1000)` es el corazón de esta sección. Los `if/try/catch` que lo envuelven son los mismos que ya vimos en la sección "Cómo funciona la blocklist" — se mantienen aquí para que el código sea funcional, no para introducir lógica nueva.

**Por qué el TTL se calcula dinámicamente y no se usa un valor fijo como `900` (15 min):**

Si se usara siempre `EX 900`, la clave en Valkey duraría 15 minutos desde el momento del logout, sin importar cuánto le quedara al token. Si el usuario hace logout a los 14 minutos de vida del token (le queda 1 minuto), la clave en Valkey duraría 15 minutos innecesariamente — 14 minutos más de lo que hace falta.

Con el cálculo `decoded.exp - ahora`, la clave en Valkey y el token JWT expiran **exactamente al mismo tiempo**. Cuando el token ya no puede ser usado (por `exp`), la clave en Valkey ya desapareció. No hay acumulación de entradas obsoletas.

```
Ejemplo concreto:

Token emitido a las 10:00:00 con expiresIn = '15m'
  → exp = timestamp de las 10:15:00

Usuario hace logout a las 10:14:00 (le queda 1 minuto al token)
  → ttl = exp - ahora = 60 segundos
  → SET blocklist:at:{jti} "1" EX 60

A las 10:15:00:
  → El JWT ya no pasa la validación de exp  →  401 automático
  → La clave en Valkey ya desapareció (TTL = 0)
  → Valkey limpio, sin entradas obsoletas
```

---

#### Relación entre los dos TTL

Los dos TTL trabajan como capas de defensa complementarias:

```
Token emitido
    │
    ├── TTL 1: claim exp en el JWT  (gestionado por passport-jwt)
    │     └── Token expirado → 401 automático sin consultar Valkey
    │
    └── TTL 2: clave en Valkey  (gestionado por el motor Valkey)
          └── Token revocado en logout → 401 aunque exp no haya pasado aún
```

El TTL del JWT es el límite superior: ningún token puede vivir más de 15 minutos sin importar nada más. El TTL de Valkey es la revocación anticipada: permite invalidar un token antes de que llegue a ese límite, con coste operacional cero porque la limpieza es automática.
