# Refresh Token y Rotación de Tokens

## Arquitectura general

El sistema usa **dos JWT distintos** con secretos separados:

| Token | Duración | Transporte |
|---|---|---|
| **Access token** | 15 minutos | `Authorization: Bearer` header |
| **Refresh token** | 7 días | Cookie `HttpOnly` |

Tener secretos separados es crítico: si uno se compromete, el otro sigue siendo válido.

---

## 1. Configuración de JWT

**Archivo:** `src/config/jwt.config.ts`

```typescript
// Dos secretos completamente independientes
JWT_SECRET         → firma el access token
JWT_REFRESH_SECRET → firma el refresh token
```

Los secretos deben tener mínimo 32 caracteres. Si no se cumple en producción, la aplicación falla al arrancar.

---

## 2. Emisión de tokens

**Archivo:** `src/auth/auth.service.ts`

```typescript
private async issueTokens(user: User): Promise<TokenPair> {
  // Payload mínimo: solo id, email y role
  const payload = { sub: user.id, email: user.email, role: user.role };

  // Access token — 15 minutos
  const accessToken = this.jwtService.sign(payload, {
    secret: this.jwtConfig.secret,
    expiresIn: this.jwtConfig.expiration, // '15m'
  });

  // Refresh token — 7 días, con SECRETO DIFERENTE
  const refreshToken = this.jwtService.sign(payload, {
    secret: this.jwtConfig.refreshSecret,
    expiresIn: this.jwtConfig.refreshExpiration, // '7d'
  });

  // NUNCA se guarda el refresh token en texto plano.
  // Se hashea con Argon2id antes de guardar en DB.
  const refreshTokenHash = await argon2.hash(refreshToken, {
    type: argon2.argon2id,
    memoryCost: 65536,  // 64 MB de memoria
    timeCost: 3,        // 3 iteraciones
    parallelism: 4,     // 4 hilos
  });

  // Solo el HASH va a la base de datos
  await this.usersService.updateRefreshToken(user.id, refreshTokenHash);

  return { accessToken, refreshToken };
}
```

> **Por qué hashear el refresh token?**
> Si la base de datos se filtra, el atacante obtiene solo el hash (inútil para usarlo como token). Es el mismo principio que hashear contraseñas.

---

## 3. Rotación y detección de reutilización

**Archivo:** `src/auth/auth.service.ts`

Esta es la parte más importante del sistema. Cuando el cliente llama a `POST /auth/refresh`:

```typescript
async refreshToken(userId: string, refreshToken: string): Promise<TokenPair> {
  // 1. Busca al usuario en DB (trae el refreshTokenHash)
  const user = await this.usersService.findOneWithRefreshToken(userId);

  // 2. Si el usuario no existe o no tiene hash guardado → acceso denegado
  if (!user || !user.refreshTokenHash) {
    throw new UnauthorizedException('Refresh token inválido');
  }

  // 3. Compara el token recibido contra el hash guardado
  const tokenMatches = await argon2.verify(user.refreshTokenHash, refreshToken);

  if (!tokenMatches) {
    // ⚠️  DETECCIÓN DE REUTILIZACIÓN:
    // Si el hash no coincide, alguien está intentando usar un token viejo
    // (ya rotado). Esto indica posible robo de token.
    // → Se invalida TODO: se borra el hash, forzando nuevo login.
    await this.usersService.updateRefreshToken(user.id, null);
    throw new UnauthorizedException('Token reuse detected');
  }

  // 4. Token válido → emitir NUEVO par de tokens (rotación).
  // El token viejo queda automáticamente inválido porque el hash
  // en DB se sobreescribe con el nuevo hash.
  return this.issueTokens(user);
}
```

### Flujo de rotación normal

```
Cliente                         Servidor
  |                                |
  |--- refresh token viejo ------->|
  |                                | verifica hash ✓
  |                                | genera nuevo par
  |                                | guarda nuevo hash (sobreescribe viejo)
  |<-- nuevo access + refresh -----|
  |                                |
  | (el token viejo ya no sirve)   |
```

### Flujo de detección de reutilización

```
Atacante usa token viejo ------->|
                                 | hash no coincide (ya fue rotado)
                                 | → borra hash en DB
                                 | → TODOS los refresh tokens quedan inválidos
                                 | → usuario debe hacer login nuevamente
```

---

## 4. Cookie HttpOnly

**Archivo:** `src/auth/auth.controller.ts`

```typescript
// El refresh token NUNCA va en el body de la respuesta.
// Va en una cookie con múltiples protecciones:
res.cookie('refreshToken', tokens.refreshToken, {
  httpOnly: true,                        // JS del navegador NO puede leerla (protege de XSS)
  secure: true,                          // Solo se envía por HTTPS
  sameSite: 'strict',                    // No se envía en requests cross-site (protege de CSRF)
  path: '/api/v1/auth/refresh',          // La cookie SOLO se envía a este endpoint
  maxAge: 7 * 24 * 60 * 60 * 1000,      // 7 días en milisegundos
});

// El access token sí va en el body (el cliente lo guarda en memoria)
return { accessToken: tokens.accessToken };
```

> **Por qué restringir el `path`?**
> Aunque la cookie exista en el navegador, este **solo la adjunta** al endpoint `/api/v1/auth/refresh`. Ninguna otra ruta recibe el refresh token, limitando la superficie de exposición.

---

## 5. Endpoint de refresh

**Archivo:** `src/auth/auth.controller.ts`

```typescript
@Public()                    // No requiere access token (es para renovarlo)
@UseGuards(RefreshTokenGuard) // Pero sí valida la firma JWT del refresh token
@Post('refresh')
async refresh(@Req() req: Request, @Res() res: Response) {
  // El guard ya verificó la firma JWT del refresh token.
  // req.user contiene el payload decodificado ({ sub, email, role }).
  const userId = req.user['sub'];

  // La cookie viene parseada automáticamente por cookie-parser
  const refreshToken = req.cookies['refreshToken'];

  // Valida el hash en DB y emite nuevos tokens (rotación)
  const tokens = await this.authService.refreshToken(userId, refreshToken);

  // Reemplaza la cookie con el NUEVO refresh token
  this.setRefreshTokenCookie(res, tokens.refreshToken);

  // Devuelve solo el access token en el body
  return res.json({ accessToken: tokens.accessToken });
}
```

---

## 6. Logout

**Archivo:** `src/auth/auth.service.ts`

```typescript
async logout(userId: string): Promise<void> {
  // Borra el hash en DB → el refresh token existente queda inútil
  await this.usersService.updateRefreshToken(userId, null);
}
```

> El access token sigue válido hasta que expire (15 min), pero como no hay sesión en servidor que invalidar, esto es aceptable por diseño (JWT stateless). El tiempo de exposición máximo es 15 minutos.

---

## 7. Almacenamiento en base de datos

**Archivo:** `src/users/entities/user.entity.ts`

```typescript
// Solo se guarda el hash, nunca el token en texto plano
@Column({ name: 'refresh_token_hash', type: 'varchar', nullable: true })
refreshTokenHash!: string | null;
// nullable: true permite representar "sesión cerrada" con null
```

---

## Modelo de seguridad

| Amenaza | Mitigación |
|---|---|
| XSS roba refresh token | Cookie `httpOnly` — JS no puede acceder |
| CSRF usa la cookie | `sameSite: strict` + `path` restringido |
| Base de datos filtrada | Refresh token hasheado con Argon2id |
| Token robado y reutilizado | Detección de reuse → invalidación total |
| Algorithm confusion attack | HS256 fijado en la estrategia JWT |
| Brute force al endpoint | Rate limiting: 10 req/min en `/refresh` |
| Usuario desactivado reutiliza token | `JwtStrategy.validate()` verifica `isActive` en cada request |

---

## Referencias

- [RFC 6749 Section 10.4 — Refresh Tokens](https://datatracker.ietf.org/doc/html/rfc6749#section-10.4)
- [OWASP — Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Argon2 Password Hashing](https://github.com/P-H-C/phc-winner-argon2)
