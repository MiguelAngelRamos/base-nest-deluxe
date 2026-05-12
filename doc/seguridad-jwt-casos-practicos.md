# Seguridad JWT — Cómo resuelve este proyecto los casos críticos

## Conceptos previos

### ¿Qué es un token JWT?

Un JWT (JSON Web Token) es una cadena de texto firmada que contiene información del usuario (quién es, qué rol tiene, cuándo expira). La API no necesita consultar la base de datos en cada petición para saber si el usuario está autenticado: confía en la firma del token.

Esto lo hace muy rápido, pero plantea un problema: **si el token es robado o el usuario es dado de baja, ¿cómo se revoca?**

Este proyecto resuelve ese problema con una arquitectura de defensa en capas.

---

### ¿Qué es TTL?

**TTL** significa _Time To Live_ (tiempo de vida). Es un número que indica **cuántos segundos le quedan de vida a un dato** antes de que sea eliminado automáticamente.

Se usa en dos contextos en este proyecto:

| Donde | Qué controla |
|---|---|
| Access token | El JWT expira en `JWT_EXPIRATION` segundos (ej. 900 s = 15 min). Después, la firma es rechazada automáticamente. |
| Valkey (blocklist) | Cuando un token es bloqueado, la entrada en Valkey tiene un TTL igual a los segundos que le quedaban de vida al token. Cuando ese tiempo pasa, Valkey borra la entrada sola. No se acumula basura. |

En ambos casos el TTL actúa como un temporizador de autodestrucción: el sistema no necesita limpiezas manuales.

---

## Caso 1 — ¿Qué pasa cuando un access token expira?

### El problema

El usuario tiene un token válido, pero lleva más de 15 minutos sin renovarlo. Intenta hacer una petición a la API con ese token.

### Cómo lo resuelve este proyecto

La API tiene una guarda global (`JwtAuthGuard`) aplicada a todos los endpoints. Antes de ejecutar cualquier lógica de negocio, Passport-JWT valida el token:

1. Comprueba la firma criptográfica (algoritmo `HS256`).
2. Comprueba el `issuer` y el `audience` del token.
3. Comprueba el campo `exp` (fecha de expiración) contra la hora actual del servidor.

Si el TTL del token ha vencido, **la librería rechaza el token antes de que llegue a ningún controlador**. La API devuelve `401 Unauthorized` de forma automática.

El cliente debe entonces usar su refresh token para obtener un par nuevo.

**Archivo clave:** [src/auth/strategies/jwt.strategy.ts](src/auth/strategies/jwt.strategy.ts) — `ignoreExpiration: false` en el constructor.

---

## Caso 2 — ¿Cuándo se renueva el refresh token?

### El problema

El access token dura poco (15 min). Para no obligar al usuario a hacer login cada 15 minutos existe el refresh token (dura 7 días). Pero ¿cuándo y cómo se renueva?

### Cómo lo resuelve este proyecto

El refresh token se renueva **siempre que se usa**. Esto se llama **rotación de tokens**.

El flujo en [src/auth/auth.service.ts](src/auth/auth.service.ts) — método `refreshToken()`:

```
Cliente envía refresh token
        │
        ▼
¿La firma es válida y no ha expirado?
        │ No → 401
        │ Sí
        ▼
¿Existe un hash guardado en la base de datos para este usuario?
        │ No (ya hizo logout o hubo reuso detectado) → 401
        │ Sí
        ▼
¿El token enviado coincide con el hash guardado (Argon2id)?
        │ No → REUSO DETECTADO: borrar hash en BD → 401
        │ Sí
        ▼
Emitir nuevo access token + nuevo refresh token
Guardar hash del nuevo refresh token en BD
Invalidar el refresh token anterior (ya no sirve)
```

**Casos en que se emite un nuevo refresh token:**

| Situación | Resultado |
|---|---|
| El usuario consume su refresh token válido | Se emite un par nuevo, el anterior queda inválido |
| El refresh token ha expirado (7 días) | No se emite nada, se pide login |
| El refresh token ya fue usado antes (reuso) | Se revoca toda la familia, se pide login |
| El usuario hizo logout | No hay hash en BD, no se emite nada |

La rotación garantiza que un refresh token robado solo funciona **una vez**. En el momento en que el atacante o el usuario legítimo lo usa, el otro queda bloqueado.

---

## Caso 3 — ¿Qué pasa cuando se cierra la sesión?

### El problema

El usuario pulsa "Cerrar sesión". ¿Qué hace el sistema para garantizar que esa sesión queda realmente cerrada?

### Cómo lo resuelve este proyecto

El método `logout()` en [src/auth/auth.service.ts](src/auth/auth.service.ts) ejecuta dos acciones en paralelo:

**Acción 1 — Invalidar el refresh token:**
El campo `refreshTokenHash` del usuario en la base de datos se pone a `null`. A partir de ese momento, cualquier intento de renovar el token falla porque no hay hash con qué comparar.

**Acción 2 — Bloquear el access token en Valkey:**
El access token todavía tiene tiempo de vida (puede quedar hasta 15 min). Para bloquearlo, el sistema extrae su identificador único (`jti`) y lo guarda en Valkey con el TTL exacto que le queda:

```
Valkey key:   blocklist:at:{jti}
Valor:        "1"
TTL:          segundos que le quedaban al token
```

Cuando Valkey recibe una petición con ese token, la guarda en `jwt.strategy.ts` consulta Valkey, encuentra la clave y devuelve `401 Unauthorized ('Token revocado')`.

Cuando el token expira de forma natural, Valkey borra la clave automáticamente. Sin acumulación de datos.

**Resultado:** La sesión queda cerrada de inmediato en todos los dispositivos. No hay ventana de tiempo en la que el token siga siendo útil.

---

## Caso 4 — ¿Qué pasa cuando una persona deja la organización?

### El problema

Un empleado es dado de baja. El administrador desactiva su cuenta, pero el empleado tiene en su dispositivo un access token que aún no ha expirado y un refresh token válido. ¿Puede seguir accediendo a la API?

### Cómo lo resuelve este proyecto

El sistema tiene **tres capas de defensa** que actúan independientemente:

#### Capa 1 — `isActive` en cada petición

En [src/auth/strategies/jwt.strategy.ts](src/auth/strategies/jwt.strategy.ts), el método `validate()` consulta la base de datos en cada petición para comprobar que el usuario existe y está activo:

```typescript
const user = await this.usersService.findById(payload.sub);

if (!user || !user.isActive) {
  throw new UnauthorizedException('Usuario inactivo o no encontrado');
}
```

En el momento en que el admin desactiva al usuario (`isActive = false`), la siguiente petición con cualquier token devuelve `401`. No importa si el JWT es válido criptográficamente.

#### Capa 2 — Invalidación del refresh token

El admin puede (y debe) borrar el `refreshTokenHash` del usuario en la base de datos. Sin ese hash, el usuario no puede renovar tokens. Cuando su access token expire en los próximos minutos, ya no podrá obtener uno nuevo.

#### Capa 3 — Blocklist del access token

Para el período entre la baja y la expiración natural del access token, el sistema puede añadir el `jti` del token a la blocklist de Valkey, bloqueándolo de inmediato (mismo mecanismo que el logout).

**Diagrama del escenario:**

```
10:00 — Admin desactiva usuario
10:01 — Empleado intenta petición con su access token
         │
         ▼
    jwt.strategy.ts → findById → user.isActive = false
         │
         ▼
    401 Unauthorized (aunque el JWT sea criptográficamente válido)

10:01 — Empleado intenta refresh
         │
         ▼
    refreshTokenHash = null en BD
         │
         ▼
    401 Unauthorized
```

El empleado queda bloqueado en segundos, no en minutos.

---

## Caso 5 — El usuario cerró sesión pero su token aún tiene 10 minutos de vida

### El problema

Este es el caso más delicado y el que expone la limitación clásica de JWT.

Un JWT es _stateless_: la API no necesita base de datos para validarlo, solo verifica la firma. Si la firma es válida y no ha expirado, el token funciona. **Entonces, ¿cómo se puede revocar antes de que expire?**

La respuesta clásica es: "no se puede sin estado centralizado". Este proyecto lo resuelve con Valkey.

### Cómo lo resuelve este proyecto

En el momento del logout (14:00, token expira 14:10):

```
logout() en auth.service.ts
│
├── 1. Decode del access token → extrae jti y exp
│
├── 2. Calcula TTL restante: exp - Date.now() = 600 segundos
│
└── 3. Valkey SET blocklist:at:{jti} "1" EX 600
```

A partir de ese instante, en cada petición que llegue con ese token:

```
JwtStrategy.validate()
│
├── Signature OK ✓
├── exp no vencido ✓ (aún quedan 9 minutos)
├── issuer OK ✓
│
└── valkeyClient.get('blocklist:at:{jti}')
        │
        ├── Resultado: "1"  →  throw UnauthorizedException('Token revocado')
        │
        └── Resultado: null →  continúa (token limpio)
```

El token está técnicamente "vivo" (firma válida, no expirado), pero la API lo rechaza porque su `jti` está en la lista negra.

A las 14:10, el token expira de forma natural. Valkey también borra la clave automáticamente (el TTL llegó a cero). La lista negra se mantiene limpia sola.

### ¿Qué pasa si Valkey está caído?

El sistema está diseñado con **fail-open**: si Valkey no responde, el error se registra en los logs pero la petición continúa. El access token podría funcionar durante el tiempo que Valkey esté caído.

Sin embargo, el refresh token siempre está protegido por la base de datos (`refreshTokenHash = null`), que no depende de Valkey. Incluso en el peor caso, el atacante solo tiene acceso durante los minutos que le quedan al access token. No puede renovarlo.

---

## Resumen de capas de seguridad

| Mecanismo | Protege contra | Depende de |
|---|---|---|
| `ignoreExpiration: false` | Token expirado | Passport-JWT (local) |
| Blocklist en Valkey (`jti`) | Token válido pero revocado | Valkey (tolerante a fallos) |
| `refreshTokenHash = null` | Renovación tras logout/baja | Base de datos (siempre activo) |
| `user.isActive` en cada request | Acceso tras baja del usuario | Base de datos (siempre activo) |
| Rotación de refresh tokens | Robo y reuso de refresh token | Base de datos |
| Argon2id para hashes | Robo de la base de datos | Algoritmo criptográfico |

La API tiene dos líneas de defensa que no dependen entre sí: la base de datos y Valkey. Si una falla, la otra mantiene la seguridad en el peor caso durante minutos (el TTL del access token).
