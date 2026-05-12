# Preguntas de seguridad post-sesión — Cómo este proyecto las resuelve

Este documento responde a dos preguntas concretas sobre el comportamiento del
sistema cuando una sesión termina antes de la expiración natural de los tokens.
Para cada pregunta se muestra **todo el código comprometido**, paso a paso, sin
dar por sentado ningún concepto previo.

---

## Pregunta 1 — Si alguien cierra sesión y a su access token le quedan 10 minutos, ¿cómo lo resuelve este proyecto?

### Escenario concreto

A las **10:00:00** Juan hace login. El servidor le firma un access token con
expiración a las **10:15:00** (15 minutos de vida). Juan trabaja durante 5 minutos.

A las **10:05:00** Juan pulsa "Cerrar sesión". En ese instante a su access token
todavía le quedan **10 minutos de vida**. Si alguien interceptó ese token (porque
lo copió del DevTools, lo robó por una extensión maliciosa, lo capturó en un
proxy, etc.) podría seguir usándolo hasta las 10:15:00 — diez minutos enteros
después de que Juan ya hubiera cerrado sesión.

### El problema fundamental con JWT stateless

JWT es **stateless** por diseño: el servidor firma el token y luego, en cada
petición, solo comprueba dos cosas — que la firma sea válida y que el campo
`exp` no haya pasado. El servidor **no guarda en ninguna parte** una lista de
"tokens activos" porque ese es precisamente el modelo que JWT viene a evitar
(escalabilidad horizontal sin estado compartido).

Esto crea un problema cuando un usuario hace logout: el token sigue siendo
**criptográficamente válido** hasta que su `exp` pase de forma natural. Sin
ningún mecanismo adicional, el logout solo borra el token del lado del cliente
— el servidor no se entera.

### Cómo este proyecto lo resuelve — paso a paso

La solución se llama **blocklist** y vive en Valkey. Pero la blocklist sola no
funciona si el token no tiene un identificador único — por eso todo empieza
mucho antes del logout, en el momento mismo en que se firma el token.

---

#### Paso 1 — Cada access token nace con un identificador único (`jti`)

Antes de poder bloquear un token, el sistema necesita poder **referirse a él de
forma única**. Eso se consigue con el claim estándar `jti` (*JWT ID*), un UUID
generado en cada firma.

**Archivo:** `src/auth/strategies/jwt.strategy.ts` — definición del payload

```typescript
export interface JwtPayload {
  sub: string;     // user id
  email: string;
  role: string;
  // jti (JWT ID) — identificador único; prerequisito para blocklist en logout.
  jti: string;
}
```

**Archivo:** `src/auth/auth.service.ts` — método `issueTokens()`

```typescript
private async issueTokens(user: User): Promise<AuthTokens> {
  // [SECURE-FIX] jti (JWT ID) — identificador único por token.
  // Prerequisito para blocklist en logout: permite invalidar un
  // access token específico sin esperar a que expire.
  // OWASP A07:2021 Identification and Authentication Failures.
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    jti: randomUUID(),  // ← UUID v4 único — cada login genera uno nuevo
  };

  const accessOptions = {
    secret: this.configService.getOrThrow<string>('jwt.secret'),
    expiresIn: this.configService.getOrThrow<string>('jwt.expiration'), // '15m'
    algorithm: 'HS256',
    issuer,
    audience,
  } as JwtSignOptions;

  // El jti queda firmado dentro del access token.
  // Cualquier alteración del jti rompe la firma.
  const accessToken = await this.jwtService.signAsync(payload, accessOptions);
  // ...
}
```

**Qué hay que entender de este paso:**

- `randomUUID()` viene de `node:crypto`. Genera un UUID v4 (formato
  `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`) usando entropía criptográfica del
  sistema operativo. La probabilidad de colisión es prácticamente cero.

- El `jti` se incluye dentro del **payload firmado**. Como JWT firma el payload
  completo con HMAC-SHA256, un atacante no puede modificar el `jti` para evadir
  la blocklist sin invalidar la firma del token entero.

- En el momento del login Juan recibe un token con un `jti` concreto, por
  ejemplo `550e8400-e29b-41d4-a716-446655440000`. Ese UUID es la "matrícula"
  que permite referirse a su token específico en los próximos pasos.

---

#### Paso 2 — El cliente llama al endpoint de logout

Cuando Juan pulsa "Cerrar sesión", el frontend hace una petición autenticada
a `/auth/logout` con su access token actual en el header `Authorization`.

**Archivo:** `src/auth/auth.controller.ts` — método `logout()`

```typescript
// Logout requiere access token válido — si no hay sesión no
// tiene sentido invalidar nada. OWASP A01
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
@Post('logout')
@HttpCode(HttpStatus.NO_CONTENT)
async logout(
  @Req() req: Request & { user: { id: string } },
  @Res({ passthrough: true }) res: Response,
) {
  // Extraemos el Bearer para pasarlo a la blocklist de Valkey.
  // El guard ya verificó su validez — aquí solo lo parseamos.
  const authHeader = (req.headers as Record<string, string>)['authorization'] ?? '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  await this.authService.logout(req.user.id, accessToken);

  // Borra la cookie del refresh token del navegador
  res.clearCookie(REFRESH_COOKIE, this.buildRefreshCookieOptions());
}
```

**Qué hay que entender de este paso:**

- **`@UseGuards(JwtAuthGuard)`** — el endpoint exige un access token válido.
  Si Juan ya no tiene token (porque expiró), la petición se rechaza antes de
  llegar al método. Esto evita un caso absurdo: intentar invalidar una sesión
  que ya no existe.

- **`req.user`** — lo inyecta `JwtStrategy.validate()` después de verificar el
  token. Contiene `{ id, email, role }`. El `id` se usa para nulificar el
  refresh token en la BD.

- **`req.headers['authorization']`** — el header HTTP completo, formato
  `Bearer eyJhbGciOiJIUzI1NiJ9...`. Se hace `.slice(7)` para quitar exactamente
  los 7 caracteres de `"Bearer "` (incluyendo el espacio) y dejar solo el token.

- El access token se le pasa a `authService.logout()` porque el servicio
  necesita extraer el `jti` y `exp` para escribir en Valkey con el TTL correcto.

- **`res.clearCookie()`** — le dice al navegador que borre la cookie del refresh
  token. Esto **no es la defensa principal** — un atacante podría haber copiado
  el contenido de la cookie antes; la defensa real es nulificar el hash en DB
  (Paso 3).

---

#### Paso 3 — `logout()` en el servicio: escribe en Valkey y nulifica la BD

Aquí ocurre el corazón de la solución. Este método hace **dos operaciones
independientes** que protegen contra dos vectores distintos.

**Archivo:** `src/auth/auth.service.ts` — método `logout()`

```typescript
// [SECURE-FIX] Blocklist del access token en Valkey — cierra la
// ventana de 15min en la que un token robado seguiría siendo válido
// después de que el usuario legítimo haga logout.
// OWASP A07:2021 Identification and Authentication Failures.
async logout(userId: string, accessToken: string): Promise<void> {
  // decode() no verifica firma — solo extrae el payload. El token
  // ya fue validado por JwtAuthGuard antes de llegar aquí.
  const decoded = this.jwtService.decode<{ jti?: string; exp?: number }>(accessToken);

  if (decoded?.jti && decoded?.exp) {
    // TTL = segundos hasta expiración natural del token.
    // La entrada en Valkey se auto-elimina al expirar — sin acumulación.
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);

    if (ttl > 0) {
      try {
        // OPERACIÓN 1: Escribir el jti en la blocklist de Valkey
        // key namespaced para evitar colisiones con otras claves de Valkey
        await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
      } catch (err) {
        // Fail-open: el refresh se invalida igual; solo el access token
        // quedará activo hasta su expiración natural. OWASP A09:2021.
        this.logger.error(
          `Blocklist Valkey error en logout: ${(err as Error).message}`,
        );
      }
    }
  }

  // OPERACIÓN 2: Invalidamos el refresh token seteando el hash a null
  // Esta línea está FUERA del try/catch — se ejecuta siempre
  await this.userRepository.update(userId, { refreshTokenHash: null });
  this.logger.log(`Logout para userId: ${userId}`);
}
```

**Qué hay que entender de este paso, línea por línea:**

**`this.jwtService.decode(...)`** — `decode` es **distinto** de `verify`.
`verify` comprueba firma + expiración + iss/aud y lanza error si algo falla.
`decode` simplemente parsea la parte central del JWT (que es Base64) y devuelve
el payload tal cual. Aquí se usa `decode` porque la verificación ya la hizo
`JwtAuthGuard` antes de entrar al método — repetirla sería redundante. Lo único
que necesitamos extraer es `jti` (para la clave en Valkey) y `exp` (para el TTL).

**`const ttl = decoded.exp - Math.floor(Date.now() / 1000)`** — este cálculo es
crucial. Vamos con el ejemplo concreto del escenario:

```
decoded.exp           = 10:15:00 → timestamp 1735380900 (segundos desde 1970)
Date.now() / 1000     = 10:05:00 → timestamp 1735380300

ttl = 1735380900 - 1735380300 = 600 segundos = 10 minutos
```

El TTL en Valkey será exactamente los 600 segundos que le quedan de vida al
token. Cuando esos 600 segundos pasen, el token JWT expirará por sí solo
(`exp` lo bloqueará en `passport-jwt`) y la entrada en Valkey desaparecerá
en el mismo instante. **Las dos cosas caducan a la vez** — no hay basura
acumulada en Valkey.

**`if (ttl > 0)`** — protege contra un caso borde. Si por alguna razón el token
ya expiró pero llegó hasta aquí (por desincronización de relojes, por ejemplo),
no tiene sentido escribir una entrada con TTL negativo o cero. `passport-jwt`
ya lo rechazaría en cualquier petición posterior por `exp`.

**`await this.valkeyClient.set('blocklist:at:' + jti, '1', 'EX', ttl)`** — esto
es el comando Valkey:
- `SET` — comando que crea o sobrescribe una clave.
- `'blocklist:at:' + jti` — la clave. El prefijo `blocklist:at:` actúa como un
  *namespace* para evitar colisiones con otras claves que pudieran existir
  (en este proyecto solo se usa Valkey para esto, pero el namespace es buena
  práctica para el futuro). El `at` significa *access token*.
- `'1'` — el valor. Da igual lo que sea — lo único que importa es que la clave
  exista. Se usa `"1"` por convención (sería igual de válido `"x"` o `"true"`).
- `'EX'` — flag que indica "el siguiente argumento es el TTL en segundos".
  Existe también `PX` para milisegundos, `EXAT` para timestamp absoluto, etc.
- `ttl` — los 600 segundos calculados.

**`try/catch` con fail-open** — si Valkey está caído, el `await` lanza un error
de conexión. El `catch` lo registra en logs (`this.logger.error`) pero **no lo
re-lanza**. La ejecución continúa hacia la `OPERACIÓN 2`.

**Por qué hay un catch que absorbe el error:** porque la `OPERACIÓN 2` (nulificar
el refresh en DB) es la defensa principal. Aunque Valkey falle, nulificar el
refresh garantiza que el atacante no puede conseguir un nuevo access token —
y los access tokens existentes caducan en como máximo 15 minutos. Hacer que el
logout falle por culpa de Valkey sería peor que aceptar la degradación temporal.

**`await this.userRepository.update(userId, { refreshTokenHash: null })`** —
TypeORM ejecuta `UPDATE users SET refresh_token_hash = NULL WHERE id = ...`.
Esto está **fuera** del `try/catch` de Valkey, por lo que se ejecuta tanto si
Valkey funcionó como si falló. Después de esta línea, el refresh token actual
de Juan es inválido (lo veremos en `refreshToken()` en el Paso 4).

---

#### Paso 4 — Cada petición posterior es rechazada por la blocklist

Ahora que el `jti` está en Valkey con un TTL de 600 segundos, cualquier
intento de usar ese access token será rechazado por `JwtStrategy.validate()`.

**Archivo:** `src/auth/strategies/jwt.strategy.ts` — método `validate()`

```typescript
async validate(payload: JwtPayload) {
  // Verificamos en cada request que el usuario siga existiendo
  // y esté activo — soft delete debe revocar tokens emitidos
  const user = await this.usersService.findOne(payload.sub);

  if (!user.isActive) {
    throw new UnauthorizedException('Usuario desactivado');
  }

  // [SECURE-FIX] Blocklist check — si el jti está en Valkey el token
  // fue revocado explícitamente en logout. OWASP A07:2021.
  // Fail-open deliberado: si Valkey no responde, dejamos pasar.
  // isActive sigue siendo la defensa principal — un usuario desactivado
  // no puede usar su token aunque la blocklist esté caída.
  // OWASP A09:2021 — registrar el fallo para alertar si es recurrente.
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

  return {
    id: user.id,
    email: user.email,
    role: user.role,
  };
}
```

**Qué hay que entender línea por línea:**

**`payload.jti`** — viene del token que el cliente acaba de enviar. Recordemos
que `passport-jwt` ya verificó la firma antes de llamar a `validate()`, así que
sabemos con certeza que ese `jti` es el original que firmamos en el login (no
puede haber sido alterado).

**`this.valkeyClient.get('blocklist:at:' + payload.jti)`** — comando `GET` de
Valkey. Devuelve:
- `null` si la clave no existe (caso normal: usuario que nunca hizo logout, o
  cuyo logout fue antes y la entrada ya caducó por TTL).
- `"1"` si la clave existe (el usuario hizo logout y aún no han pasado los
  segundos de TTL).

**`if (blocked)`** — en JavaScript, el string `"1"` es truthy. Si Valkey devolvió
`"1"`, entramos en el `if` y lanzamos `UnauthorizedException('Token revocado')`.
NestJS convierte esa excepción en una respuesta HTTP 401 automáticamente.

**`if (err instanceof UnauthorizedException) throw err`** — esta línea es
crítica y no obvia. Cuando lanzamos `throw new UnauthorizedException('Token revocado')`
*dentro* del `try`, esa excepción **llega al `catch` como cualquier otro error**.
Sin esta comprobación, el `catch` la absorbería y la convertiría en un log
silencioso — el token revocado pasaría como si la blocklist estuviera vacía.
Esta línea se asegura de re-lanzar las excepciones de negocio (token revocado)
y solo absorber las de infraestructura (Valkey caído).

**Aplicado al escenario concreto:**

```
10:00:00 — Juan hace login
           Token recibido: { jti: 550e8400-..., exp: 10:15:00 }
           Valkey: vacío

10:01:00 — Juan hace GET /api/v1/citas
           validate() corre:
             - GET blocklist:at:550e8400-... → null (no está)
             - Pasa → req.user = { id, email, role }
           ✅ Petición ejecutada normalmente

10:05:00 — Juan hace POST /api/v1/auth/logout
           logout() corre:
             - SET blocklist:at:550e8400-... "1" EX 600
             - UPDATE users SET refresh_token_hash = NULL

10:06:00 — Atacante (que copió el token a las 10:04) intenta
           GET /api/v1/citas con el mismo token:
           validate() corre:
             - GET blocklist:at:550e8400-... → "1"
             - throw UnauthorizedException('Token revocado')
           🛑 401 — token rechazado

10:15:00 — La entrada blocklist:at:550e8400-... expira por TTL
           (Valkey la elimina automáticamente)
           El token JWT también expira por su claim 'exp'
           Ya no hace falta tenerla en blocklist — el token
           sería rechazado por exp aunque la blocklist no existiera
```

---

### Diagrama del flujo completo de la Pregunta 1

```
LOGIN (10:00:00)
  │
  ├─ issueTokens()
  │    ├─ randomUUID() → jti = "550e8400-..."
  │    └─ signAsync(payload con jti) → access token con exp=10:15:00
  │
  └─ Cliente recibe el token

USO NORMAL (10:01–10:04)
  │
  └─ Cada petición: validate() → GET blocklist:at:550e8400 → null → pasa

LOGOUT (10:05:00)
  │
  ├─ JwtAuthGuard verifica el token actual
  │
  ├─ controller.logout() extrae el Bearer del header
  │
  └─ service.logout()
       ├─ decode() → { jti: "550e8400-...", exp: timestamp 10:15:00 }
       ├─ ttl = exp - now = 600 segundos
       │
       ├─ try: Valkey SET blocklist:at:550e8400-... "1" EX 600
       │       └─ catch → fail-open, continua
       │
       └─ DB: UPDATE users SET refresh_token_hash = NULL
              └─ se ejecuta SIEMPRE

PETICIONES POSTERIORES CON EL TOKEN VIEJO (10:06–10:14)
  │
  └─ validate() → GET blocklist:at:550e8400-... → "1"
       └─ throw UnauthorizedException('Token revocado')
            └─ HTTP 401

EXPIRACIÓN NATURAL (10:15:00)
  │
  ├─ Valkey elimina la entrada por TTL
  └─ JWT lo rechaza por exp
       └─ Cualquier intento posterior: 401 sin necesidad de blocklist
```

---

### Resumen de archivos involucrados — Pregunta 1

| Archivo | Método | Qué aporta |
|---|---|---|
| `auth.service.ts` | `issueTokens()` | Genera el `jti` con `randomUUID()` y lo firma dentro del token |
| `jwt.strategy.ts` | `JwtPayload` interface | Declara la forma del payload incluyendo `jti` |
| `auth.controller.ts` | `logout()` | Recibe la petición, extrae el Bearer, llama al servicio |
| `auth.controller.ts` | `@UseGuards(JwtAuthGuard)` sobre `logout` | Garantiza que solo se invalida una sesión existente |
| `auth.service.ts` | `logout()` | Decodifica el token, calcula TTL, escribe en Valkey, nulifica DB |
| `valkey.module.ts` | `VALKEY_CLIENT` | Cliente ioredis inyectado en el servicio |
| `jwt.strategy.ts` | `validate()` | Consulta Valkey en cada petición y rechaza si el `jti` está bloqueado |

---

---

## Pregunta 2 — Si alguien deja la organización, ¿qué pasa con sus refresh tokens y access tokens que se renuevan? ¿Cómo lo resuelve este proyecto?

### Escenario concreto

María es doctora en la clínica. Tiene una sesión activa: un access token con
expiración a las 14:00:00 y un refresh token con expiración dentro de 7 días.
A las 13:50:00 María renuncia (o es despedida). El administrador entra al panel
y la **desactiva** del sistema.

A partir de ese momento todo lo siguiente debe dejar de funcionar para María
**inmediatamente**:

1. Su access token actual (todavía no ha expirado — le quedan 10 minutos).
2. Su refresh token actual (todavía no ha expirado — le quedan 7 días).
3. Cualquier intento de obtener nuevos tokens vía refresh.
4. Cualquier intento de hacer login otra vez.

La pregunta es: ¿cómo se consigue eso sin tener que invalidar token por token,
y sin esperar a que expiren naturalmente?

### El problema fundamental

Si solo confiáramos en la blocklist de Valkey de la Pregunta 1, tendríamos que:
- Conocer todos los `jti` activos del usuario (puede haber varios — un dispositivo
  móvil, un portátil, una tablet, una sesión en otro navegador).
- Bloquear cada uno individualmente.
- Esperar 7 días a que el refresh expire por sí solo, o gestionar también una
  blocklist de refresh tokens.

Eso es complejo, propenso a olvidos y consume espacio en Valkey. La solución
correcta es **mover la decisión a la fuente** — al propio usuario en la base
de datos.

### Cómo este proyecto lo resuelve — paso a paso

La idea es simple pero potente: cada petición autenticada **vuelve a comprobar
en la BD que el usuario sigue activo**. Si el admin pone `isActive = false`,
en milisegundos todos los tokens de ese usuario quedan inutilizables sin
necesidad de tocarlos individualmente.

---

#### Paso 1 — La entidad `User` tiene un campo `isActive`

**Archivo:** `src/users/entities/user.entity.ts`

```typescript
@Entity('users')
export class User {

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true, length: 255 })
  email!: string;

  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.PATIENT,
  })
  role!: UserRole;

  // Permite desactivar un usuario sin eliminarlo
  // Eliminar registros de usuarios puede romper integridad
  // referencial con otras tablas — soft delete es más seguro
  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  // Hash del refresh token — nunca se guarda en texto plano
  @Column({ name: 'refresh_token_hash', type: 'varchar', nullable: true })
  refreshTokenHash!: string | null;

  // ...
}
```

**Qué hay que entender:**

- `isActive` es un boolean que arranca en `true` (`default: true`). Cualquier
  usuario nuevo está activo desde el momento de su creación.
- Es un *soft delete*: cuando el admin "borra" a María, el registro **no se
  elimina** de la tabla `users`. Solo cambia `isActive` a `false`. Esto preserva
  la integridad referencial — María puede aparecer como doctora asignada en
  citas pasadas, en historiales médicos, en informes; eliminar su fila rompería
  todas esas relaciones.

---

#### Paso 2 — El admin desactiva al usuario

María se desactiva con un `DELETE /users/:id` que solo el rol ADMIN puede ejecutar.

**Archivo:** `src/users/users.controller.ts` — método `remove()`

```typescript
// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Sin RBAC en Users (#3) — cualquier token válido
//   creaba/borraba usuarios, incluso admins.
// Mitigación: todo el CRUD de /users requiere rol ADMIN.
// ─────────────────────────────────────────────
@ApiTags('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('users')
export class UsersController {

  // ...

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desactivar usuario (solo ADMIN)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.remove(id);
  }
}
```

**Qué hay que entender:**

- **`@UseGuards(JwtAuthGuard, RolesGuard)`** — dos guards en cadena. Primero
  `JwtAuthGuard` valida el token (firma, exp, blocklist Valkey, isActive).
  Después `RolesGuard` lee el rol del `req.user` y lo compara contra
  `@Roles(UserRole.ADMIN)`. Solo admins pasan ambos.
- **`@Delete(':id')`** — el verbo HTTP es DELETE pero la operación NO es un
  delete físico (lo veremos en el servicio). El verbo refleja la intención
  semántica del cliente, no la implementación interna.
- **`@HttpCode(HttpStatus.NO_CONTENT)`** — devuelve 204 sin body, lo estándar
  para operaciones que tienen éxito sin nada que retornar.
- **`ParseUUIDPipe`** — valida que el `:id` recibido sea un UUID v4 válido.
  Si no lo es, la petición es rechazada con 400 antes de tocar la BD.

**Archivo:** `src/users/users.service.ts` — método `remove()`

```typescript
async remove(id: string): Promise<void> {
  const user = await this.findOne(id);

  // Soft delete — mantiene integridad referencial
  user.isActive = false;
  await this.userRepository.save(user);
}
```

**Qué hay que entender línea por línea:**

- **`await this.findOne(id)`** — busca al usuario en la BD. Si no existe, lanza
  `NotFoundException` (404). Si existe, devuelve el objeto User completo.
- **`user.isActive = false`** — modifica la propiedad en el objeto en memoria.
  Aún no está en la BD.
- **`await this.userRepository.save(user)`** — TypeORM ejecuta
  `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = ...`.

**Lo importante:** la operación es atómica y casi instantánea (un único UPDATE
sobre una fila). En el momento exacto en que la BD confirma el commit, el
estado de María en el sistema es `isActive = false`. Cualquier petición que
llegue **después** de ese commit la verá desactivada.

---

#### Paso 3 — La verificación `isActive` en cada petición autenticada

Aquí ocurre la magia. Cada vez que María (o quien tenga sus tokens) hace una
petición autenticada, `JwtStrategy.validate()` consulta la BD y comprueba
`isActive`.

**Archivo:** `src/auth/strategies/jwt.strategy.ts` — método `validate()`

```typescript
async validate(payload: JwtPayload) {
  // Verificamos en cada request que el usuario siga existiendo
  // y esté activo — soft delete debe revocar tokens emitidos
  // OWASP A01: Broken Access Control — un usuario desactivado
  // no debe poder usar su token aunque aún no haya expirado
  const user = await this.usersService.findOne(payload.sub);

  if (!user.isActive) {
    throw new UnauthorizedException('Usuario desactivado');
  }

  // [SECURE-FIX] Blocklist check (descrita en Pregunta 1)
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

  return {
    id: user.id,
    email: user.email,
    role: user.role,
  };
}
```

**Qué hay que entender:**

- **`payload.sub`** — el `sub` (*subject*) es un claim estándar de JWT que en
  este proyecto contiene el `userId`. Viene firmado dentro del token.
- **`this.usersService.findOne(payload.sub)`** — consulta a la BD:
  `SELECT id, email, role, is_active, created_at, updated_at FROM users WHERE id = ...`.
  Si el usuario no existe lanza `NotFoundException`. Si existe devuelve el
  objeto User con todos los campos seleccionados, incluyendo `isActive`.
- **`if (!user.isActive)`** — si el campo es `false`, lanza
  `UnauthorizedException('Usuario desactivado')`. NestJS convierte eso en HTTP 401.

**Aplicado al escenario:**

```
13:50:00 — Admin desactiva a María
           UPDATE users SET is_active = false WHERE id = '<maría>'

13:50:01 — María (sin saberlo) hace GET /api/v1/citas
           validate() corre:
             - findOne(maría_id) → User { isActive: false }
             - if (!user.isActive) → throw UnauthorizedException
           🛑 401 — Usuario desactivado

13:50:02 — Atacante con el token de María intenta GET /api/v1/pacientes
           validate() corre:
             - findOne(maría_id) → User { isActive: false }
             - 🛑 401 — Usuario desactivado
```

**Por qué esto funciona aunque el access token sea criptográficamente válido:**

`passport-jwt` solo valida firma + exp + iss + aud (Fase 1). `validate()` añade
una segunda fase con verificaciones de **estado mutable**: el token es válido
criptográficamente, pero el usuario detrás del token ya no tiene permiso para
operar. Esto es defense in depth: la firma protege contra falsificación, el
`isActive` protege contra cambios administrativos.

---

#### Paso 4 — La verificación `isActive` al renovar tokens (`refreshToken`)

María (o el atacante con sus tokens) podría intentar renovar su access token
usando el refresh token, que aún tiene 7 días de vida. Aquí también se le
bloquea.

##### Antes de leer este método — el ciclo de vida del `refreshTokenHash`

Para entender el método `refreshToken()` es imprescindible tener claro **qué
es y cómo evoluciona** el campo `refreshTokenHash` de la tabla `users`. Sin
este contexto, el comentario "*caso sin hash activo*" del código resulta
confuso. Vamos a desentrañarlo.

**¿Qué es el `refreshTokenHash`?**

Es una columna de la tabla `users` que almacena el **hash Argon2id del
refresh token actual** del usuario. **No es el refresh token en sí** — es
una versión hasheada, exactamente igual que el `passwordHash` no es la
contraseña sino su hash.

**Archivo:** `src/users/entities/user.entity.ts`

```typescript
@Entity('users')
export class User {
  // ...

  // Hash del refresh token — nunca se guarda en texto plano.
  // Argon2id lo hashea antes de persistir igual que la contraseña.
  // nullable: true porque al crear el usuario aún no tiene refresh
  // token — se asigna solo después del primer login exitoso.
  // OWASP A02:2025 Cryptographic Failures — tokens en DB hasheados.
  @Column({ name: 'refresh_token_hash', type: 'varchar', nullable: true })
  refreshTokenHash!: string | null;
}
```

**Por qué es un hash y no el token directamente:** si la base de datos fuera
robada en un dump, los refresh tokens en texto plano serían inmediatamente
utilizables por el atacante. Hasheándolos con Argon2id, el atacante solo
ve algo como `$argon2id$v=19$m=65536,t=3,p=4$...$...` — inservible para
hacer un refresh, porque el endpoint `/auth/refresh` requiere el token
**original** (no el hash) para que `argon2.verify()` lo confirme.

---

**Cuándo se hashea el refresh token — el código exacto**

> **Aclaración importante de terminología:** Argon2id no **encripta** el
> refresh token — lo **hashea**. Son operaciones distintas:
>
> - **Encriptar** es reversible: con la clave correcta puedes recuperar el
>   texto original. Algoritmos como AES son cifrado.
> - **Hashear** es **irreversible**: una vez hasheado, no hay forma de
>   recuperar el texto original. Solo puedes comprobar si un texto candidato
>   produce el mismo hash. Argon2id es un algoritmo de hashing.
>
> Por eso `argon2.hash(token)` produce un hash, y para "comparar" después
> se usa `argon2.verify(hash, token)` — que internamente vuelve a hashear
> el token y compara los dos hashes en tiempo constante. Si necesitas
> seguir el código, busca **`argon2.hash(refreshToken, ...)`** — esa es
> la línea exacta.

---

**¿Desde dónde se llama el código que hashea?**

El hashing ocurre dentro de un único método privado: `issueTokens()`. Ese
método es llamado desde **tres puntos de entrada distintos** del controller:

```
                    ┌─ register()  → register en service → ⬇
POST /auth/register ─┤                                       │
                    └─                                        │
                                                              │
                    ┌─ login()                                ▼
POST /auth/login    ─┤  (después de validar credenciales) → issueTokens()
                    └─                                        │
                                                              │
                    ┌─ refreshToken()                          │
POST /auth/refresh  ─┤  (después de verificar refresh) ──────⬆
                    └─
```

Es decir: **cada vez** que el sistema necesita producir un par
(access + refresh) — primer login, registro nuevo, o renovación de tokens —
pasa por `issueTokens()`. Y dentro de `issueTokens()`, **siempre** se hashea
el refresh y se persiste en BD. No hay ninguna ruta alternativa.

---

**El código completo de `issueTokens()` con las cuatro fases marcadas**

**Archivo:** `src/auth/auth.service.ts`

```typescript
// issueTokens — firma access + refresh y guarda el hash del
// refresh en DB. Método privado reutilizado por register/login/refresh
private async issueTokens(user: User): Promise<AuthTokens> {

  // ─── PREPARACIÓN — payload del access token ────────────────────────
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    jti: randomUUID(),  // identificador único — necesario para blocklist
  };

  const issuer = this.configService.getOrThrow<string>('jwt.issuer');
  const audience = this.configService.getOrThrow<string>('jwt.audience');

  const accessOptions = {
    secret: this.configService.getOrThrow<string>('jwt.secret'),
    expiresIn: this.configService.getOrThrow<string>('jwt.expiration'),  // '15m'
    algorithm: 'HS256',
    issuer,
    audience,
  } as JwtSignOptions;

  const refreshOptions = {
    secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
    expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiration'),  // '7d'
    algorithm: 'HS256',
    issuer,
    audience,
  } as JwtSignOptions;


  // ═══════════════════════════════════════════════════════════════════
  // FASE 1 — Firmar el ACCESS token
  // No se hashea ni se guarda en BD. Vive solo en memoria del cliente.
  // ═══════════════════════════════════════════════════════════════════
  const accessToken = await this.jwtService.signAsync(payload, accessOptions);


  // ═══════════════════════════════════════════════════════════════════
  // FASE 2 — Firmar el REFRESH token
  // Resultado: un string JWT como "eyJhbGciOiJIUzI1NiJ9..."
  // En este momento el refresh token existe en TEXTO PLANO en memoria.
  // Aún no está en la BD.
  // ═══════════════════════════════════════════════════════════════════
  const refreshToken = await this.jwtService.signAsync(
    { sub: user.id },
    refreshOptions,
  );


  // ═══════════════════════════════════════════════════════════════════
  // FASE 3 — HASHEAR el refresh token con Argon2id  ← AQUÍ ES EL HASHING
  // ═══════════════════════════════════════════════════════════════════
  // argon2.hash() recibe el refresh token en texto plano y devuelve
  // un string como "$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>".
  // Es IRREVERSIBLE — del hash NO se puede recuperar el token original.
  // Los parámetros son los recomendados por OWASP Password Storage:
  //   - type: argon2id (resistente a GPU y a side-channel)
  //   - memoryCost: 65536 KB (= 64 MB de RAM por verificación)
  //   - timeCost: 3 (3 iteraciones)
  //   - parallelism: 4 (4 hilos)
  const refreshTokenHash = await argon2.hash(refreshToken, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });


  // ═══════════════════════════════════════════════════════════════════
  // FASE 4 — PERSISTIR el hash en la tabla users
  // ═══════════════════════════════════════════════════════════════════
  // TypeORM ejecuta:
  //   UPDATE users
  //   SET refresh_token_hash = '$argon2id$v=19$m=65536...'
  //   WHERE id = '<user.id>'
  // El refresh token en texto plano NUNCA toca la BD. Solo el hash.
  await this.userRepository.update(user.id, { refreshTokenHash });


  // ─── RETORNO — al controller ──────────────────────────────────────
  // El controller envía:
  //   - accessToken   → en el body de la respuesta
  //   - refreshToken  → en una cookie HttpOnly
  //   - El hash queda dentro de la BD; nunca sale al cliente.
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

**El momento exacto del hashing es la línea `argon2.hash(refreshToken, ...)`**
en la FASE 3. Antes de esa línea, el refresh token solo existe en una
variable de Node.js (memoria del proceso). Después de la FASE 4, el hash
está persistido en PostgreSQL y la tabla `users` queda así:

```
users
───────────────────────────────────────────────────────────────────────
id                | maría_id
email             | maria@clinica.com
isActive          | true
refresh_token_hash| $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
```

El **refresh token original** (el JWT en texto plano) viaja al cliente
dentro de la cookie HttpOnly. El **hash** se queda en la BD. Las dos cosas
son distintas y viven en sitios distintos — el método `verify()` en la
renovación (`argon2.verify(hash, tokenRecibido)`) es lo que permite
comprobar que el token que llega del cliente coincide con el hash guardado,
sin necesidad de tener el token original guardado en BD.

---

**¿Cuándo SE EJECUTA esta función realmente? — secuencia con tiempos**

Cronograma del primer login de María:

```
T = 09:00:00.000 — POST /auth/login con email + password
T = 09:00:00.010 — Passport ejecuta LocalStrategy.validate()
                   → AuthService.validateUser() comprueba password
                   → válido, retorna User
T = 09:00:00.150 — controller.login() llama a authService.login()
T = 09:00:00.151 — authService.login() llama a issueTokens(user)
                   ⬇  Aquí entramos en issueTokens
T = 09:00:00.152 — FASE 1: signAsync(accessOptions)
                   → accessToken = "eyJ..."
T = 09:00:00.153 — FASE 2: signAsync(refreshOptions)
                   → refreshToken = "eyJ..." (texto plano en memoria)
T = 09:00:00.300 — FASE 3: argon2.hash(refreshToken, {...})
                   ← TARDA ~150ms — argon2 está pensado para ser lento
                   → refreshTokenHash = "$argon2id$v=19$..."
T = 09:00:00.310 — FASE 4: userRepository.update(...)
                   → UPDATE users SET refresh_token_hash = ... WHERE id = ...
T = 09:00:00.320 — issueTokens retorna { accessToken, refreshToken, user }
T = 09:00:00.330 — controller envía respuesta:
                   - body: { accessToken, user }
                   - Set-Cookie: refresh_token=<token plano>
```

La FASE 3 (el hashing) es deliberadamente la operación más costosa en tiempo
del flujo — entre 100 y 300 ms dependiendo del servidor. Eso es **intencional**:
Argon2id está diseñado para ser lento para prevenir ataques de fuerza bruta
si la BD fuera robada. Un atacante con el hash y queriendo encontrar el token
original tendría que invertir ~150 ms de cómputo por intento, lo que hace
inviable un ataque de diccionario o fuerza bruta.

---

**Cuándo SE ROTA — cada renovación exitosa**

Cuando María hace `POST /auth/refresh` con su refresh token actual y todo
sale bien, `refreshToken()` llama internamente a `issueTokens()` otra vez.
Eso firma un **nuevo** refresh token, lo hashea y **sobrescribe** el hash
anterior. Resultado:

- El refresh token nuevo es la única credencial válida desde ese momento.
- El refresh token anterior, aunque siga siendo criptográficamente válido
  (firma OK, `exp` OK), **ya no coincide con el hash en BD** — está muerto.

Esto se llama **rotación de refresh tokens** y es una técnica estándar para
detectar robos: si dos peticiones llegan con el mismo refresh token, una
de ellas necesariamente está usando un token ya rotado, y eso delata al
ladrón. Lo veremos en el bloque de "reuso detectado" del propio método.

---

**Cuándo SE NULIFICA (`refreshTokenHash = null`) — tres situaciones**

El hash se pone a `null` deliberadamente en tres momentos distintos:

| Situación | Dónde ocurre | Por qué |
|---|---|---|
| **El usuario hace logout** | `auth.service.ts` → `logout()` | Se invalida la sesión voluntariamente |
| **Se detecta reuso de refresh token** | `auth.service.ts` → `refreshToken()` cuando `argon2.verify` falla | Se asume robo y se revoca toda la familia |
| **Un admin desactiva al usuario** | (indirectamente — el `isActive: false` corta antes) | No es necesario tocar el hash, pero el efecto es el mismo |

Los dos primeros son los relevantes para esta sección — son exactamente los
que el comentario del código menciona como "caso (a)" y "caso (b)".

---

**¿Por qué un refresh "con firma válida" puede llegar y NO tener hash en BD?**

Esta es la pregunta clave. La firma JWT y el hash en BD son **dos cosas
independientes** que se verifican en **dos momentos distintos**:

- **Firma JWT** — la verifica `controller.refresh()` con `jwtService.verifyAsync`.
  Comprueba: ¿está firmado con el secreto correcto?, ¿no ha expirado?, ¿el
  `iss` y `aud` coinciden? La firma vive **dentro del token**.

- **Hash en BD** — lo verifica `service.refreshToken()` con `argon2.verify`.
  Comprueba: ¿este refresh token coincide con el último hash que guardamos
  para este usuario? El hash vive **fuera del token**, en la fila `users`.

Un refresh token puede pasar la primera verificación (firma OK) y fallar
la segunda (hash en BD es `null` o no coincide), porque alguien — el propio
usuario al hacer logout, o el sistema al detectar reuso — **modificó la BD
después** de que el token fuera firmado.

Con esto en mente, ahora el código tiene sentido completo.

**Archivo:** `src/auth/auth.service.ts` — método `refreshToken()`

```typescript
async refreshToken(
  userId: string,
  refreshToken: string,
): Promise<AuthTokens> {
  // Cargamos el usuario con refreshTokenHash — findOne del servicio
  // lo excluye con select, así que aquí usamos el repo directo
  const user = await this.userRepository.findOne({
    where: { id: userId },
  });

  if (!user || !user.isActive) {
    throw new UnauthorizedException('Refresh token inválido');
  }

  //* [SECURE-FIX V1] Reuse detection — caso "sin hash activo".
  //* Si el usuario no tiene refreshTokenHash pero llega un refresh
  //* con firma válida, significa que: (a) ya hizo logout y alguien
  //* reenvía un token antiguo, o (b) la familia ya fue revocada por
  //* un reuso anterior. En ambos casos rechazamos.
  if (!user.refreshTokenHash) {
    this.logger.warn(
      `Refresh sin hash activo para userId ${userId} — posible reuso post-logout`,
    );
    throw new UnauthorizedException('Refresh token inválido');
  }

  // Comparamos el refresh token recibido contra el hash guardado
  const valid = await argon2.verify(user.refreshTokenHash, refreshToken);

  if (!valid) {
    // Reuse detectado — revoca la familia entera
    await this.userRepository.update(userId, { refreshTokenHash: null });
    throw new UnauthorizedException(
      'Reuso de refresh token detectado. Sesión revocada.',
    );
  }

  return this.issueTokens(user);
}
```

**Qué hay que entender — los tres bloques defensivos del método:**

**Bloque 1 — `if (!user || !user.isActive)`**

Primera comprobación. Si María fue desactivada (`isActive: false`), el `OR`
dispara y se lanza `UnauthorizedException`. El refresh token criptográficamente
válido **no sirve para nada**. Mensaje genérico `'Refresh token inválido'` —
deliberadamente no se distingue entre "usuario inexistente" y "usuario
desactivado" para no dar pistas a un atacante (OWASP A07).

**Bloque 2 — `if (!user.refreshTokenHash)` — el "caso sin hash activo"**

Esta es la línea que el comentario `[SECURE-FIX V1]` describe como casos
`(a)` y `(b)`. Ahora que entendemos el ciclo de vida del `refreshTokenHash`,
podemos descomponer cuándo se activa:

> **Caso (a) — "ya hizo logout y alguien reenvía un token antiguo"**
>
> Cronograma concreto:
>
> ```
> 09:00:00 — María hace login
>            issueTokens() firma refresh-A y guarda hash(refresh-A) en BD
>            users.refreshTokenHash = $argon2id$...$hash-de-A
>
> 09:30:00 — María (o un atacante con su token) hace POST /auth/logout
>            logout() ejecuta:
>              UPDATE users SET refresh_token_hash = NULL WHERE id = maría
>            users.refreshTokenHash = NULL  ← NULIFICADO
>
> 09:35:00 — Alguien (atacante, o un cliente confundido reintentando)
>            envía refresh-A al endpoint /auth/refresh.
>            controller.refresh() corre:
>              - jwtService.verifyAsync(refresh-A) → ✅ firma OK, exp OK
>              - llama a service.refreshToken(maríaId, refresh-A)
>
> 09:35:01 — service.refreshToken() corre:
>              - userRepository.findOne(maríaId) → User encontrado, isActive: true
>              - if (!user || !user.isActive) → no aplica, sigue
>              - if (!user.refreshTokenHash) → ¡ES NULL! → 🛑
>            throw UnauthorizedException('Refresh token inválido')
>            this.logger.warn('Refresh sin hash activo... posible reuso post-logout')
> ```
>
> El log `WARN` es importante: si en producción aparecen muchos de estos,
> sugiere que alguien está reintentando refresh tokens viejos — posible
> indicio de un cliente roto o, peor, un atacante con tokens antiguos.

> **Caso (b) — "la familia ya fue revocada por un reuso anterior"**
>
> Para entender este caso hay que adelantarse al Bloque 3 (más abajo):
> cuando `argon2.verify` falla, el método nulifica el hash. Eso significa
> que un reuso previo dejó la columna en `null`. Cualquier intento posterior
> con cualquier refresh token cae en este mismo bloque.
>
> Cronograma concreto:
>
> ```
> 10:00:00 — María hace login
>            users.refreshTokenHash = hash(refresh-1)
>
> 10:05:00 — María hace una renovación legítima
>            service.refreshToken(refresh-1) → emite refresh-2
>            users.refreshTokenHash = hash(refresh-2)   ← rotado
>            (refresh-1 ahora está "muerto" — su hash ya no es el activo)
>
> 10:06:00 — Un ATACANTE que había robado refresh-1 antes de la rotación
>            lo usa contra /auth/refresh
>            service.refreshToken(refresh-1) corre:
>              - hash en BD = hash(refresh-2)
>              - argon2.verify(hash(refresh-2), refresh-1) → ❌ no matchea
>              - Bloque 3 dispara: UPDATE refresh_token_hash = NULL
>            users.refreshTokenHash = NULL   ← FAMILIA REVOCADA
>            throw 'Reuso de refresh token detectado'
>
> 10:07:00 — María (legítima) intenta renovar con refresh-2
>            service.refreshToken(refresh-2) corre:
>              - if (!user.refreshTokenHash) → ¡ES NULL! → 🛑
>            throw 'Refresh token inválido'
>            ↑↑↑ ESTE ES EL CASO (b) ↑↑↑
> ```
>
> Lo importante del caso (b): el sistema **prefiere desconectar a María
> antes que arriesgarse a darle servicio a un atacante**. Si hay duda
> sobre quién es el dueño legítimo de la familia de tokens, la familia
> entera se revoca y María tendrá que volver a hacer login. Es una
> decisión de seguridad: la inconveniencia para el usuario legítimo
> es muy preferible al acceso continuado del atacante.

**Bloque 3 — `if (!valid)` — detección de reuso**

Es el bloque que dispara el escenario del caso (b). Si el hash en BD existe
pero no coincide con el token recibido, significa que alguien está usando
un token ya rotado. La respuesta del sistema:

```typescript
if (!valid) {
  // El hash no coincide: alguien está usando un token ya rotado → posible robo.
  // Revocamos la familia completa para forzar re-login en todos los dispositivos.
  await this.userRepository.update(userId, { refreshTokenHash: null });
  throw new UnauthorizedException(
    'Reuso de refresh token detectado. Sesión revocada.',
  );
}
```

Nulificar el hash mata simultáneamente al atacante y al usuario legítimo —
los dos tendrán que hacer login otra vez. El usuario legítimo lo notará y
posiblemente cambiará la contraseña por sospecha; el atacante simplemente
pierde el acceso.

**Volviendo al escenario de María (usuario desactivado por el admin):**

- El método **nunca llega a `argon2.verify(...)` ni a `issueTokens(user)`** si
  el usuario está desactivado. El Bloque 1 (`isActive`) corta antes.
- La cadena de emisión de nuevos access tokens queda cortada en la primera
  línea sin necesidad de tocar el hash.

**Aplicado al escenario:**

```
13:50:00 — Admin desactiva a María (isActive = false)

13:50:30 — El access token de María expira (situación normal a los 15 min
           de vida si tuvo login a las 13:35).
           El frontend recibe 401 e intenta renovar automáticamente.

13:50:31 — POST /api/v1/auth/refresh con la cookie del refresh token
           controller.refresh() verifica firma y exp del refresh — OK
           controller.refresh() llama a service.refreshToken(maríaId, token)

13:50:32 — service.refreshToken() corre:
             - userRepository.findOne(maríaId) → User { isActive: false }
             - if (!user || !user.isActive) → throw UnauthorizedException
           🛑 401 — Refresh token inválido

           El frontend interpreta el 401 del refresh como "sesión muerta"
           y redirige a /login (o muestra "sesión expirada").
```

---

#### Paso 5 — La verificación `isActive` al hacer login

Si María intenta hacer login otra vez con su email y contraseña — porque el
frontend la mandó al login después del fallo del refresh — también se le bloquea.

**Archivo:** `src/auth/auth.service.ts` — método `validateUser()`

```typescript
// validateUser — usado por LocalStrategy y por login()
// Retorna User si las credenciales son válidas, null si no
async validateUser(email: string, password: string): Promise<User | null> {
  const user = await this.usersService.findByEmail(email);

  // Si el usuario no existe o está desactivado retornamos null
  // sin indicar al atacante cuál de las dos condiciones falla
  if (!user || !user.isActive) {
    return null;
  }

  // argon2.verify() hace comparación en tiempo constante
  // evitando timing attacks — OWASP A02:2025
  const valid = await argon2.verify(user.passwordHash, password);

  if (!valid) {
    return null;
  }

  return user;
}
```

**Qué hay que entender:**

- **`findByEmail(email)`** — busca al usuario por su email. Devuelve el User
  completo (incluyendo `passwordHash`) o `null` si no existe.
- **`if (!user || !user.isActive) return null`** — el `null` se devuelve tanto
  si el email no existe como si el usuario está desactivado. Esto es
  intencional para prevenir enumeración de usuarios (OWASP A07).
- **El `null` provoca que `LocalStrategy.validate()` lance
  `UnauthorizedException('Credenciales inválidas')`** (recordando el flujo de
  Passport Local).

**Aplicado al escenario:**

```
13:51:00 — María intenta hacer login otra vez
           POST /api/v1/auth/login { email: maria@..., password: ... }

13:51:01 — LocalStrategy.validate(email, password) corre:
             - authService.validateUser(email, password)
                 ├─ findByEmail → User { isActive: false }
                 ├─ if (!user || !user.isActive) → return null
                 └─ ⚠ Ni siquiera llega a argon2.verify
             - validateUser devuelve null
             - LocalStrategy lanza UnauthorizedException('Credenciales inválidas')
           🛑 401 — Credenciales inválidas (mensaje genérico)

           María (o el atacante) ve "Credenciales inválidas" y no sabe si
           es porque el password está mal o porque está desactivada.
```

---

### El efecto en cascada — los tres vectores de ataque bloqueados

Una vez que `isActive = false`, los tres vectores posibles quedan cerrados:

| Vector | Dónde se bloquea | Mensaje al usuario |
|---|---|---|
| **Usar el access token actual** | `JwtStrategy.validate()` → `if (!user.isActive)` | `401 Usuario desactivado` |
| **Renovar con el refresh token** | `AuthService.refreshToken()` → `if (!user || !user.isActive)` | `401 Refresh token inválido` |
| **Hacer login con email/password** | `AuthService.validateUser()` → `if (!user || !user.isActive)` | `401 Credenciales inválidas` |

Los tres puntos de control comparten una característica fundamental: **leen el
estado actual de la BD en cada petición**. La BD es la fuente de verdad. Los
tokens (access y refresh) son solo presentaciones — pueden ser válidos
criptográficamente, pero si la fuente de verdad dice que el usuario está
desactivado, la presentación se rechaza.

---

### Diagrama del flujo completo de la Pregunta 2

```
ESTADO INICIAL (María activa)
  │
  └─ users tabla:
       id: maría_id
       isActive: true
       refreshTokenHash: <hash actual>

ADMIN DESACTIVA A MARÍA (13:50:00)
  │
  ├─ DELETE /users/:id (solo ADMIN, JwtAuthGuard + RolesGuard)
  │
  └─ usersService.remove()
       └─ user.isActive = false
       └─ UPDATE users SET is_active = false WHERE id = maría_id

A PARTIR DE ESTE INSTANTE — TRES VECTORES BLOQUEADOS

Vector 1: Access token actual (criptográficamente válido aún)
  │
  └─ Cada petición → validate()
       ├─ usersService.findOne(maría_id) → { isActive: false }
       └─ throw UnauthorizedException('Usuario desactivado')
            └─ HTTP 401

Vector 2: Refresh para obtener nuevo access token
  │
  └─ POST /auth/refresh → service.refreshToken()
       ├─ userRepository.findOne(maría_id) → { isActive: false }
       └─ throw UnauthorizedException('Refresh token inválido')
            └─ HTTP 401

Vector 3: Login con email + password
  │
  └─ POST /auth/login → LocalStrategy.validate() → service.validateUser()
       ├─ findByEmail(email) → { isActive: false }
       ├─ return null  (sin llegar a argon2.verify)
       └─ LocalStrategy lanza UnauthorizedException
            └─ HTTP 401 'Credenciales inválidas'

EXPIRACIÓN NATURAL (irrelevante, pero ocurre)
  │
  ├─ Access token expira a los 15 min  → 401 por exp
  └─ Refresh token expira a los 7 días → 401 por exp
       (No hace falta esperar a esto — los tres vectores ya están bloqueados)
```

---

### Resumen de archivos involucrados — Pregunta 2

| Archivo | Método / Campo | Qué aporta |
|---|---|---|
| `users/entities/user.entity.ts` | Campo `isActive: boolean` | Estado mutable que controla si el usuario puede operar |
| `users/users.controller.ts` | `@Delete(':id') remove()` | Endpoint público para que un ADMIN desactive |
| `users/users.controller.ts` | `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(ADMIN)` | Garantiza que solo admins pueden desactivar |
| `users/users.service.ts` | `remove()` | Pone `isActive = false` y persiste (soft delete) |
| `auth/strategies/jwt.strategy.ts` | `validate()` → `if (!user.isActive)` | Bloquea el access token actual en cada petición |
| `auth/auth.service.ts` | `refreshToken()` → `if (!user || !user.isActive)` | Bloquea la renovación de tokens |
| `auth/auth.service.ts` | `validateUser()` → `if (!user || !user.isActive)` | Bloquea el login con email/password |

---

## Conclusión — La diferencia entre las dos preguntas

Ambas preguntas tratan sobre **revocación de tokens antes de su expiración natural**,
pero usan mecanismos distintos porque el evento que las dispara es distinto:

| Aspecto | Pregunta 1 — Logout | Pregunta 2 — Baja del usuario |
|---|---|---|
| **Quién lo dispara** | El propio usuario al cerrar sesión | Un administrador desactivando una cuenta |
| **Granularidad** | Una sesión específica (un `jti`) | Todas las sesiones del usuario, presentes y futuras |
| **Mecanismo** | Blocklist en Valkey indexada por `jti` | Estado `isActive` en BD consultado en cada petición |
| **Permanencia** | Temporal — la entrada caduca con el TTL del token | Permanente — el flag queda en BD hasta que un admin lo cambie |
| **Coste por petición** | 1 lectura de Valkey (microsegundos) | 1 lectura de PostgreSQL (milisegundos) |
| **Comportamiento si la infra falla** | Fail-open (Valkey) — degradación temporal aceptada | No hay fallback — `isActive` es la fuente de verdad |

Las dos defensas trabajan juntas en `JwtStrategy.validate()`. Primero `isActive`
(BD), después la blocklist (Valkey). Si cualquiera de las dos rechaza, la
petición se bloquea. Es **defense in depth** aplicada a la autenticación: dos
capas independientes con orígenes distintos, motivos distintos y modos de
fallo distintos.
