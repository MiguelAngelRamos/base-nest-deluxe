# Diagramas de Secuencia — Clinic API

Los cuatro flujos más críticos de la API son:

1. **Login con emisión de tokens** — el punto de entrada de toda sesión autenticada
2. **Refresco de token con detección de reuso** — rotación + detección de robo
3. **Logout con revocación de access token vía blocklist** — invalidación en tiempo real
4. **Creación de cita médica con validaciones de negocio** — el flujo de dominio central

---

## Flujo 1: Autenticación (POST /api/v1/auth/login)

```mermaid
sequenceDiagram
    actor Cliente
    participant ThrottlerGuard
    participant LocalAuthGuard
    participant LocalStrategy
    participant AuthController
    participant AuthService
    participant UsersService
    participant UserRepo as Repository<User>
    participant JwtService
    participant DB as PostgreSQL

    Cliente->>ThrottlerGuard: POST /api/v1/auth/login { email, password }
    ThrottlerGuard->>ThrottlerGuard: Verifica límite 5 rpm por IP
    alt Límite superado
        ThrottlerGuard-->>Cliente: 429 Too Many Requests
    end

    ThrottlerGuard->>LocalAuthGuard: request pasa
    LocalAuthGuard->>LocalStrategy: authenticate()
    LocalStrategy->>AuthService: validateUser(email, password)
    AuthService->>UsersService: findByEmail(email)
    UsersService->>UserRepo: findOne WHERE email = $1
    UserRepo->>DB: SELECT * FROM users WHERE email = $1
    DB-->>UserRepo: User row (con passwordHash)
    UserRepo-->>UsersService: User | null

    alt Usuario no existe
        AuthService-->>LocalStrategy: null
        LocalStrategy-->>LocalAuthGuard: false
        LocalAuthGuard-->>Cliente: 401 Unauthorized
    end

    AuthService->>AuthService: argon2.verify(passwordHash, password)
    alt Contraseña incorrecta
        AuthService-->>LocalStrategy: null
        LocalStrategy-->>LocalAuthGuard: false
        LocalAuthGuard-->>Cliente: 401 Unauthorized
    end

    AuthService-->>LocalStrategy: User (válido)
    LocalStrategy-->>LocalAuthGuard: req.user = AuthenticatedUser
    LocalAuthGuard-->>AuthController: handler invocado

    AuthController->>AuthService: login(req.user)
    AuthService->>AuthService: issueTokens(userId, email, role)
    Note over AuthService: payload = { sub, email, role, jti: randomUUID() }<br/>HS256 + iss=clinic-api + aud=clinic-web
    AuthService->>JwtService: signAsync(payload, { secret: JWT_SECRET, expiresIn: 15m, algorithm: HS256, iss, aud })
    JwtService-->>AuthService: accessToken (con jti)
    AuthService->>JwtService: signAsync({sub}, { secret: JWT_REFRESH_SECRET, expiresIn: 7d, algorithm: HS256, iss, aud })
    JwtService-->>AuthService: refreshToken
    AuthService->>AuthService: argon2.hash(refreshToken)
    AuthService->>UserRepo: UPDATE users SET refresh_token_hash = $1 WHERE id = $2
    UserRepo->>DB: UPDATE
    DB-->>UserRepo: OK

    AuthService-->>AuthController: { accessToken, refreshToken }
    AuthController->>AuthController: res.cookie('refresh_token', refreshToken, { httpOnly, sameSite:strict, secure })
    AuthController-->>Cliente: 200 { accessToken } + Set-Cookie: refresh_token=...
```

---

## Flujo 2: Refresco de token (POST /api/v1/auth/refresh)

Este flujo implementa **refresh token rotation** con detección de reuso: si el hash almacenado no coincide con el token recibido, se revoca toda la familia (logout forzado).

```mermaid
sequenceDiagram
    actor Cliente
    participant ThrottlerGuard
    participant JwtAuthGuard
    participant AuthController
    participant AuthService
    participant JwtService
    participant UserRepo as Repository<User>
    participant DB as PostgreSQL

    Cliente->>ThrottlerGuard: POST /api/v1/auth/refresh (Cookie: refresh_token=<RT>)
    ThrottlerGuard->>ThrottlerGuard: Verifica límite 10 rpm por IP
    alt Límite superado
        ThrottlerGuard-->>Cliente: 429 Too Many Requests
    end

    ThrottlerGuard->>JwtAuthGuard: request pasa
    JwtAuthGuard->>JwtAuthGuard: Detecta @Public() en el handler
    JwtAuthGuard-->>AuthController: permite sin verificar Bearer

    AuthController->>AuthController: Extrae refreshToken de req.cookies['refresh_token']
    alt Cookie ausente
        AuthController-->>Cliente: 401 Unauthorized (no refresh token)
    end

    AuthController->>AuthService: refreshToken(incomingRT)
    AuthService->>JwtService: verify(incomingRT, { secret: JWT_REFRESH_SECRET, issuer, audience })
    alt Token inválido o expirado
        AuthService-->>AuthController: throw UnauthorizedException
        AuthController-->>Cliente: 401 Unauthorized
    end

    JwtService-->>AuthService: payload { sub, email, role }
    AuthService->>UserRepo: findOne WHERE id = payload.sub
    UserRepo->>DB: SELECT * FROM users WHERE id = $1
    DB-->>UserRepo: User row (con refreshTokenHash)

    alt Usuario inactivo o sin refreshTokenHash
        AuthService-->>AuthController: throw UnauthorizedException
        AuthController-->>Cliente: 401 Unauthorized
    end

    AuthService->>AuthService: argon2.verify(user.refreshTokenHash, incomingRT)
    alt Hash no coincide (REUSO DETECTADO)
        AuthService->>UserRepo: UPDATE users SET refresh_token_hash = NULL WHERE id = $1
        UserRepo->>DB: UPDATE (revoca familia completa)
        AuthService->>AuthService: Logger.warn('Refresh token reuse detected', userId)
        AuthService-->>AuthController: throw UnauthorizedException
        AuthController-->>Cliente: 401 Unauthorized
    end

    Note over AuthService: Token legítimo — emite nueva familia
    AuthService->>AuthService: issueTokens(userId, email, role)
    AuthService->>JwtService: sign(payload, JWT_SECRET, 15m)
    JwtService-->>AuthService: newAccessToken
    AuthService->>JwtService: sign(payload, JWT_REFRESH_SECRET, 7d)
    JwtService-->>AuthService: newRefreshToken
    AuthService->>AuthService: argon2.hash(newRefreshToken)
    AuthService->>UserRepo: UPDATE users SET refresh_token_hash = newHash WHERE id = $1
    UserRepo->>DB: UPDATE
    DB-->>UserRepo: OK

    AuthService-->>AuthController: { accessToken: newAccessToken, refreshToken: newRefreshToken }
    AuthController->>AuthController: res.cookie('refresh_token', newRefreshToken, { httpOnly, ... })
    AuthController-->>Cliente: 200 { accessToken } + Set-Cookie: refresh_token=...
```

---

## Flujo 3: Logout con revocación de access token (POST /api/v1/auth/logout)

Logout invalida ambos tokens: el refresh token se borra de BD (`refresh_token_hash = NULL`) y el access token se añade a la blocklist de Valkey usando su `jti` como clave, con TTL igual al tiempo restante hasta su expiración natural. La estrategia es *fail-open*: si Valkey falla, el refresh se invalida igualmente y solo el access token quedaría activo hasta su expiración corta.

```mermaid
sequenceDiagram
    actor Cliente
    participant ThrottlerGuard
    participant JwtAuthGuard
    participant JwtStrategy
    participant AuthController
    participant AuthService
    participant JwtService
    participant Valkey as Valkey (ioredis)
    participant UserRepo as Repository<User>
    participant DB as PostgreSQL

    Cliente->>ThrottlerGuard: POST /api/v1/auth/logout\nAuthorization: Bearer <AT>\nCookie: refresh_token=<RT>
    ThrottlerGuard->>JwtAuthGuard: pasa (60 rpm global)
    JwtAuthGuard->>JwtStrategy: valida Bearer token (HS256 + iss + aud)
    JwtStrategy->>JwtStrategy: verifica firma + expiración
    JwtStrategy->>Valkey: GET blocklist:at:<jti>
    alt jti ya en blocklist (token revocado previamente)
        Valkey-->>JwtStrategy: "1"
        JwtStrategy-->>Cliente: 401 Unauthorized (Token revocado)
    end
    Valkey-->>JwtStrategy: nil
    JwtStrategy-->>JwtAuthGuard: req.user = { id, email, role }

    JwtAuthGuard-->>AuthController: handler invocado
    AuthController->>AuthController: Extrae Bearer del header Authorization
    AuthController->>AuthService: logout(userId, accessToken)

    AuthService->>JwtService: decode(accessToken) (sin verificar firma — ya validada por el guard)
    JwtService-->>AuthService: { jti, exp, ... }
    AuthService->>AuthService: ttl = exp - now (en segundos)

    alt ttl > 0
        AuthService->>Valkey: SET blocklist:at:<jti> "1" EX <ttl>
        alt Valkey responde error (red, timeout, no disponible)
            Valkey-->>AuthService: error
            AuthService->>AuthService: Logger.error (fail-open, continúa)
        else OK
            Valkey-->>AuthService: OK
        end
    end

    Note over AuthService: Invalidación del refresh token en BD<br/>(independiente de Valkey — siempre ocurre)
    AuthService->>UserRepo: UPDATE users SET refresh_token_hash = NULL WHERE id = $1
    UserRepo->>DB: UPDATE
    DB-->>UserRepo: OK
    AuthService-->>AuthController: void

    AuthController->>AuthController: res.clearCookie('refresh_token', { path: /api/v1/auth/refresh, ... })
    AuthController-->>Cliente: 204 No Content
```

A partir de este momento, cualquier intento de usar el access token revocado verá la entrada en `blocklist:at:<jti>` y será rechazado por `JwtStrategy.validate()`. La entrada se auto-elimina cuando expira el TTL, sin necesidad de limpieza manual.

---

## Flujo 4: Creación de cita médica (POST /api/v1/appointments)

Este flujo concentra las validaciones más complejas: autenticación, blocklist check, RBAC, ownership del patientId, validación del doctorId y prevención de double-booking.

```mermaid
sequenceDiagram
    actor Cliente
    participant ThrottlerGuard
    participant JwtAuthGuard
    participant JwtStrategy
    participant Valkey as Valkey (ioredis)
    participant RolesGuard
    participant ValidationPipe
    participant AppointmentsController
    participant AppointmentsService
    participant PatientsService
    participant DoctorsService
    participant AppointmentRepo as Repository<Appointment>
    participant DB as PostgreSQL

    Cliente->>ThrottlerGuard: POST /api/v1/appointments\nAuthorization: Bearer <AT>\nBody: { patientId, doctorId, date, startTime, endTime, status?, notes? }
    ThrottlerGuard->>ThrottlerGuard: Verifica 60 rpm global por IP

    ThrottlerGuard->>JwtAuthGuard: pasa
    JwtAuthGuard->>JwtStrategy: valida Bearer token (HS256 + issuer + audience)
    alt Token inválido/expirado
        JwtAuthGuard-->>Cliente: 401 Unauthorized
    end
    JwtStrategy->>JwtStrategy: extrae { sub, email, role, jti } del payload
    JwtStrategy->>JwtStrategy: verifica user.isActive en BD
    alt Usuario desactivado
        JwtStrategy-->>Cliente: 401 Unauthorized (Usuario desactivado)
    end
    JwtStrategy->>Valkey: GET blocklist:at:<jti>
    alt jti en blocklist (logout previo)
        Valkey-->>JwtStrategy: "1"
        JwtStrategy-->>Cliente: 401 Unauthorized (Token revocado)
    else Valkey error (fail-open)
        Valkey-->>JwtStrategy: error
        JwtStrategy->>JwtStrategy: Logger.error — pasa sin bloquear
    else OK
        Valkey-->>JwtStrategy: nil
    end
    JwtStrategy-->>JwtAuthGuard: req.user = { id, email, role }

    JwtAuthGuard->>RolesGuard: pasa con req.user
    RolesGuard->>RolesGuard: Lee @Roles() metadata del handler
    Note over RolesGuard: El handler no tiene @Roles(),<br/>cualquier rol autenticado puede continuar
    RolesGuard-->>ValidationPipe: pasa

    ValidationPipe->>ValidationPipe: Valida CreateAppointmentDto\n(whitelist, forbidNonWhitelisted)
    alt DTO inválido
        ValidationPipe-->>Cliente: 400 Bad Request (errores de validación)
    end

    ValidationPipe-->>AppointmentsController: handler invocado con DTO tipado

    AppointmentsController->>AppointmentsService: create(createDto, req.user)

    AppointmentsService->>AppointmentsService: assertCanAccess(req.user, createDto.patientId, createDto.doctorId)
    alt PATIENT intenta crear cita con patientId ajeno
        AppointmentsService-->>AppointmentsController: throw ForbiddenException
        AppointmentsController-->>Cliente: 403 Forbidden
    end
    alt DOCTOR intenta crear cita sin participar
        AppointmentsService-->>AppointmentsController: throw ForbiddenException
        AppointmentsController-->>Cliente: 403 Forbidden
    end

    AppointmentsService->>PatientsService: findOne(createDto.patientId)
    PatientsService->>DB: SELECT * FROM patients INNER JOIN users ON user.isActive=true WHERE id = $1
    alt Paciente no existe o inactivo
        AppointmentsService-->>AppointmentsController: throw NotFoundException
        AppointmentsController-->>Cliente: 404 Not Found
    end

    AppointmentsService->>DoctorsService: findOne(createDto.doctorId)
    DoctorsService->>DB: SELECT * FROM doctors INNER JOIN users ON user.isActive=true WHERE id = $1
    alt Médico no existe o inactivo
        AppointmentsService-->>AppointmentsController: throw NotFoundException
        AppointmentsController-->>Cliente: 404 Not Found
    end

    AppointmentsService->>AppointmentRepo: Busca solapamiento de doctor\n(date = $1 AND doctorId = $2\nAND startTime < endTime AND endTime > startTime)
    AppointmentRepo->>DB: SELECT con condiciones de solapamiento
    alt Doctor tiene cita solapada
        AppointmentsService-->>AppointmentsController: throw ConflictException (double-booking doctor)
        AppointmentsController-->>Cliente: 409 Conflict
    end

    AppointmentsService->>AppointmentRepo: Busca solapamiento de paciente\n(date = $1 AND patientId = $2\nAND solapamiento de horario)
    AppointmentRepo->>DB: SELECT con condiciones de solapamiento
    alt Paciente tiene cita solapada
        AppointmentsService-->>AppointmentsController: throw ConflictException (double-booking paciente)
        AppointmentsController-->>Cliente: 409 Conflict
    end

    AppointmentsService->>AppointmentRepo: save(newAppointment)
    AppointmentRepo->>DB: INSERT INTO appointments (...) VALUES (...)
    DB-->>AppointmentRepo: Appointment row con UUID generado
    AppointmentRepo-->>AppointmentsService: Appointment

    AppointmentsService-->>AppointmentsController: Appointment creada
    AppointmentsController-->>Cliente: 201 Created { id, patientId, doctorId, date, startTime, endTime, status, notes }
```
