# Prompt — Replicar Clinic API (NestJS) en .NET Core 10

Eres un arquitecto senior de software especializado en ASP.NET Core y seguridad de aplicaciones. Tu misión es **construir una réplica funcional y semánticamente equivalente** de una API existente escrita en NestJS, manteniendo intactas todas sus decisiones de arquitectura, seguridad y dominio, pero migrándola a **.NET Core 10 (C#)** con **Clean Code** estricto en nombres, métodos y clases.

> Este prompt es auto-contenido: te indica qué construir, qué herramientas usar y dónde está la implementación de referencia. **Antes de tomar decisiones de diseño, consulta el código fuente y la documentación del proyecto NestJS** — no improvises ni añadas funcionalidad que el original no tenga.

---

## 1. Proyecto de referencia (NestJS)

| Dato | Valor |
|------|-------|
| Ruta absoluta del repo de referencia | `C:\Users\Miguel\Desktop\BASE-API-NEST-DELUXE` |
| Lenguaje / framework | TypeScript + NestJS 11 |
| Base de datos | PostgreSQL 15+ |
| ORM | TypeORM 0.3 |
| Cache / blocklist | Valkey (compatible Redis) vía `ioredis` |
| Autenticación | JWT HS256 con rotación de refresh tokens + blocklist |
| Hashing | Argon2id |
| Documentación viva | `README.md`, `ADR.md`, `ARCHITECTURE.md`, `ERD.md`, `MODULES.md`, `SEQUENCES.md` |

**Reglas de uso del repo de referencia:**

1. **Siempre que tengas duda sobre comportamiento, lee primero el código fuente del proyecto NestJS** — no asumas. Las rutas relevantes están en la sección 7.
2. **Lee la documentación antes de empezar cada módulo nuevo**. Los archivos en la raíz del proyecto NestJS describen el contrato:
   - `README.md` — variables de entorno, scripts, endpoints públicos, rate limits.
   - `ADR.md` — 11 decisiones arquitectónicas (JwtAuthGuard global, Argon2id, refresh rotation, UUID v4, migraciones explícitas, soft delete, configuración tipada, Swagger protegido, Valkey blocklist, jti, HS256+iss+aud).
   - `ARCHITECTURE.md` — patrones NestJS (guards, pipes, filters, interceptors), estructura de carpetas, DI.
   - `ERD.md` — diagrama entidad-relación con Mermaid, tipos de columna, ON DELETE.
   - `MODULES.md` — dependencias entre módulos.
   - `SEQUENCES.md` — diagramas de secuencia para login, refresh, logout y creación de cita.
3. **No copies texto literal en español del proyecto NestJS** al código C#. Traduce comentarios cuando aporten valor; mantén la intención, no la forma.

---

## 2. Stack objetivo (.NET Core 10)

| Capa | Tecnología obligatoria |
|------|------------------------|
| Runtime | .NET 10 (SDK 10.0.201, confirmado por `dotnet --version`) |
| Framework | ASP.NET Core 10 (controladores + minimal hosting `Program.cs`) |
| Lenguaje | C# 13 con nullable reference types habilitado y `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` |
| ORM | Entity Framework Core 10 + `Npgsql.EntityFrameworkCore.PostgreSQL` |
| Migraciones | EF Core Migrations (`dotnet ef migrations add ...`) — **NUNCA** `EnsureCreated` ni auto-sync |
| Autenticación | `Microsoft.AspNetCore.Authentication.JwtBearer` + esquema personalizado para login (equivalente a LocalStrategy) |
| Hashing | `Konscious.Security.Cryptography.Argon2` (Argon2id, 64 MB, 3 iteraciones, 4 hilos) |
| Cache / blocklist | `StackExchange.Redis` apuntando a Valkey |
| Rate limiting | Built-in `Microsoft.AspNetCore.RateLimiting` (.NET 10) con políticas por endpoint |
| Documentación API | `Swashbuckle.AspNetCore` con esquema Bearer y filtro Basic Auth |
| Validación de DTOs | `FluentValidation.AspNetCore` (preferido) o DataAnnotations + `ProblemDetails` |
| Headers de seguridad | Middleware nativo + `NetEscapades.AspNetCore.SecurityHeaders` |
| Configuración | `IOptions<T>` con secciones tipadas en `appsettings.json` + `IValidateOptions<T>` para fail-fast |
| Logging | `Microsoft.Extensions.Logging` con `ILogger<T>` (equivalente a `Logger` de Nest) |
| Cookies | Middleware nativo `Microsoft.AspNetCore.Http` |

**Prohibido:** Identity de ASP.NET (sustituido por implementación propia), AutoMapper innecesario (usar mapeos manuales o records), MediatR (la API es simple, no requiere CQRS).

---

## 3. Equivalencias NestJS → ASP.NET Core (referencia rápida)

| NestJS | .NET Core 10 |
|--------|--------------|
| `@Module` | Carpeta + extension method `Add<Feature>(this IServiceCollection)` |
| `@Controller('users')` | `[ApiController] [Route("api/v1/users")] public class UsersController : ControllerBase` |
| `@Injectable()` + DI | `services.AddScoped<>` (la mayoría) / `AddSingleton` para `IValkeyClient` |
| `@nestjs/config` con namespaces (`appConfig`, `jwtConfig`, …) | `IOptions<AppOptions>`, `IOptions<JwtOptions>`, `IOptions<DatabaseOptions>`, `IOptions<ValkeyOptions>` — cada uno bind a una sección de `appsettings.json` |
| `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` | `FluentValidation` + filtro global que rechaza propiedades no declaradas (configurar `System.Text.Json` con `JsonSerializerOptions.UnmappedMemberHandling = Disallow` en .NET 10) |
| `class-validator` (`@IsEmail`, `@Matches`, …) | FluentValidation rules (`.EmailAddress()`, `.Matches(regex)`, `.MaximumLength()`) |
| Global `JwtAuthGuard` (APP_GUARD) | `app.UseAuthentication() / UseAuthorization()` con política `[Authorize]` global vía `AuthorizationOptions.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build()` |
| `@Public()` | `[AllowAnonymous]` (nativo) |
| `@Roles(UserRole.ADMIN)` | `[Authorize(Roles = "admin")]` o política por nombre (`Policies.AdminOnly`) |
| `RolesGuard` | El propio middleware de `[Authorize]` cuando los claims llevan `role` |
| `@CurrentUser()` | Helper de extensión `HttpContext.GetCurrentUser()` que parsea claims a un record `AuthenticatedUser` |
| `JwtStrategy.validate()` con check Valkey + isActive | Evento `OnTokenValidated` de `JwtBearerEvents` o un `IClaimsTransformation` |
| `LocalStrategy` | `AuthController.Login` resuelve credenciales contra `IUsersService` (no se necesita esquema separado) |
| `HttpExceptionFilter` global | `IExceptionFilter` global + `app.UseExceptionHandler()` con `ProblemDetails` |
| `@nestjs/throttler` global + `@Throttle()` por endpoint | `AddRateLimiter` con política `default` (60/min) y políticas nombradas: `auth-register` (5/10min), `auth-login` (5/min), `auth-refresh` (10/min) |
| `@nestjs/swagger` + `addBearerAuth` | `AddSwaggerGen` con `AddSecurityDefinition("Bearer", …)` y `AddSecurityRequirement` |
| `helmet()` | `app.UseSecurityHeaders(...)` configurando HSTS, X-Frame-Options, CSP, Referrer-Policy |
| `cookie-parser` | Cookies nativas en `HttpContext.Request.Cookies` y `Response.Cookies.Append` |
| `express-basic-auth` para `/api/docs` | Middleware custom que valida `Authorization: Basic ...` solo en entorno Development y solo para la ruta de Swagger |
| `argon2` | `Konscious.Security.Cryptography.Argon2id` con parámetros idénticos: 64 MB (`MemorySize = 65536`), 3 iteraciones, 4 hilos |
| `randomUUID()` | `Guid.NewGuid()` (jti) y `Guid.NewGuid().ToString()` |
| TypeORM `@Entity` + `@Column` | Clases POCO + `DbContext.OnModelCreating` con Fluent API o `[Table]/[Column]` |
| `Repository<User>` (`InjectRepository`) | `DbSet<User>` en `ClinicDbContext` |
| `createQueryBuilder` | LINQ con `IQueryable` |

---

## 4. Estructura de carpetas objetivo

```
ClinicApi/
├── ClinicApi.sln
├── src/
│   ├── ClinicApi.Api/                          # Proyecto ASP.NET Core
│   │   ├── Program.cs                          # Bootstrap: Helmet, CORS, pipes, Swagger
│   │   ├── appsettings.json
│   │   ├── appsettings.Development.json
│   │   ├── Controllers/
│   │   │   ├── AppController.cs                # GET /  health
│   │   │   ├── AuthController.cs               # /auth/register|login|refresh|logout
│   │   │   ├── UsersController.cs              # /users   CRUD admin
│   │   │   ├── PatientsController.cs           # /patients
│   │   │   ├── DoctorsController.cs            # /doctors
│   │   │   ├── SpecialtiesController.cs        # /specialties
│   │   │   └── AppointmentsController.cs       # /appointments
│   │   ├── Filters/
│   │   │   └── GlobalExceptionFilter.cs        # Equivalente a HttpExceptionFilter
│   │   ├── Middleware/
│   │   │   └── SwaggerBasicAuthMiddleware.cs   # Protege /api/docs solo en Development
│   │   ├── Extensions/
│   │   │   ├── HttpContextExtensions.cs        # GetCurrentUser()
│   │   │   └── ServiceCollectionExtensions.cs  # Add<Feature>() per module
│   │   └── Swagger/
│   │       └── SwaggerConfigurator.cs
│   │
│   ├── ClinicApi.Application/                  # Lógica de negocio (Servicios)
│   │   ├── Auth/
│   │   │   ├── AuthService.cs
│   │   │   ├── IAuthService.cs
│   │   │   ├── TokenIssuer.cs                  # Equivalente a issueTokens()
│   │   │   ├── ITokenIssuer.cs
│   │   │   └── Dtos/ (LoginRequest, RegisterRequest, AuthTokensResponse)
│   │   ├── Users/
│   │   ├── Patients/
│   │   ├── Doctors/
│   │   ├── Specialties/
│   │   ├── Appointments/
│   │   ├── Common/
│   │   │   ├── Authorization/
│   │   │   │   └── AuthenticatedUser.cs        # record con Id, Email, Role
│   │   │   ├── Exceptions/                     # NotFound, Forbidden, Conflict, BadRequest
│   │   │   └── Security/
│   │   │       ├── IPasswordHasher.cs / Argon2PasswordHasher.cs
│   │   │       └── ITokenBlocklist.cs / ValkeyTokenBlocklist.cs
│   │   └── Validation/                         # FluentValidation validators
│   │
│   ├── ClinicApi.Domain/                       # Entidades y enums
│   │   ├── Entities/
│   │   │   ├── User.cs / UserRole.cs
│   │   │   ├── Patient.cs / Gender.cs
│   │   │   ├── Doctor.cs
│   │   │   ├── Specialty.cs
│   │   │   └── Appointment.cs / AppointmentStatus.cs
│   │   └── Common/
│   │       └── EntityBase.cs                   # Id, CreatedAt, UpdatedAt (opcional)
│   │
│   └── ClinicApi.Infrastructure/               # Persistencia + adaptadores externos
│       ├── Persistence/
│       │   ├── ClinicDbContext.cs
│       │   └── Configurations/                 # IEntityTypeConfiguration<T>
│       ├── Migrations/                         # Generadas por EF Core
│       └── Valkey/
│           └── ValkeyConnectionFactory.cs      # Wrapper de IConnectionMultiplexer con fail-open
│
└── tests/
    ├── ClinicApi.UnitTests/
    └── ClinicApi.IntegrationTests/
```

**Justificación de la separación en 4 proyectos:** mantiene la mentalidad modular de NestJS sin acoplar el dominio a Infrastructure. `Api` solo conoce `Application`; `Application` solo conoce `Domain`; `Infrastructure` implementa interfaces declaradas en `Application` (puerto-adaptador ligero).

---

## 5. Reglas de seguridad obligatorias (replicar 1:1)

Estas son las **invariantes de seguridad del proyecto NestJS**. No las relajes ni las cambies sin pedir confirmación al usuario.

### 5.1 Autenticación y autorización
- **Autenticación por defecto:** todos los endpoints exigen JWT salvo los marcados con `[AllowAnonymous]`. Equivale al `APP_GUARD` global de NestJS.
- **Endpoints públicos:** `GET /` (health), `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`.
- **RBAC:**
  - `UsersController` completo → solo `admin`.
  - `DoctorsController`: lectura libre (autenticado); escritura + asignación de especialidades solo `admin`.
  - `SpecialtiesController`: lectura libre; escritura solo `admin`.
  - `PatientsController`: lectura/escritura con **ownership** + `admin` puede listar/desactivar.
  - `AppointmentsController`: cada handler valida ownership (paciente, doctor o admin) dentro del servicio (defensa en profundidad).

### 5.2 JWT
- Algoritmo **HS256 obligatorio** (algorithm pinning). Rechazar cualquier token con otro `alg`.
- Claims obligatorios en validación: `iss = clinic-api`, `aud = clinic-web` (configurables vía `JwtOptions.Issuer` / `Audience`).
- Payload del access token: `{ sub, email, role, jti }`. `jti = Guid.NewGuid()`.
- Payload del refresh token: `{ sub }` con `jti` propio. Firmado con **secret distinto** (`JwtOptions.RefreshSecret`).
- TTL: access 15 min (configurable), refresh 7 días.
- **Secretos ≥ 32 caracteres.** En `Production`, validación al arranque (fail-fast) vía `IValidateOptions<JwtOptions>`. En `Development`, solo warning.

### 5.3 Rotación de refresh tokens con detección de reuso
- Cada `POST /auth/refresh` emite un nuevo par y reemplaza `User.RefreshTokenHash` (Argon2id del nuevo refresh).
- Si el refresh recibido no coincide con el hash almacenado → **revoca la familia completa** (`RefreshTokenHash = null`) y devuelve 401. Logger.Error con `userId`.
- Si el usuario no tiene `RefreshTokenHash` pero llega un refresh con firma válida → idéntico tratamiento (logout previo o familia ya revocada).

### 5.4 Blocklist de access tokens (Valkey)
- Implementar `ITokenBlocklist` con dos métodos: `BlockAsync(jti, ttlSeconds)` y `IsBlockedAsync(jti)`.
- Clave en Valkey: `blocklist:at:{jti}` con TTL = `exp - now`.
- En el handler de `JwtBearerEvents.OnTokenValidated`, leer el claim `jti`, consultar la blocklist y, si está, lanzar `SecurityTokenException` → respuesta 401 "Token revocado".
- **Fail-open:** si Valkey lanza, log de error y **dejar pasar la request**. `User.IsActive == false` sigue siendo la defensa principal y se valida en el mismo evento.
- En logout, decodificar el access token recibido (sin verificar firma, ya validada por el middleware), extraer `jti` y `exp`, y registrar en Valkey con TTL restante. Si falla, log de error pero continuar — el refresh igual se invalida.

### 5.5 Cookies del refresh token
- Nombre: `refresh_token`.
- Flags: `HttpOnly = true`, `SameSite = Strict`, `Secure = true` salvo `Environment = Development` o `Testing`.
- **`Path = "/api/v1/auth/refresh"`** (mismo scope reducido que el original).
- `MaxAge = 7d`.
- En logout, `Response.Cookies.Delete("refresh_token", { Path = "/api/v1/auth/refresh", … })` con los **mismos flags**.

### 5.6 Argon2id
- Único punto de hashing: `Argon2PasswordHasher` (clase en `Application/Common/Security`).
- Parámetros: `MemorySize = 65536` (64 MB), `Iterations = 3`, `DegreeOfParallelism = 4`, `Type = Argon2id`.
- Usar el mismo hasher para **contraseñas** y **refresh tokens**.
- `Verify` debe ser tiempo-constante (la propia librería lo implementa así).

### 5.7 Rate limiting
| Endpoint | Política | Límite |
|----------|----------|--------|
| Default global | `default` | 60 req/min por IP |
| `POST /auth/register` | `auth-register` | 5 cada 10 min por IP |
| `POST /auth/login` | `auth-login` | 5 / min por IP |
| `POST /auth/refresh` | `auth-refresh` | 10 / min por IP |

Implementar con `AddRateLimiter(o => …)` de .NET 10. Aplicar a controladores/handlers vía `[EnableRateLimiting("nombre-politica")]`.

### 5.8 Validación de DTOs
- Rechazar propiedades extra (equivalente a `forbidNonWhitelisted: true`). En .NET 10: `JsonSerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow`.
- `RegisterRequest`: solo `Email` + `Password`. **NO** exponer `Role` (privilege escalation). El rol se fuerza a `UserRole.Patient` en `AuthService.RegisterAsync`.
- Password regex idéntico al original: `^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$`.
- `CreateAppointmentRequest.Notes`: `MaximumLength(2000)`.

### 5.9 Helmet / Security headers
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy` mínimo.

### 5.10 CORS
- Configurable vía `AllowedOrigins` (lista separada por comas en `appsettings`).
- Métodos: `GET, POST, PATCH, DELETE`.
- `AllowCredentials = true`. **Nunca** combinar con origen `*`.

### 5.11 Swagger
- Solo activo cuando `app.Environment.IsDevelopment()` (condición estricta, no negación de Production).
- Protegido con Basic Auth vía middleware custom usando `SWAGGER_USER` / `SWAGGER_PASSWORD` de configuración.
- Definir esquema Bearer con nombre `access-token`.
- `persistAuthorization` activado.

### 5.12 Logging de auditoría
- En el filtro global de excepciones, cuando el status sea **401 o 403**, registrar `AUTH-DENY {status} {method} {path} ip={ip} userId={id|anonymous}` (replica del comportamiento del `HttpExceptionFilter` original).

---

## 6. Modelo de datos (ERD)

Replica exacta del esquema descrito en `ERD.md` del proyecto NestJS. **No introduzcas tablas, columnas ni constraints que no existan en el original.**

### Tablas
- `users` (id uuid PK, email unique, password_hash, role enum[admin|doctor|patient], is_active bool default true, refresh_token_hash nullable, timestamps)
- `patients` (id uuid PK, user_id uuid unique FK→users, first_name, last_name, birth_date nullable, gender enum[male|female|other] nullable, phone nullable, address nullable, timestamps)
- `doctors` (id uuid PK, user_id uuid unique FK→users, first_name, last_name, license_number unique, phone nullable, timestamps)
- `specialties` (id uuid PK, name unique, description nullable, timestamps)
- `doctor_specialties` (doctor_id FK→doctors **ON DELETE CASCADE**, specialty_id FK→specialties **ON DELETE NO ACTION**, PK compuesto)
- `appointments` (id uuid PK, patient_id FK→patients, doctor_id FK→doctors, date, start_time time, end_time time, status enum default scheduled, notes text nullable, timestamps)

### Convenciones EF Core
- `Guid` para todas las PK con `ValueGeneratedOnAdd()` y default SQL `gen_random_uuid()` (extensión `pgcrypto`) o `uuid_generate_v4()` (extensión `uuid-ossp`) — replicar lo que use la migración inicial de NestJS.
- Snake_case en columnas: configurar `UseSnakeCaseNamingConvention()` de `EFCore.NamingConventions` o mapear a mano con `HasColumnName`.
- Enums PostgreSQL: usar `MapEnum<UserRole>("users_role_enum")`, `MapEnum<Gender>("patients_gender_enum")`, `MapEnum<AppointmentStatus>("appointments_status_enum")` (Npgsql nativo).
- Timestamps automáticos: `created_at DEFAULT now()` y `updated_at` mediante interceptor `SaveChangesInterceptor`.

### Migración inicial
Genera dos migraciones equivalentes a las del original:
1. `InitialSchema` — crea todas las tablas.
2. `AddRefreshTokenToUser` — añade `refresh_token_hash` a `users`.

> Si decides una sola migración, documenta el motivo en el commit.

---

## 7. Mapa de archivos críticos del repo NestJS (para consulta directa)

Cuando necesites entender un comportamiento, ve directo a estos archivos:

| Tema | Ruta en `C:\Users\Miguel\Desktop\BASE-API-NEST-DELUXE\` |
|------|----------------------------------------------------------|
| Bootstrap (Helmet, CORS, pipes, Swagger) | `src/main.ts` |
| Composición de módulos + guards globales | `src/app.module.ts` |
| Health check público | `src/app.controller.ts` |
| Login/Register/Refresh/Logout (controlador) | `src/auth/auth.controller.ts` |
| Lógica de auth + rotation + blocklist | `src/auth/auth.service.ts` |
| Configuración JWT module | `src/auth/auth.module.ts` |
| JwtStrategy con check de Valkey + isActive | `src/auth/strategies/jwt.strategy.ts` |
| LocalStrategy (email+password) | `src/auth/strategies/local.strategy.ts` |
| JwtAuthGuard con @Public() | `src/auth/guards/jwt-auth.guard.ts` |
| RolesGuard | `src/common/guards/roles.guard.ts` |
| HttpExceptionFilter + log AUTH-DENY | `src/common/filters/http-exception.filter.ts` |
| Decoradores @Public / @Roles / @CurrentUser | `src/common/decorators/` |
| Tipo AuthenticatedUser | `src/common/types/authenticated-user.interface.ts` |
| Argon2id en hash de contraseñas | `src/users/users.service.ts` |
| Entidades (TypeORM) | `src/{users,patients,doctors,specialties,appointments}/entities/*.entity.ts` |
| DTOs con class-validator + Swagger | `src/{module}/dto/*.dto.ts` |
| Lógica de citas (ownership + double-booking) | `src/appointments/appointments.service.ts` |
| ValkeyModule (`ioredis`, fail-open, @Global) | `src/valkey/valkey.module.ts` |
| Configuraciones tipadas con namespaces | `src/config/{app,database,jwt,valkey}.config.ts` |
| Migraciones | `src/database/migrations/*.ts` |
| Variables de entorno modelo | `.env.example` |
| Decisiones arquitectónicas | `ADR.md` |
| Diagrama ER | `ERD.md` |
| Diagrama de módulos | `MODULES.md` |
| Diagramas de secuencia | `SEQUENCES.md` |
| Patrones y estructura | `ARCHITECTURE.md` |
| Variables de entorno + endpoints | `README.md` |

**Cuando completes un módulo, vuelve a abrir el archivo TypeScript equivalente y verifica que ningún `[SECURE-FIX]` quedó sin replicar.**

---

## 8. Convenciones de Clean Code (C# 13)

### 8.1 Naming
- **PascalCase** para clases, métodos, propiedades públicas, records.
- **camelCase** para parámetros, locales.
- **_camelCase** para campos privados.
- **PascalCase** para constantes públicas; `UPPER_SNAKE_CASE` está prohibido salvo P/Invoke.
- Interfaces siempre con prefijo `I`: `IUsersService`, `ITokenBlocklist`.
- Servicios terminan en `Service`, repositorios (si existen) en `Repository`, validadores en `Validator`, opciones en `Options`.
- Async siempre con sufijo `Async`: `Task<User> CreateAsync(...)`.

### 8.2 Métodos
- Máximo **~30 líneas** por método. Si excede, extraer privados con nombres que describan la intención (`AssertNoScheduleConflictAsync`, `ResolvePatientIdForUserAsync`, `EnsureCanAccess`).
- Un método = una responsabilidad. La signature debe leerse como una frase.
- **No** ocultar side-effects con nombres genéricos (`Process`, `Handle`). Preferir `RotateRefreshTokenAsync`, `RevokeFamilyAsync`.

### 8.3 Excepciones de dominio
- Definir excepciones tipadas: `EntityNotFoundException`, `OwnershipException`, `ConflictException`, `InvalidCredentialsException`, `RefreshTokenReuseException`.
- El filtro global mapea cada una a un status HTTP. **No** lanzar `Exception` genérica.

### 8.4 Records vs clases
- DTOs de request/response → `record` con `init` properties.
- Entidades EF → `class` (EF necesita setters).
- Value objects de claims (`AuthenticatedUser`) → `record`.

### 8.5 Comentarios
- Por defecto, **no escribir comentarios**. Los nombres deben bastar.
- Comentar solo el "porqué" cuando una decisión sea contraintuitiva (fail-open, algorithm pinning, regex de password). Cuando ocurra, referenciar el OWASP correspondiente: `// OWASP A07:2021 …`.
- Prohibidos los comentarios que repiten el código (`// Crea el usuario`).

### 8.6 Async/Await
- **Toda** operación de I/O es `Task<T>` con `await`. Nunca `.Result` ni `.Wait()`.
- `CancellationToken` propagado en cada método público de servicio y controller.

### 8.7 Nullable reference types
- `<Nullable>enable</Nullable>` en todos los `.csproj`.
- Si una propiedad puede ser null, declararla con `?`. Si no, **no** usar `default!` salvo en navegaciones EF (`User User { get; set; } = null!;` está permitido en entidades).

---

## 9. Plan de trabajo recomendado

Construye el proyecto en este orden. Después de cada paso, valida contra el archivo de referencia indicado.

1. **Scaffold + configuración** — `dotnet new sln`, 4 proyectos (`Api`, `Application`, `Domain`, `Infrastructure`), referencias entre ellos, `appsettings.json` con secciones `App`, `Database`, `Jwt`, `Valkey`, `Cors`, `Swagger`. Validar con `src/config/*.config.ts` y `.env.example`.
2. **Dominio** — entidades + enums. Validar con `src/{module}/entities/*.entity.ts` y `ERD.md`.
3. **Infrastructure / EF Core** — `ClinicDbContext`, `IEntityTypeConfiguration<T>` por entidad, mapeo de enums, snake_case, primera migración. Validar contra `src/database/migrations/`.
4. **Common / Security** — `Argon2PasswordHasher`, `IValidateOptions<JwtOptions>` con fail-fast, `ValkeyConnectionFactory` con fail-open al arrancar, `ITokenBlocklist`.
5. **Auth** — `JwtBearer` configurado con `OnTokenValidated` (isActive + blocklist), `AuthService` (Register, Login, RefreshAsync, LogoutAsync), `TokenIssuer` (jti, dos secretos, dos `expiresIn`). Validar contra `auth.service.ts` y `SEQUENCES.md`.
6. **Filters + Middleware** — `GlobalExceptionFilter` con AUTH-DENY log, `SwaggerBasicAuthMiddleware`. Validar contra `http-exception.filter.ts` y `main.ts`.
7. **Users module** — controlador `[Authorize(Roles="admin")]` global en la clase, servicio con Argon2id en `Create` y `Update`, soft delete con `IsActive`.
8. **Patients module** — ownership en servicio (`AssertCanReadAsync`, `AssertCanWriteAsync`).
9. **Doctors + Specialties** — Many-to-many con `doctor_specialties`, escrituras solo admin, validar borrado de especialidad con médicos asignados.
10. **Appointments** — ownership por rol, double-booking para paciente **y** médico, soft cancel (`status = cancelled`), filtrar por `user.is_active = true` en JOINs.
11. **Rate limiting + CORS + Helmet + Swagger** — configurado en `Program.cs`.
12. **Tests** — al menos pruebas de integración para los 4 flujos críticos de `SEQUENCES.md`: login, refresh (incluyendo reuse detection), logout (blocklist), create appointment (ownership + conflict).

---

## 10. Checklist final antes de marcar la migración como completa

Verifica cada punto contra el código de referencia y la documentación. Si algo no coincide, **vuelve atrás y ajusta** antes de cerrar.

- [ ] `POST /api/v1/auth/register` rechaza body con campo `role`. Crea usuario con `role = patient` siempre.
- [ ] `POST /api/v1/auth/login` rate-limited a 5/min; password verificado con Argon2id; devuelve `accessToken` en body y `refresh_token` en cookie con flags correctos.
- [ ] `POST /api/v1/auth/refresh` lee la cookie HttpOnly, verifica HS256 + iss + aud, detecta reuso revocando la familia, emite par nuevo y rota cookie.
- [ ] `POST /api/v1/auth/logout` requiere Bearer, registra `jti` en Valkey con TTL restante, limpia `RefreshTokenHash`, borra cookie con mismos flags.
- [ ] `JwtBearer.OnTokenValidated` rechaza si `user.IsActive == false` (401) o si `jti` está en Valkey (401 "Token revocado"); fail-open si Valkey no responde.
- [ ] Swagger solo disponible en Development, protegido con Basic Auth, esquema Bearer configurado.
- [ ] `Helmet`-equivalente activo: HSTS, X-Frame-Options DENY, Referrer-Policy no-referrer, CSP mínimo.
- [ ] CORS configurable, `AllowCredentials = true`, sin `*`.
- [ ] Validación de DTOs rechaza propiedades extra (UnmappedMemberHandling.Disallow).
- [ ] `IValidateOptions<JwtOptions>` aborta el arranque en Production si los secretos < 32 caracteres.
- [ ] Migraciones EF Core creadas con `dotnet ef migrations add`. Nunca `EnsureCreated`.
- [ ] El log emite `AUTH-DENY {status} {method} {path} ip=... userId=...` para 401/403.
- [ ] Cada controlador tiene `[ApiTags]` (xml-doc) y `[ProducesResponseType]` en los códigos esperados.
- [ ] Todos los archivos `.cs` compilan con `TreatWarningsAsErrors = true` y `Nullable = enable`.

---

## 11. Cómo usar este prompt

Cuando ejecutes esta migración:

1. Abre primero la documentación de referencia en este orden: `README.md` → `ARCHITECTURE.md` → `ADR.md` → `ERD.md` → `MODULES.md` → `SEQUENCES.md`.
2. Lee el código fuente del módulo que vas a portar **antes** de empezarlo. Empieza por `src/main.ts`, `src/app.module.ts`, `src/config/`, y de ahí baja al módulo concreto.
3. Implementa módulo por módulo siguiendo el orden de la sección 9.
4. Tras cada módulo, ejecuta `dotnet build` y `dotnet ef migrations list` y corre los tests de integración correspondientes.
5. Si una decisión no está cubierta por la documentación, prioriza lo que diga **el código** del proyecto NestJS. Si tampoco hay precedente, pregunta al usuario antes de inventar.
6. **No añadas funcionalidad** (notificaciones, emails, OAuth, multi-tenant). Replicas, no extiendes.

Cuando termines, entrega:
- El árbol de carpetas y el `.sln`.
- El `appsettings.Development.json` con valores placeholder seguros (los secretos JWT como `CHANGE_ME_AT_LEAST_32_CHARS_xxxxxxxxxxxxxxxx`).
- Una nota en `README.md` del proyecto .NET con los comandos `dotnet run`, `dotnet ef database update` y `dotnet test`, paralela al README del proyecto NestJS.
