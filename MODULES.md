# Mapa de Módulos — Clinic API

Diagrama de dependencias entre todos los módulos NestJS del proyecto, incluyendo qué providers exporta cada uno y qué módulos los consumen.

```mermaid
graph TD
    AppModule["AppModule\n(Módulo Raíz)"]

    ConfigModule["ConfigModule\n(global: true)\n@nestjs/config"]
    TypeOrmModule["TypeOrmModule\n(forRootAsync)\nPostgreSQL"]
    ThrottlerModule["ThrottlerModule\n60 rpm global"]

    UsersModule["UsersModule\nexporta: UsersService"]
    AuthModule["AuthModule\nexporta: JwtAuthGuard\nPassportModule, JwtModule"]
    PatientsModule["PatientsModule\nexporta: PatientsService"]
    DoctorsModule["DoctorsModule\nexporta: DoctorsService"]
    SpecialtiesModule["SpecialtiesModule\nexporta: SpecialtiesService"]
    AppointmentsModule["AppointmentsModule"]

    AppModule --> ConfigModule
    AppModule --> TypeOrmModule
    AppModule --> ThrottlerModule
    AppModule --> UsersModule
    AppModule --> AuthModule
    AppModule --> PatientsModule
    AppModule --> DoctorsModule
    AppModule --> SpecialtiesModule
    AppModule --> AppointmentsModule

    AuthModule -->|"importa UsersService"| UsersModule
    PatientsModule -->|"importa UsersService"| UsersModule
    DoctorsModule -->|"importa UsersService"| UsersModule
    DoctorsModule -->|"importa SpecialtiesService"| SpecialtiesModule
    AppointmentsModule -->|"importa PatientsService"| PatientsModule
    AppointmentsModule -->|"importa DoctorsService"| DoctorsModule

    ConfigModule -->|"ConfigService global"| AuthModule
    ConfigModule -->|"ConfigService global"| TypeOrmModule
    ConfigModule -->|"ConfigService global"| UsersModule
    ConfigModule -->|"ConfigService global"| PatientsModule
    ConfigModule -->|"ConfigService global"| DoctorsModule
    ConfigModule -->|"ConfigService global"| SpecialtiesModule
    ConfigModule -->|"ConfigService global"| AppointmentsModule
```

---

## Providers registrados por módulo

```mermaid
graph LR
    subgraph UsersModule
        direction TB
        UM_R["Repository&lt;User&gt;\n(TypeORM)"]
        UM_S["UsersService"]
        UM_C["UsersController"]
        UM_R --> UM_S --> UM_C
    end

    subgraph AuthModule
        direction TB
        AM_J["JwtModule\n(forRootAsync)"]
        AM_P["PassportModule\ndefault: jwt"]
        AM_JS["JwtStrategy"]
        AM_LS["LocalStrategy"]
        AM_S["AuthService"]
        AM_C["AuthController"]
        AM_S --> AM_C
        AM_J --> AM_S
        AM_JS --> AM_S
        AM_LS --> AM_S
    end

    subgraph PatientsModule
        direction TB
        PM_R["Repository&lt;Patient&gt;"]
        PM_S["PatientsService"]
        PM_C["PatientsController"]
        PM_R --> PM_S --> PM_C
    end

    subgraph DoctorsModule
        direction TB
        DM_R["Repository&lt;Doctor&gt;"]
        DM_S["DoctorsService"]
        DM_C["DoctorsController"]
        DM_R --> DM_S --> DM_C
    end

    subgraph SpecialtiesModule
        direction TB
        SM_R["Repository&lt;Specialty&gt;"]
        SM_S["SpecialtiesService"]
        SM_C["SpecialtiesController"]
        SM_R --> SM_S --> SM_C
    end

    subgraph AppointmentsModule
        direction TB
        APM_R["Repository&lt;Appointment&gt;"]
        APM_S["AppointmentsService"]
        APM_C["AppointmentsController"]
        APM_R --> APM_S --> APM_C
    end
```

---

## Guards globales (APP_GUARD)

Los siguientes guards se registran en `AppModule` como `APP_GUARD` y se ejecutan en este orden en cada request:

```mermaid
flowchart LR
    Request --> ThrottlerGuard --> JwtAuthGuard --> RolesGuard --> Handler
```

| Guard | Módulo origen | Rol |
|-------|--------------|-----|
| `ThrottlerGuard` | `ThrottlerModule` | Rate limiting por IP |
| `JwtAuthGuard` | `AuthModule` / `common/guards` | Valida Bearer token; respeta `@Public()` |
| `RolesGuard` | `common/guards` | Verifica `@Roles()` contra `req.user.role` |
