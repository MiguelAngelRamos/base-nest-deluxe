# Arquitectura — Clinic API

## Arquitectura general y filosofía de diseño

Clinic API sigue la **arquitectura modular en capas** que propone NestJS: cada dominio del negocio (auth, usuarios, pacientes, médicos, especialidades, citas) vive en su propio módulo auto-contenido con controlador, servicio y entidad. Los módulos se componen en el módulo raíz (`AppModule`) sin acoplamiento directo entre ellos.

### Principios guía

| Principio | Aplicación concreta |
|-----------|---------------------|
| **Seguridad por defecto** | `JwtAuthGuard` registrado como `APP_GUARD` global: todo endpoint requiere token salvo que lleve `@Public()` |
| **Separación de responsabilidades** | Controladores solo orquestan HTTP; servicios contienen toda la lógica de negocio; entidades solo modelan datos |
| **Fail-fast en configuración** | `jwt.config.ts` lanza excepción al arrancar si los secretos tienen menos de 32 bytes en producción |
| **IDOR prevention** | Cada servicio implementa `assertCanRead` / `assertCanWrite` antes de operar sobre un recurso ajeno |
| **Sin auto-sync en DB** | `synchronize: false` en TypeORM; los cambios de esquema se gestionan exclusivamente con migraciones versionadas |
| **UUID v4 en IDs** | Previene enumeración de recursos y ataques de ID prediction |

---

## Estructura de carpetas

```
src/
├── main.ts                      # Bootstrap: Helmet, CORS, pipes globales, Swagger
├── app.module.ts                # Módulo raíz: ConfigModule, TypeORM, ThrottlerModule, guards globales
├── app.controller.ts            # Health check GET /
├── app.service.ts               # Lógica mínima del health check
│
├── auth/                        # Módulo de autenticación
│   ├── auth.controller.ts       # /auth/register, /auth/login, /auth/refresh, /auth/logout
│   ├── auth.module.ts           # Configura PassportModule + JwtModule
│   ├── auth.service.ts          # register, login, validateUser, refreshToken, logout, issueTokens
│   ├── dto/
│   │   ├── login.dto.ts         # email + password
│   │   └── register.dto.ts      # email + password (regex de complejidad)
│   ├── guards/
│   │   ├── jwt-auth.guard.ts    # Extiende AuthGuard('jwt'); respeta @Public()
│   │   └── local-auth.guard.ts  # Activa LocalStrategy en POST /auth/login
│   └── strategies/
│       ├── jwt.strategy.ts      # Verifica HS256 + issuer + audience; extrae payload a req.user
│       └── local.strategy.ts    # Valida email/password con AuthService.validateUser
│
├── users/                       # Módulo de usuarios del sistema
│   ├── users.controller.ts      # CRUD completo; solo rol ADMIN
│   ├── users.module.ts          # Exporta UsersService (usado por AuthModule)
│   ├── users.service.ts         # Hashing Argon2id; soft delete vía isActive
│   ├── dto/
│   │   ├── create-user.dto.ts
│   │   └── update-user.dto.ts
│   └── entities/
│       └── user.entity.ts       # email, passwordHash, role, isActive, refreshTokenHash
│
├── patients/                    # Módulo de pacientes
│   ├── patients.controller.ts   # CRUD + ownership checks por rol
│   ├── patients.module.ts
│   ├── patients.service.ts      # assertCanRead/assertCanWrite para IDOR prevention
│   ├── dto/
│   │   ├── create-patient.dto.ts
│   │   └── update-patient.dto.ts
│   └── entities/
│       └── patient.entity.ts    # OneToOne con User; datos clínicos básicos
│
├── doctors/                     # Módulo de médicos
│   ├── doctors.controller.ts    # CRUD + gestión de especialidades; solo ADMIN
│   ├── doctors.module.ts
│   ├── doctors.service.ts       # Gestión ManyToMany con Specialty
│   ├── dto/
│   │   ├── create-doctor.dto.ts
│   │   └── update-doctor.dto.ts
│   └── entities/
│       └── doctor.entity.ts     # OneToOne con User; licenseNumber único; ManyToMany Specialty
│
├── specialties/                 # Módulo de especialidades médicas
│   ├── specialties.controller.ts
│   ├── specialties.module.ts
│   ├── specialties.service.ts   # Previene delete si tiene médicos asignados
│   ├── dto/
│   │   ├── create-specialty.dto.ts
│   │   └── update-specialty.dto.ts
│   └── entities/
│       └── specialty.entity.ts  # name único; ManyToMany inverso con Doctor
│
├── appointments/                # Módulo de citas
│   ├── appointments.controller.ts # CRUD + filtros por fecha/paciente/médico; ownership por rol
│   ├── appointments.module.ts
│   ├── appointments.service.ts  # assertCanAccess; double-booking prevention
│   ├── dto/
│   │   ├── create-appointment.dto.ts
│   │   ├── update-appointment.dto.ts
│   │   └── update-status.dto.ts # Solo actualiza el campo status
│   └── entities/
│       └── appointment.entity.ts # ManyToOne Patient + Doctor; enum status; date/time
│
├── common/                      # Elementos transversales
│   ├── decorators/
│   │   ├── current-user.decorator.ts  # @CurrentUser() extrae req.user inyectado por JWT
│   │   ├── public.decorator.ts        # @Public() omite JwtAuthGuard
│   │   └── roles.decorator.ts         # @Roles(...roles) declara roles requeridos
│   ├── filters/
│   │   └── http-exception.filter.ts   # Normaliza errores; log de auditoría para 401/403
│   ├── guards/
│   │   └── roles.guard.ts             # Verifica req.user.role contra metadata @Roles()
│   └── types/
│       └── authenticated-user.interface.ts  # Interfaz canónica de req.user
│
├── config/                      # Configuración tipada con namespaces
│   ├── app.config.ts            # namespace 'app': port, nodeEnv
│   ├── database.config.ts       # namespace 'database': host, port, user, pass, name, ssl
│   ├── jwt.config.ts            # namespace 'jwt': secrets, expirations, issuer, audience
│   └── index.ts                 # Barrel export de las tres configuraciones
│
└── database/
    └── migrations/              # Historial versionado de esquema
        ├── 1776681637179-InitialSchema.ts        # Creación de todas las tablas
        └── 1776700000000-AddRefreshTokenToUser.ts # Añade refresh_token_hash a users
```

---

## Patrones de NestJS utilizados

### Guards

| Guard | Alcance | Función |
|-------|---------|---------|
| `JwtAuthGuard` | Global (APP_GUARD) | Valida `Authorization: Bearer <token>` en cada request; si el handler tiene `@Public()`, retorna `true` sin verificar |
| `LocalAuthGuard` | `POST /auth/login` | Activa `LocalStrategy` de Passport para validar credenciales email/password |
| `RolesGuard` | Por handler | Lee la metadata `@Roles()` con `Reflector` y verifica que `req.user.role` esté en la lista permitida |
| `ThrottlerGuard` | Global (APP_GUARD) | Rate limiting por IP; límite base de 60 rpm; algunos endpoints tienen `@Throttle()` personalizado |

### Interceptors

No se implementan interceptors personalizados en esta versión. La transformación de respuesta se delega a `class-transformer` a través de `ValidationPipe`.

### Pipes

| Pipe | Configuración | Efecto |
|------|--------------|--------|
| `ValidationPipe` | Global, `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` | Valida DTOs, elimina propiedades no declaradas y transforma tipos automáticamente |

### Decoradores personalizados

| Decorador | Uso |
|-----------|-----|
| `@Public()` | Marca un handler como público; `JwtAuthGuard` lo detecta con `Reflector` y omite la verificación |
| `@Roles(...roles)` | Declara los roles permitidos para un handler; `RolesGuard` lo lee |
| `@CurrentUser()` | Extrae `req.user` (tipo `AuthenticatedUser`) directamente como parámetro de método |

### Middlewares

No se registran middlewares personalizados. La seguridad HTTP se aplica a nivel de `main.ts` con `helmet()` y `cookieParser()`.

### Filters

`HttpExceptionFilter` (global): captura todas las excepciones, normaliza el formato JSON de error y nunca expone el stack trace al cliente. Registra en log los eventos 401 y 403 con IP, método HTTP y userId.

---

## Estrategia de inyección de dependencias

NestJS usa el contenedor de IoC de forma jerárquica. Las dependencias fluyen así:

```
AppModule
  └─ importa UsersModule    → UsersService disponible en AuthModule
  └─ importa AuthModule     → consume UsersService (importado desde UsersModule)
  └─ importa PatientsModule → consume UsersService (importado desde UsersModule)
  └─ importa DoctorsModule  → consume SpecialtiesModule (importado desde SpecialtiesModule)
  └─ importa SpecialtiesModule
  └─ importa AppointmentsModule → consume PatientsModule y DoctorsModule
```

Cada módulo usa `TypeOrmModule.forFeature([Entity])` para registrar el repositorio de TypeORM como provider inyectable con el token `getRepositoryToken(Entity)`.

`ConfigModule.forRoot({ isGlobal: true })` hace que `ConfigService` esté disponible en todos los módulos sin necesidad de importarlo explícitamente.

---

## Cómo se relacionan los módulos entre sí

```
UsersModule ──exporta UsersService──► AuthModule
                                    └──► PatientsModule (verifica userId al crear paciente)
                                    └──► DoctorsModule  (verifica userId al crear médico)

SpecialtiesModule ──exporta SpecialtiesService──► DoctorsModule (asignar/desasignar especialidades)

PatientsModule ──exporta PatientsService──► AppointmentsModule (valida patientId)
DoctorsModule  ──exporta DoctorsService──►  AppointmentsModule (valida doctorId)
```

`AuthModule` importa `JwtModule` (con configuración asíncrona desde `ConfigService`) y `PassportModule` con estrategia por defecto `jwt`.

---

## Servicios externos e integraciones

| Servicio | Librería | Uso |
|----------|---------|-----|
| **PostgreSQL** | `typeorm` + `pg` | Persistencia principal de todos los datos |
| **Passport.js** | `passport`, `passport-jwt`, `passport-local` | Estrategias de autenticación |
| **JWT** | `@nestjs/jwt` (jsonwebtoken) | Firma y verificación de tokens HS256 |
| **Argon2id** | `argon2` | Hash de contraseñas y refresh tokens (64 MB, 3 iteraciones, 4 hilos) |
| **Helmet** | `helmet` | Headers HTTP de seguridad (CSP, HSTS, X-Frame-Options, etc.) |
| **Throttler** | `@nestjs/throttler` | Rate limiting por IP a nivel de aplicación |
| **Swagger** | `@nestjs/swagger` + `swagger-ui-express` | Documentación interactiva (solo en desarrollo) |
| **Cookie Parser** | `cookie-parser` | Lectura de la cookie HttpOnly con el refresh token |
| **express-basic-auth** | `express-basic-auth` | Protección básica de la ruta `/api/docs` de Swagger |

No se integran servicios de correo electrónico, almacenamiento en la nube, colas de mensajes ni proveedores externos de autenticación (OAuth) en esta versión.
