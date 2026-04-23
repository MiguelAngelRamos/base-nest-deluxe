# Preguntas frecuentes: Refresh Token y Seguridad de Sesión

---

## 1. ¿Cuándo `refreshTokenHash` es `null` en DB?

Son exactamente **dos casos**, no los 7 días:

| Caso | ¿Por qué queda null? |
|---|---|
| **Logout** | `logout()` hace `UPDATE users SET refresh_token_hash = null` explícitamente |
| **Reuse detection** | `refreshToken()` hace lo mismo cuando el hash no coincide |

Cuando los **7 días expiran**, el hash en DB **NO se borra solo**. Lo que ocurre es diferente: el token tiene `exp` dentro de su firma JWT. El `RefreshTokenGuard` llama a `jwtService.verify()` con `ignoreExpiration: false`, y si el token caducó, la librería lanza un error **antes** de que el código llegue a `argon2.verify()`. El hash queda en DB hasta el próximo login.

---

## 2. ¿Cómo compara el hash de un token ya caducado?

**No lo compara.** El flujo tiene dos capas en orden:

```
Request POST /auth/refresh
        │
        ▼
RefreshTokenGuard → jwtService.verify() con la firma del token
        │
        ├─ Token expirado (7d pasados) → 401 aquí, nunca llega a argon2
        │
        └─ Firma válida, no expirado → pasa al authService.refreshToken()
                        │
                        ▼
                  argon2.verify(hashEnDB, tokenRecibido)
```

El escenario de "alguien usa un token viejo" significa: el token **tiene firma válida y no expiró** (sigue dentro de los 7 días), pero el hash en DB ya fue **sobreescrito** porque el usuario legítimo ya hizo un refresh y obtuvo un par nuevo. El atacante quedó con el token anterior.

---

## 3. ¿Cómo pudo alguien tener el refresh token si es HttpOnly?

`HttpOnly` bloquea únicamente **JavaScript** (protege de XSS). No bloquea:
- Acceso físico/lógico al dispositivo del usuario (malware, acceso al perfil del navegador)
- El propio navegador envía la cookie automáticamente en cada request al path `/api/v1/auth/refresh`

La reuse detection es **defensa en profundidad**: si por cualquier vía el atacante extrae la cookie del dispositivo y la usa, en cuanto el usuario legítimo haga el próximo refresh, se detecta la discrepancia y se revoca toda la familia.

---

## 4. Los 15 minutos del access token cuando alguien abandona la organización

Ya está resuelto en `src/auth/strategies/jwt.strategy.ts`. El método `validate()` ejecuta en **cada request autenticado**:

```typescript
async validate(payload: JwtPayload) {
  // ← esto ejecuta en CADA request autenticado
  const user = await this.usersService.findOne(payload.sub);

  if (!user.isActive) {
    throw new UnauthorizedException('Usuario desactivado');
  }
}
```

El flujo cuando alguien abandona la organización:

1. Admin pone `isActive = false` y borra `refreshTokenHash`
2. El próximo request del ex-empleado con su access token llega al guard
3. `validate()` hace una query a DB, encuentra `isActive = false`
4. **Rechaza inmediatamente con 401**, sin esperar los 15 minutos

La ventana de exposición no es 15 minutos — es el tiempo entre la desactivación y el próximo request del usuario, que normalmente son segundos. El costo es **una query a DB por cada request autenticado**, que es el trade-off deliberado que hace este diseño al no ser 100% stateless.
