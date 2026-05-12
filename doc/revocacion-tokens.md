# Revocación de tokens — Dos escenarios críticos

---

## Escenario 1 — Un usuario deja la organización

### El problema

Un usuario tiene un refresh token firmado que no expira hasta dentro de 7 días. Si simplemente borramos su cuenta o la desactivamos, el token sigue siendo matemáticamente válido: su firma criptográfica es correcta, su fecha de expiración no ha llegado. Nada en el token en sí mismo indica que el usuario ya no debería tener acceso.

Un atacante que tenga ese refresh token podría seguir solicitando nuevos access tokens durante una semana entera.

### Cómo lo resuelve esta API

La solución no toca el token. En cambio, pone dos barreras en la DB que el token tiene que cruzar en cada uso:

**Barrera 1 — Cada request con access token consulta `isActive`**

Cada petición autenticada pasa por `JwtStrategy.validate()`. Antes de aprobar el request, este método carga el usuario desde la DB y comprueba `isActive`:

```typescript
// src/auth/strategies/jwt.strategy.ts

async validate(payload: JwtPayload) {
  // Carga el usuario en cada request — no confía solo en el payload del token
  const user = await this.usersService.findOne(payload.sub);

  // Si el admin desactivó al usuario, este check falla inmediatamente
  // aunque el token tenga firma válida y no haya expirado
  if (!user.isActive) {
    throw new UnauthorizedException('Usuario desactivado');
  }

  // ... resto de validaciones (blocklist Valkey)

  return { id: user.id, email: user.email, role: user.role };
}
```

En el momento en que el admin desactiva al usuario, el siguiente request con su access token devuelve **401** — aunque el token tenga horas de vida por delante.

**Barrera 2 — El refresh también comprueba `isActive`**

Cuando el usuario intenta renovar su access token con el refresh, `authService.refreshToken()` también carga el usuario y verifica `isActive` antes de continuar:

```typescript
// src/auth/auth.service.ts

async refreshToken(userId: string, refreshToken: string): Promise<AuthTokens> {
  const user = await this.userRepository.findOne({
    where: { id: userId },
  });

  // Si el usuario no existe o fue desactivado → 401 inmediato
  // El refresh token de 7 días queda completamente inútil
  if (!user || !user.isActive) {
    throw new UnauthorizedException('Refresh token inválido');
  }

  // ... comparación de hash y rotación
}
```

Con `isActive = false` en la DB, el refresh de 7 días no puede emitir ningún token nuevo. La cadena de renovación está cortada.

### La acción del admin — soft delete

Cuando un admin llama a `DELETE /users/:id`, el servicio no borra el registro. Hace un **soft delete**: pone `isActive = false` y guarda. El usuario sigue en la DB (para mantener integridad referencial con historiales, citas, etc.) pero queda bloqueado:

```typescript
// src/users/users.service.ts

async remove(id: string): Promise<void> {
  const user = await this.findOne(id);

  // Soft delete — el registro permanece pero isActive = false
  // activa las barreras en validate() y refreshToken()
  user.isActive = false;
  await this.userRepository.save(user);
}
```

Este endpoint solo es accesible para administradores:

```typescript
// src/users/users.controller.ts

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)          // ← solo ADMIN puede llamar a este endpoint
@Controller('users')
export class UsersController {

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.remove(id);
  }
}
```

### Flujo completo

```
Admin llama a DELETE /users/:id
        │
        ▼
UsersService.remove(id)
  └─ user.isActive = false
  └─ userRepository.save(user)    ← un solo UPDATE en DB, efecto inmediato

Usuario desactivado hace cualquier request:
        │
        ▼
JwtStrategy.validate()
  └─ usersService.findOne(sub)    ← carga usuario de DB
  └─ user.isActive = false        ← 401 Usuario desactivado
        │
        ▼
  ← 401 Unauthorized

Usuario desactivado intenta hacer refresh:
        │
        ▼
authService.refreshToken()
  └─ userRepository.findOne(id)   ← carga usuario de DB
  └─ !user.isActive               ← 401 Refresh token inválido
        │
        ▼
  ← 401 Unauthorized
```

Un único `UPDATE` en la DB bloquea todos los tokens activos del usuario de forma instantánea, sin necesidad de conocer cuántos tokens tiene ni cuándo expiran.

---

## Escenario 2 — El usuario cierra sesión pero su access token aún tiene 10 minutos

### El problema

Los JWT son stateless: el servidor no guarda ningún registro de qué tokens ha emitido. La validez de un token se verifica únicamente por su firma criptográfica y su fecha de expiración. Si el usuario hace logout, el servidor puede borrar su refresh token de la DB, pero **no tiene forma directa de anular el access token que ya está en circulación**.

El access token seguiría siendo válido durante sus 10 minutos restantes. Si alguien lo robó antes del logout (XSS, intercepción, log que expuso el header), puede seguir usándolo.

### Cómo lo resuelve esta API — blocklist en Valkey

En el momento del logout, el servidor toma el access token, extrae su identificador único (`jti`) y lo guarda en Valkey con un tiempo de vida exactamente igual a los segundos que le quedan al token:

```typescript
// src/auth/auth.service.ts

async logout(userId: string, accessToken: string): Promise<void> {
  // decode() extrae el payload sin verificar firma
  // La firma ya fue verificada por JwtAuthGuard antes de llegar aquí
  const decoded = this.jwtService.decode<{ jti?: string; exp?: number }>(accessToken);

  if (decoded?.jti && decoded?.exp) {
    // TTL = segundos que le quedan al token hasta su expiración natural
    // Si el token expira a las 14:10 y son las 14:00 → ttl = 600 segundos
    const ttl = decoded.exp - Math.floor(Date.now() / 1000);

    if (ttl > 0) {
      try {
        // Guarda el jti en Valkey
        // Clave:  blocklist:at:{jti}   (namespaced para evitar colisiones)
        // Valor:  "1"                  (solo importa si existe o no)
        // EX ttl: se auto-elimina exactamente cuando el token habría expirado
        await this.valkeyClient.set(`blocklist:at:${decoded.jti}`, '1', 'EX', ttl);
      } catch (err) {
        this.logger.error(`Blocklist Valkey error en logout: ${(err as Error).message}`);
        // Fail-open: si Valkey falla, el refresh se invalida igual (ver abajo)
      }
    }
  }

  // SIEMPRE se ejecuta, independientemente de si Valkey funcionó
  // Invalida el refresh token borrando su hash en DB
  await this.userRepository.update(userId, { refreshTokenHash: null });
}
```

### La consulta en cada request — el GET que bloquea el token

Cada petición autenticada, en `JwtStrategy.validate()`, hace un `GET` en Valkey con el `jti` del token recibido:

```typescript
// src/auth/strategies/jwt.strategy.ts

async validate(payload: JwtPayload) {
  const user = await this.usersService.findOne(payload.sub);
  if (!user.isActive) {
    throw new UnauthorizedException('Usuario desactivado');
  }

  try {
    // Consulta si el jti de este token está en la blocklist
    // Si el usuario hizo logout, este GET devuelve "1"
    const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
    if (blocked) {
      throw new UnauthorizedException('Token revocado');
    }
  } catch (err) {
    if (err instanceof UnauthorizedException) throw err;
    this.logger.error(`Valkey blocklist check fallido — fail-open`);
  }

  return { id: user.id, email: user.email, role: user.role };
}
```

### Por qué el TTL coincide exactamente con la vida residual del token

El diseño es deliberado. Hay dos momentos de expiración que deben sincronizarse:

| Qué | Cuándo expira |
|---|---|
| El token JWT | Cuando `exp` llega — Passport lo rechaza automáticamente |
| La clave en Valkey | Cuando TTL llega a cero — Valkey la borra automáticamente |

Si el TTL de Valkey fuera más largo que la vida del token, la clave quedaría en Valkey sin utilidad (el token ya no pasaría el check de expiración de Passport antes de llegar al GET). Si fuera más corto, habría una ventana donde el token no está en la blocklist pero tampoco ha expirado.

Con `TTL = exp - ahora`, los dos relojes expiran al mismo tiempo. En el momento en que el token deja de ser válido por expiración, la clave en Valkey ya no existe. No hay acumulación de claves muertas.

### Flujo completo con 10 minutos restantes

```
Usuario llama a POST /auth/logout  (access token con 10 min restantes)
        │
        ▼
JwtAuthGuard valida el token → válido → pasa
        │
        ▼
AuthController.logout()
  └─ authService.logout(userId, accessToken)
        │
        ├─ decode(accessToken)
        │     └─ jti: "550e8400-..."
        │     └─ exp: 1714000800  (unix timestamp)
        │     └─ ttl: 600 segundos  (10 minutos)
        │
        ├─ OPERACIÓN 1 — Valkey
        │     └─ SET blocklist:at:550e8400-... "1" EX 600
        │          └─ La clave vivirá exactamente 10 minutos
        │
        └─ OPERACIÓN 2 — DB (se ejecuta siempre)
              └─ UPDATE users SET refreshTokenHash = null WHERE id = userId

Respuesta al cliente: 204 No Content + cookie refresh_token eliminada

─────────────────────────────────────────────────────────────

Atacante intenta usar el access token robado (minuto 3 de los 10):
        │
        ▼
JwtAuthGuard → firma y exp válidos → pasa a validate()
        │
        ▼
JwtStrategy.validate()
  └─ usersService.findOne(sub) → isActive = true → continúa
  └─ valkeyClient.GET blocklist:at:550e8400-...
        └─ devuelve "1"  → throw UnauthorizedException('Token revocado')
        │
        ▼
  ← 401 Unauthorized

─────────────────────────────────────────────────────────────

10 minutos después:
  • Valkey borra la clave automáticamente (TTL = 0)
  • El token JWT expira (exp alcanzado)
  • Passport rechaza el token antes de llegar a validate()
  • La blocklist ya no es necesaria — el token no puede usarse de ninguna forma
```

### Qué ocurre en Valkey durante esos 10 minutos

```bash
# Justo después del logout
redis-cli GET "blocklist:at:550e8400-e29b-41d4-a716-446655440000"
# "1"

redis-cli TTL "blocklist:at:550e8400-e29b-41d4-a716-446655440000"
# 597  (segundos restantes — van bajando)

# A los 10 minutos exactos
redis-cli GET "blocklist:at:550e8400-e29b-41d4-a716-446655440000"
# (nil)  ← Valkey la borró automáticamente al llegar a 0
```

---

## Comparación de los dos mecanismos

| | Baja de usuario | Logout con token activo |
|---|---|---|
| **Dónde se persiste** | DB — campo `isActive` | Valkey — clave `blocklist:at:{jti}` |
| **Quién lo activa** | Admin vía `DELETE /users/:id` | El propio usuario vía `POST /auth/logout` |
| **Efecto sobre access token** | 401 en el siguiente request | 401 en el siguiente request |
| **Efecto sobre refresh token** | 401 al intentar renovar (`isActive = false`) | Hash nulificado en DB |
| **Duración de la medida** | Permanente (hasta reactivar el usuario) | Exactamente los segundos residuales del token |
| **Limpieza automática** | Manual (el registro queda en DB) | Automática — Valkey borra la clave al expirar TTL |
| **Consulta en cada request** | `findOne(sub)` → `isActive` | `GET blocklist:at:{jti}` |

Ambos mecanismos actúan en `JwtStrategy.validate()`, que se ejecuta en cada request autenticado. El orden importa: primero se comprueba `isActive` (DB), luego la blocklist (Valkey). Si el usuario está desactivado, ni siquiera se consulta Valkey.
