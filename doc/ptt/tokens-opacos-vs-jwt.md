# Tokens Opacos vs JWT — Cómo funcionan realmente

---

## Qué es un token opaco

Un token opaco es **un string aleatorio sin significado intrínseco**. Literalmente eso. Por ejemplo:

```
a7f3k2p9x2m4n8q1b5h7c3d9
```

Ese string **no contiene** rol, ni username, ni email, ni fecha de expiración, ni firma criptográfica, ni nada. Es una llave — como el número de un guardarropa.

La diferencia más importante con el JWT está en **dónde vive la información**:

| Modelo | Dónde vive la información |
|---|---|
| JWT | Dentro del token, viajando con el cliente |
| Opaco | En el servidor (Valkey, Redis, DB), el cliente solo lleva un ID |

---

## La analogía del guardarropa

Imagina dejar tu chaqueta en el guardarropa de un teatro:

```
                ┌─────────────────────────────────────────────┐
                │           GUARDARROPA DEL TEATRO            │
                │                                             │
                │   ┌──────┐   ┌──────┐   ┌──────┐            │
                │   │ #345 │   │ #346 │   │ #347 │   ...      │
                │   └──────┘   └──────┘   └──────┘            │
                │      │          │          │                │
                │   chaqueta   chaqueta   chaqueta            │
                │     Ana       Luis       Miguel             │
                │                                             │
                └─────────────────────────────────────────────┘
                                    ▲
                                    │
                                    │  El TICKET "347" es solo
                                    │  una llave: no describe la
                                    │  chaqueta ni dice quién es
                                    │  su dueño. Toda la info vive
                                    │  DENTRO del guardarropa.
                                    │
                              ┌───────────┐
                              │  TICKET   │
                              │    347    │
                              └───────────┘
                              (lo que tú llevas)
```

### El intercambio

```
ENTRADA AL TEATRO
─────────────────────────────────────────────────────────
Tú entregas la chaqueta    →  Guardarropa la cuelga en perchero #347
Recibes el ticket "347"    ←  Anota internamente: "perchero 347 = chaqueta de Miguel"

SALIDA DEL TEATRO
─────────────────────────────────────────────────────────
Tú entregas el ticket "347"  →  El guardarropa busca en perchero #347
                              ←  Te devuelve TU chaqueta exacta
```

El ticket no contenía información sobre la chaqueta. Solo era una referencia. Toda la información sobre quién eres y qué chaqueta es tuya **vive en el guardarropa**, no en el ticket.

---

## Aplicado a autenticación

### Login

```
1. Cliente envía email + password al servidor NestJS

2. NestJS valida credenciales

3. NestJS genera un string aleatorio:
   sessionId = crypto.randomBytes(32).toString('hex')
             = "a7f3k2p9x2m4n8q1..."

4. NestJS guarda EN VALKEY:
   SET session:a7f3k2p9... {
     userId: "uuid-123",
     role: "doctor",
     username: "miguel.ramos",
     email: "miguel@clinica.cl",
     loginTime: "2026-04-29T09:00:00Z"
   } EX 900

5. NestJS envía al cliente SOLO el sessionId en cookie HttpOnly:
   Set-Cookie: __Host-sid=a7f3k2p9x2m4n8q1...

6. El cliente recibe SOLO el string aleatorio.
   No recibe rol, ni username, ni nada.
```

### Diagrama del modelo opaco aplicado

```
                ┌─────────────────────────────────────────────┐
                │              VALKEY (SERVIDOR)              │
                │                                             │
                │   session:a7f3k2p9... = {                   │
                │     userId:   "uuid-123",                   │
                │     role:     "doctor",                     │
                │     username: "miguel.ramos",               │
                │     email:    "miguel@clinica.cl",          │
                │     loginAt:  "2026-04-29T09:00:00Z"        │
                │   }                                         │
                │                                             │
                └─────────────────────────────────────────────┘
                                    ▲
                                    │
                                    │  El sessionId "a7f3k2..."
                                    │  es solo una llave aleatoria.
                                    │  No contiene rol, ni email.
                                    │  Toda la info vive en Valkey.
                                    │
                          ┌───────────────────────┐
                          │   COOKIE HttpOnly     │
                          │   __Host-sid =        │
                          │   a7f3k2p9x2m4n8q1... │
                          └───────────────────────┘
                            (lo que el cliente lleva)
```

### Petición posterior autenticada

```
1. Cliente hace GET /api/v1/patients
   El navegador envía la cookie automáticamente:
   Cookie: __Host-sid=a7f3k2p9x2m4n8q1...

2. NestJS recibe la petición y extrae el sessionId

3. NestJS consulta Valkey:
   GET session:a7f3k2p9x2m4n8q1...

4. Valkey responde:
   { userId: "uuid-123", role: "doctor", username: "miguel.ramos", ... }

5. NestJS ahora SÍ sabe quién es el usuario y qué rol tiene
   — toda esa información vive en Valkey, NO en el cliente

6. NestJS aplica las reglas de autorización según el rol y responde
```

---

## ¿Cómo sabe el frontend el rol del usuario?

Esta es la duda más habitual al ver el modelo opaco por primera vez. **El cliente no necesita saberlo directamente desde el token.**

Cuando el frontend Angular necesita saber el rol del usuario para mostrar u ocultar el menú de admin, hace una petición específica:

```
GET /api/v1/auth/me
```

Y el backend responde con la información del usuario autenticado leyéndola de Valkey:

```json
{
  "id": "uuid-123",
  "username": "miguel.ramos",
  "role": "doctor",
  "email": "miguel@clinica.cl"
}
```

El frontend guarda esa información en memoria (en un `AuthService` por ejemplo) y la usa para construir la UI. La información viaja por una respuesta HTTP normal — no viene "metida" en el token.

---

## Comparación visual de los dos modelos

```
┌─────────────────────────────────────────────────────────────────┐
│ MODELO JWT (lo que tiene actualmente este proyecto)             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Cookie: refresh_token = eyJhbGc...{sub, exp, iss, aud}.firma   │
│                                       ▲                         │
│                                       │                         │
│                          La información VIVE en el token        │
│                          El cliente la lleva consigo            │
│                          El servidor solo verifica la firma     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ MODELO OPACO (lo que usan Facebook, GitHub, sesiones server)    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Cookie: __Host-sid = a7f3k2p9x2m4n8q1                          │
│                       ▲                                         │
│                       │                                         │
│             Solo un ID aleatorio. NO contiene información.      │
│                                                                 │
│  Valkey:  session:a7f3k2p9x2m4n8q1 → { userId, role, ... }      │
│                                       ▲                         │
│                                       │                         │
│                       Aquí vive la información real             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Dudas frecuentes

### ¿La petición se hace desde Redis/Valkey?

No. Valkey **no recibe peticiones del cliente directamente**. El cliente sigue hablando con NestJS por HTTP. NestJS, internamente, consulta Valkey para resolver el sessionId. Valkey vive en la red privada del backend, no expuesto a internet.

### ¿Es donde existe el refresh token en base64?

No exactamente. En el modelo opaco no hay un refresh token JWT en base64. Hay un **sessionId aleatorio** en la cookie del cliente, y los datos del usuario en Valkey. El concepto de "refresh token" cambia: la sesión simplemente se renueva extendiendo el TTL en Valkey.

### ¿Cómo refrescamos los tokens?

En el modelo opaco no se refresca un token — **se extiende la sesión**:

```
Cliente hace petición  →  NestJS verifica sessionId en Valkey
                       →  Si está cerca de expirar, NestJS hace:
                          EXPIRE session:a7f3k2p9... 900
                          (extiende el TTL otros 15 minutos)
                       →  Sin emitir nada nuevo, sin firmar nada
```

### ¿El token opaco solo tiene caracteres aleatorios?

Sí. Un string aleatorio criptográficamente seguro — generalmente entre 32 y 64 bytes convertidos a hex o base64url. Sin estructura, sin claims, sin firma. Solo una llave única e impredecible.

### ¿Se puede revocar instantáneamente?

Sí, y este es su mayor punto fuerte:

```
DEL session:a7f3k2p9x2m4n8q1...
```

Una sola operación. La próxima petición del cliente con esa cookie no encontrará nada en Valkey y será rechazada con `401`. Sin esperar a que expire ningún token, sin blocklist paralela, sin firmas.

---

## El patrón híbrido (recomendado en la industria)

La mejor práctica actual no es elegir uno u otro, sino **combinar ambos** según el rol del token:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ACCESS TOKEN  →  JWT firmado (stateless)                        │
│                   - Vida corta (5–15 min)                        │
│                   - Lleva claims: sub, role, exp                 │
│                   - NO consulta Valkey en cada request           │
│                   - Rápido, escalable                            │
│                                                                  │
│  REFRESH TOKEN →  Token opaco (stateful)                         │
│                   - Vida larga (7–30 días)                       │
│                   - Solo un ID aleatorio                         │
│                   - Datos viven en Valkey                        │
│                   - Revocable instantáneamente                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Por qué tiene sentido para el refresh específicamente

**1. La revocación importa más en el refresh.** El access token vive 10–15 minutos; si alguien lo roba, el daño máximo es esa ventana. El refresh token vive **semanas**: si alguien lo roba y no puedes revocarlo, tiene acceso por semanas. La revocación instantánea es vital.

**2. Si ya consultas el almacén en cada refresh, la firma del JWT no aporta nada.** Cuando ya estás haciendo round-trip a Valkey o DB para validar/rotar el refresh, la verificación criptográfica del JWT solo te suma complejidad (claims, exp, alg, rotación de secrets). El sessionId opaco hace lo mismo con menos piezas.

**3. El JWT como refresh tiene una contradicción conceptual.** El JWT existe para ser stateless — verificable sin tocar la base. Pero un refresh token **necesita** ser stateful para ser revocable. Estás usando una herramienta stateless para una tarea stateful, y por eso terminas añadiendo Valkey de todas formas. El token opaco abraza la naturaleza stateful desde el principio.

### Comparación directa para refresh tokens

|                            | JWT como refresh             | Opaco como refresh        |
|----------------------------|------------------------------|---------------------------|
| Tamaño del token           | ~300–500 bytes               | 32–64 bytes               |
| Costo de generación        | Firma criptográfica          | Random bytes              |
| Costo de validación        | Verificar firma + GET en DB  | Solo GET en Valkey        |
| Revocación inmediata       | Vía blocklist                | Vía DEL en Valkey         |
| Rotación de secrets        | Necesaria (compleja)         | No aplica                 |
| Filtrado en logs           | Riesgo (lleva data útil)     | Bajo riesgo (solo ID)     |
| Complejidad total          | Alta                         | Baja                      |

### Quiénes lo hacen así

- **Google** — access JWT corto + refresh opaco largo
- **Facebook/Meta** — sesiones completamente opacas
- **GitHub** — tokens opacos para todo (incluso PATs)
- **OAuth 2.0 Best Current Practice** — recomienda explícitamente refresh opacos cuando hay almacenamiento de sesión disponible

---

## Tu proyecto comparado con estos modelos

El refresh token actual de este proyecto **ya es minimalista**, mucho más cerca del modelo opaco de lo que parece a primera vista. El payload firmado en `auth.service.ts` es solo:

```typescript
const refreshToken = await this.jwtService.signAsync(
  { sub: user.id },
  refreshOptions,
);
```

El JWT resultante contiene únicamente:

```json
{
  "sub": "uuid-del-usuario",
  "iat": 1730000000,
  "exp": 1730604800,
  "iss": "clinic-api",
  "aud": "clinic-web"
}
```

No lleva rol, ni email, ni jti — solo identifica al usuario. Cuando llega un refresh, el servidor consulta la DB para sacar el rol, email, estado activo y hash actual del refresh. **La autorización vive en la DB, no en el token.**

```
┌──────────────────────────────────────────────────────────────┐
│ EJEMPLO "FAT" (mala práctica)                                │
├──────────────────────────────────────────────────────────────┤
│ refresh = JWT { sub, role, email, username, jti, ... }       │
│           ▲                                                  │
│           Mucho contenido sensible viajando al cliente       │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ ESTE PROYECTO (refresh JWT minimalista)                      │
├──────────────────────────────────────────────────────────────┤
│ refresh = JWT { sub, iat, exp, iss, aud }                    │
│           ▲                                                  │
│           Solo identifica al usuario. Nada más.              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ MODELO OPACO PURO (Facebook style)                           │
├──────────────────────────────────────────────────────────────┤
│ refresh = "a7f3k2p9x2m4n8q1..."                              │
│           ▲                                                  │
│           Ni siquiera identifica al usuario — es un ID       │
└──────────────────────────────────────────────────────────────┘
```

### Diferencias entre el refresh JWT actual y un opaco "puro"

|                              | Refresh JWT actual         | Refresh opaco puro       |
|------------------------------|----------------------------|--------------------------|
| Identifica al usuario        | Sí (sub)                   | No (es solo un ID)       |
| Lleva exp/iat/iss/aud        | Sí                         | No (vive en Valkey)      |
| Verifica con firma HMAC      | Sí                         | No (vive con SOLO + GET) |
| Tamaño                       | ~250 bytes                 | ~32–64 bytes             |
| Almacén de revocación        | PostgreSQL (hash en DB)    | Valkey (sessionId)       |
| Naturaleza                   | Híbrido (firma + DB)       | Pure stateful            |

---

## Resumen

- Un **token opaco** es un string aleatorio sin información: el equivalente al ticket de un guardarropa.
- Toda la información del usuario (rol, email, etc.) vive **en el servidor**, no en el token.
- El frontend obtiene los datos del usuario por endpoints como `/auth/me`, no leyendo el token.
- El **patrón híbrido** (JWT corto para access + opaco largo para refresh) es la mejor práctica actual.
- El proyecto actual ya tiene un refresh JWT minimalista (solo `sub`), conceptualmente cercano al modelo opaco.
- Migrar el refresh a opaco simplificaría el código en lugar de complicarlo, porque ya consultamos la DB en cada refresh.
