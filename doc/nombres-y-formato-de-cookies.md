## Pregunta

> ¿Es peligroso llamar a las cookies `access_token` y `refresh_token`?
> ¿Es seguro que el valor sea un JWT en base64 que cualquiera puede leer
> abriendo el inspector? Twitch, Facebook y otras plataformas tienen
> cookies `HttpOnly` con nombres opacos (`xs`, `c_user`, `sid`…) y valores
> que no parecen tokens, ¿cómo lo hacen?

Esta es una pregunta de modelo de amenaza, no de implementación. Vamos por
partes.

---

## 1. Aclaración previa — ¿qué protege cada flag?

Antes de hablar de nombres y formatos, conviene fijar qué amenaza tapa cada
mecanismo. Los flags **no son intercambiables**:

| Flag / mecanismo | Contra qué protege | Contra qué NO protege |
|---|---|---|
| `HttpOnly` | Lectura desde JavaScript (`document.cookie`). Mitiga XSS. | El usuario abriendo DevTools, malware en la máquina, extensiones del navegador con permisos. |
| `Secure` | Que la cookie viaje en HTTP plano y un MITM la lea. | Cualquier amenaza fuera de la red. |
| `SameSite=strict` | Que un sitio externo dispare requests autenticados (CSRF). | XSS en tu propio dominio. |
| Firma JWT (`HS256`) | Que un atacante modifique el contenido del token. | Que alguien lo **lea**. La firma garantiza integridad, no confidencialidad. |
| Cifrado del token (JWE / opaco en DB) | Que alguien lea el contenido del token. | Robo del token entero (sigue valiendo si lo presentas). |

Punto clave: **un JWT no es un secreto cifrado**. Es JSON firmado, codificado
en base64url. Cualquiera que tenga el token puede leer su contenido en
[jwt.io](https://jwt.io). Lo único que no puede hacer es modificarlo sin
invalidar la firma.

---

## 2. ¿Es peligroso llamar a la cookie `refresh_token`?

**No es una vulnerabilidad.** La seguridad de la cookie depende de los flags
(`HttpOnly`, `Secure`, `SameSite`, `Path`, prefijo `__Host-`), no del
nombre. Llamarla `refresh_token` es la convención estándar y está
documentado así en RFC 6749 (OAuth 2.0).

Pero **sí hay razones legítimas para usar nombres opacos** en producción a
gran escala:

### 2.1 — Reducir señal a atacantes y malware

Un nombre como `refresh_token` le dice exactamente a un info-stealer (LummaC2,
RedLine, Vidar…) qué cookie es valiosa. Estos malware navegan los
`Cookies.sqlite` del navegador buscando nombres conocidos: `auth_token`,
`session`, `access_token`, `Bearer`, `JWT`. Un nombre opaco como `sid` o
`c_user` no esquiva un atacante dedicado, pero sí filtra la mayoría de
herramientas automatizadas que solo conocen los nombres canónicos.

Es **defense in depth**, no seguridad real. Pero en empresas con millones de
usuarios, filtrar el 80% del ruido automático tiene valor.

### 2.2 — Nombres descriptivos exponen tu arquitectura

Ver `csrf_token`, `refresh_token`, `access_token`, `XSRF-TOKEN` en una
respuesta describe el modelo de auth a un atacante antes de que pruebe nada.
Es información gratuita.

### 2.3 — Fingerprinting / agrupación

Plataformas grandes prefieren nombres que no permitan identificar el stack
técnico (NestJS + Passport + JWT) desde fuera.

### 2.4 — ¿Qué se hace en la práctica?

| Plataforma | Cookies relevantes | Pista |
|---|---|---|
| Facebook | `c_user`, `xs`, `fr`, `datr` | `xs` es la sesión, `c_user` el user id. |
| Twitch | `auth-token`, `twilight-user`, `unique_id` | El token sí se llama `auth-token` pero el valor es opaco. |
| Google | `SID`, `HSID`, `SSID`, `APISID`, `__Secure-1PSID` | Identificadores opacos en cookies prefijadas. |
| GitHub | `user_session`, `__Host-user_session_same_site` | Usa el prefijo `__Host-`. |

Conclusión: los nombres son neutros (`sid`, `xs`, `auth-token`) y los valores
son **identificadores opacos**, no JWT.

---

## 3. ¿Por qué cuando abres DevTools en Facebook NO ves un JWT?

Porque **Facebook no usa JWT en la cookie**. Usa un **identificador opaco
de sesión** (un string aleatorio largo) que apunta a una entrada en una
base de datos / cache server-side.

Hay dos modelos arquitectónicos para representar una sesión:

### 3.1 — Modelo A: token autocontenido (JWT) — lo que usa este proyecto

```
Cookie: refresh_token = eyJhbGciOiJIUzI1NiIs...  (JWT)
                       └─ contiene sub, role, exp firmados
```

- El servidor **no necesita consultar nada** para validar (solo verifica
  firma + claims).
- El contenido es **legible** (base64url). No es secreto.
- Para revocar antes de su expiración natural hay que mantener una
  blocklist (lo que hace este proyecto con Valkey).
- **Pro:** stateless, escalable, no necesita lookup en cada request.
- **Contra:** contenido visible, revocación cuesta infraestructura extra.

### 3.2 — Modelo B: token opaco + sesión server-side — lo que usa Facebook

```
Cookie: xs = 19%3A_aB3kZ9pQ7xN2wM...  (random ID, no significa nada)
        │
        └─→ Lookup en Redis/DB:
            { user_id, role, ip, fp, expires_at, ... }
```

- El servidor **siempre consulta** el almacén de sesiones.
- El contenido **no existe en el cliente** — solo un ID aleatorio.
- Revocación trivial: borras la entrada del store.
- **Pro:** confidencialidad total, revocación inmediata, sin blocklist.
- **Contra:** requiere lookup en cada request, infraestructura central.

### 3.3 — Modelo híbrido — el más usado en producción seria

- **Access token = JWT corto (5–15 min)** en `Authorization: Bearer …` o en
  cookie `HttpOnly`. Stateless, sin lookup.
- **Refresh token = opaco (random 256 bits)** en cookie `HttpOnly`,
  almacenado en DB cifrado/hasheado. Lookup obligatorio en cada `/refresh`.

Este es el patrón que usan Auth0, Okta, Google OAuth y la mayoría de IdPs.
Es lo que la documentación de OAuth 2.0 sugiere implícitamente al decir que
los refresh tokens deben ser revocables.

---

## 4. Aplicado a este proyecto

### 4.1 — Estado actual

- Access token = JWT, viaja en el body de la respuesta y el cliente lo
  pone en `Authorization: Bearer …`. Validación stateless contra
  `JwtStrategy`. ✓
- Refresh token = JWT, viaja en cookie `HttpOnly` + `Secure` + `SameSite=strict`
  + `Path=/api/v1/auth/refresh`. ✓
- Revocación = blocklist en Valkey por `jti`. ✓

Mecánicamente es seguro. Las decisiones que se pueden revisar son
**arquitectónicas**, no defectos.

### 4.2 — Mejoras que valdría la pena evaluar

#### a) Renombrar la cookie a algo neutro

Cambiar `refresh_token` por `__Host-rt` (o `sid`):

```ts
const REFRESH_COOKIE = '__Host-rt';
```

El prefijo `__Host-` obliga al navegador a aceptar la cookie **solo si**:

- Tiene `Secure`.
- No tiene `Domain` (es decir, está bound al host exacto).
- Tiene `Path=/`.

Esto último choca con el `Path=/api/v1/auth/refresh` actual, así que la
elección es: o `__Host-` con path raíz, o un nombre neutro sin prefijo y
mantener el path restringido. **Las dos protecciones no son combinables.**
Si confías en `SameSite=strict`, mantener el path restringido + nombre
neutro (`rt`, `sid`) es probablemente mejor en este caso.

#### b) Migrar el refresh token a formato opaco

En lugar de un JWT firmado, generar un string aleatorio y guardarlo
hasheado en Postgres (igual que se guarda una contraseña):

```ts
const raw = crypto.randomBytes(32).toString('base64url');
const hashed = await argon2.hash(raw);
await this.refreshTokenRepo.save({ userId, hash: hashed, expiresAt });
// Cookie recibe `raw`, DB guarda `hashed`.
```

Beneficios:

- Si alguien hace un dump de la DB no recupera tokens válidos.
- La revocación es un `DELETE` en Postgres — no necesitas blocklist en
  Valkey para los refresh tokens (Valkey seguiría siendo útil para los
  access tokens).
- El contenido nunca es visible en DevTools, igual que en Facebook.

Contra: añade un lookup en `/refresh` (que de todas formas ya estás
haciendo para validar el `jti` contra Valkey, así que el coste real es
mínimo).

#### c) No metas PII en el payload del access token

Esta sí es importante y aplica al estado actual. El JWT es legible. Si en
el payload hay email, nombre, teléfono o cualquier dato del usuario, es
una **filtración pasiva**: cualquiera que vea la cookie en DevTools (incluido
el propio usuario en una máquina compartida) lo lee. Mantén el payload con
solo `sub` (id), `role`, `iat`, `exp`, `jti`, `iss`, `aud`. Nada más.

---

## 5. Resumen ejecutivo

1. **Nombrar la cookie `refresh_token` no es vulnerable**, pero los nombres
   opacos (`sid`, `xs`, `__Host-rt`) reducen ruido automatizado y no revelan
   tu arquitectura. Es defense in depth barato.
2. **Que el JWT se vea en base64 en DevTools no es un fallo del sistema** —
   es cómo está diseñado el formato. La protección contra XSS es `HttpOnly`,
   no la opacidad del valor. La firma garantiza integridad, no
   confidencialidad.
3. **Facebook / Twitch / Google no muestran JWT** porque usan
   identificadores opacos respaldados por una sesión server-side. Es un
   modelo distinto: paga lookup por request a cambio de confidencialidad y
   revocación inmediata.
4. **La mejora más realista** para este proyecto es migrar el refresh token
   a formato opaco (random + hash en DB) y dejar el access token como JWT
   corto. Eso te acerca al patrón de los IdPs serios sin romper la
   arquitectura existente.
5. **Acción inmediata sin reescritura**: revisar que el payload del JWT no
   contenga datos personales del usuario más allá de id y rol.
