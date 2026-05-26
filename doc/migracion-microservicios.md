# Migración del monolito a microservicios — Clinic API

> Análisis técnico para descomponer el monolito NestJS actual en microservicios.
> Basado en el estado real del código: 6 módulos de dominio, PostgreSQL único, Valkey para blocklist JWT.

---

## 1. Punto de partida — el monolito hoy

La API actual es un **monolito modular en NestJS** con 6 módulos de dominio que viven en el mismo proceso y comparten una sola base de datos PostgreSQL.

### Módulos y sus dependencias reales

| Módulo | Entidades | Acoplamientos en código |
|--------|-----------|-------------------------|
| `auth` | — | Consume `UsersService` (`validateUser`, hashing, `refreshTokenHash`) |
| `users` | `User` | Base de Patient y Doctor vía OneToOne |
| `patients` | `Patient` | OneToOne con `User`; referenciado por `Appointment` |
| `doctors` | `Doctor` | OneToOne con `User`; ManyToMany con `Specialty`; referenciado por `Appointment` |
| `specialties` | `Specialty` | ManyToMany inverso con `Doctor` (tabla `doctor_specialties`) |
| `appointments` | `Appointment` | ManyToOne con `Patient` y `Doctor`; lógica de double-booking |

### Infraestructura actual

- **PostgreSQL** único (todas las tablas y FKs reales entre ellas)
- **Valkey** (Redis fork) para blocklist de access tokens revocados
- **JWT HS256** con `jti` + issuer + audience
- **Argon2id** para password y refresh token

---

## 2. Bounded contexts detectados (DDD)

Aplicando Domain-Driven Design al código actual, emergen **4 contextos delimitados** naturales:

```
┌─────────────────────────────────────────────────────────────────┐
│                    BOUNDED CONTEXTS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌────────────────┐    ┌──────────────────────────────────┐    │
│  │  IDENTITY      │    │  CLINICAL STAFF                  │    │
│  │  (auth+users)  │    │  (doctors + specialties)         │    │
│  └────────────────┘    └──────────────────────────────────┘    │
│                                                                 │
│  ┌────────────────┐    ┌──────────────────────────────────┐    │
│  │  PATIENTS      │    │  SCHEDULING                      │    │
│  │  (datos        │    │  (appointments)                  │    │
│  │   clínicos)    │    │                                  │    │
│  └────────────────┘    └──────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Recomendación principal: **4 microservicios + 4 BDs + 1 Valkey**

| # | Microservicio | Módulos absorbidos | BD dedicada | Stack sugerido |
|---|---------------|---------------------|-------------|----------------|
| 1 | **Identity Service** | `auth` + `users` | PostgreSQL #1 (`identity_db`) | NestJS + TypeORM |
| 2 | **Patients Service** | `patients` | PostgreSQL #2 (`patients_db`) | NestJS + TypeORM |
| 3 | **Doctors Service** | `doctors` + `specialties` | PostgreSQL #3 (`doctors_db`) | NestJS + TypeORM |
| 4 | **Appointments Service** | `appointments` | PostgreSQL #4 (`appointments_db`) | NestJS + TypeORM |

### Infraestructura compartida

| Componente | Propósito | Tecnología |
|------------|-----------|------------|
| **API Gateway** | Punto único de entrada; valida JWT antes de rutear | Kong / Traefik / NestJS Gateway |
| **Valkey (Redis)** | Blocklist JWT + caché por servicio | Compartido o cluster |
| **Message Broker** | Comunicación asíncrona vía eventos de dominio | RabbitMQ / Kafka / NATS |
| **Service Discovery** | Localización dinámica de instancias | Consul / Kubernetes DNS |
| **Observability stack** | Trazas distribuidas, métricas, logs | OpenTelemetry + Grafana + Loki |

---

## 4. Justificación por servicio

### 4.1. Identity Service (auth + users)

**¿Por qué juntos?**

- `AuthService` llama directamente a `UsersService.findByEmail` y `validateUser` en cada login
- El `refreshTokenHash` vive en la propia tabla `users` ([user.entity.ts:64](../src/users/entities/user.entity.ts#L64))
- Separarlos forzaría una llamada síncrona inter-servicio en cada autenticación → latencia y punto único de fallo
- Ambos forman el contexto "**Identidad y acceso**"

**Responsabilidades:**
- Registro, login, refresh, logout
- Gestión de usuarios del sistema (CRUD admin)
- Hashing Argon2id de password y refresh tokens
- Emisión y revocación de JWT (blocklist en Valkey)

**Eventos que emite:**
- `UserCreated`
- `UserDeactivated`
- `UserRoleChanged`

### 4.2. Patients Service

**¿Por qué solo?**

- Datos **clínicos sensibles** (HIPAA / LOPD / GDPR) → aislamiento de BD justificado por compliance
- Cifrado en reposo y backups independientes
- Equipo de salud/clínico puede iterar sin tocar identidad

**Responsabilidades:**
- CRUD de pacientes
- Historia clínica básica (datos demográficos, contacto)
- IDOR prevention (`assertCanRead` / `assertCanWrite`)

**Eventos:**
- `PatientCreated`
- `PatientUpdated`
- `PatientDeleted` ← Appointments debe escuchar para cancelar citas

### 4.3. Doctors Service (doctors + specialties)

**¿Por qué juntos?**

- `Specialty` solo se usa desde `Doctor` (ManyToMany `doctor_specialties`)
- Separarlas obliga a un join distribuido cada vez que se lista un médico con sus especialidades
- Specialties es un **sub-agregado** del agregado "Doctor", no un contexto autónomo

**Responsabilidades:**
- CRUD de médicos
- Catálogo de especialidades médicas
- Asignación/desasignación de especialidades
- Validación de licencia médica única

**Eventos:**
- `DoctorCreated`
- `DoctorDeactivated`
- `SpecialtyAssigned`

### 4.4. Appointments Service

**¿Por qué solo?**

- Es el dominio con **más cambios y reglas de negocio**:
  - Estados (scheduled → confirmed → completed/cancelled/no_show)
  - Prevención de double-booking
  - Filtros por fecha/paciente/médico
- Escala distinto al resto (picos en horarios de apertura)
- Es el candidato natural para **CQRS** (lecturas masivas para calendarios, escrituras transaccionales)

**Responsabilidades:**
- Crear, modificar y cancelar citas
- Validación de disponibilidad (consulta cacheada al Doctors Service)
- Cambios de estado
- Notas clínicas opcionales

**Almacena referencias (no FKs):**
- `patientId: UUID` (referencia lógica al Patients Service)
- `doctorId: UUID` (referencia lógica al Doctors Service)

**Eventos:**
- `AppointmentScheduled`
- `AppointmentConfirmed`
- `AppointmentCancelled`
- `AppointmentCompleted`

---

## 5. Diagrama de arquitectura propuesta

```
                    ┌──────────────────────────┐
                    │     API Gateway          │
                    │  (valida JWT + rutea)    │
                    └────────────┬─────────────┘
                                 │
            ┌────────────┬───────┴───────┬──────────────┐
            │            │               │              │
            ▼            ▼               ▼              ▼
    ┌─────────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐
    │  Identity   │ │ Patients │ │  Doctors   │ │ Appointments │
    │  Service    │ │ Service  │ │  Service   │ │   Service    │
    └──────┬──────┘ └────┬─────┘ └─────┬──────┘ └──────┬───────┘
           │             │             │               │
           ▼             ▼             ▼               ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐   ┌──────────┐
    │ Postgres │  │ Postgres │  │ Postgres │   │ Postgres │
    │ identity │  │ patients │  │ doctors  │   │appointmts│
    └──────────┘  └──────────┘  └──────────┘   └──────────┘
           │
           ▼
    ┌──────────┐                        ┌─────────────────────┐
    │  Valkey  │◄───── todos ───────────┤  Message Broker     │
    │ blocklist│                        │  (eventos dominio)  │
    └──────────┘                        └─────────────────────┘
```

---

## 6. Alternativas según madurez del equipo

| Estrategia | Servicios | BDs | Cuándo elegirla |
|-----------|-----------|-----|-----------------|
| **Mínima (start small)** | 3: Identity, Clinical (patients+doctors+specialties), Appointments | 3 | Equipo <10 personas, primera migración a microservicios |
| **Recomendada (este doc)** | 4 | 4 | Producto consolidado, equipos por dominio bien definidos |
| **Granular** | 6-7: Auth, Users, Patients, Doctors, Specialties, Appointments, Notifications | 6-7 | Tráfico alto, equipos independientes por servicio, mensajería madura |

### Estrategia mínima (3 servicios)

```
┌─────────────┐  ┌─────────────────────────┐  ┌──────────────┐
│  Identity   │  │  Clinical               │  │ Appointments │
│  (auth+     │  │  (patients+doctors+     │  │              │
│   users)    │  │   specialties)          │  │              │
└─────────────┘  └─────────────────────────┘  └──────────────┘
```

### Estrategia granular (7 servicios)

Separa Auth de Users, Specialties de Doctors, y añade Notifications. Solo justificable con equipos >30 personas y mensajería muy madura.

---

## 7. Trade-offs críticos al migrar

### 7.1. Las foreign keys desaparecen

Hoy `appointments.patient_id` es una **FK real** con `ON DELETE` controlado. En microservicios solo es un **UUID** sin garantía de integridad referencial.

**Solución:** consistencia eventual vía eventos:
- `PatientDeleted` → Appointments escucha y cancela citas pendientes
- `DoctorDeactivated` → Appointments reasigna o cancela citas futuras

### 7.2. Auth distribuido

La **blocklist JWT** en Valkey debe ser accesible desde el **API Gateway**, no desde cada servicio. El gateway valida el token y la blocklist antes de rutear, así cada servicio confía en el `req.user` que llega.

### 7.3. Datos duplicados intencionalmente

Appointments probablemente necesite cachear `doctorName` y `patientName` para no hacer round-trips en cada listado de calendario. **Esto no es un bug, es un patrón** (CQRS / read models).

### 7.4. Transacciones distribuidas

No existen. Toda operación que cruce bounded contexts debe diseñarse como:
- **Saga orquestada** (Appointments Service coordina)
- **Saga coreografiada** (cada servicio reacciona a eventos)

### 7.5. Migraciones independientes

El actual `synchronize: false` + carpeta `database/migrations` debe **dividirse**: cada servicio gestiona su propio versionado y sus propias migraciones.

### 7.6. Observabilidad obligatoria

Lo que hoy es un stack trace local pasa a ser una **traza distribuida**. OpenTelemetry deja de ser opcional.

---

## 8. Plan de migración por fases (Strangler Fig Pattern)

### Fase 1 — Extraer Identity Service
- Mover `auth` + `users` a servicio independiente
- API Gateway delega validación de JWT a Identity
- Monolito sigue funcionando, pero consulta Identity vía HTTP/gRPC

### Fase 2 — Extraer Appointments Service
- Es el dominio con más cambios → mayor ROI
- Patients y Doctors siguen en el monolito; Appointments los consulta vía API

### Fase 3 — Separar Patients y Doctors
- El monolito original queda vacío y se elimina
- Comunicación 100% vía API Gateway + eventos

### Fase 4 — Endurecimiento
- Implementar circuit breakers (Resilience4j / Polly)
- Trazas distribuidas completas
- Auto-scaling por servicio
- Backup y disaster recovery por BD

---

## 9. Resumen ejecutivo

| Métrica | Monolito actual | Microservicios propuestos |
|---------|-----------------|---------------------------|
| **Servicios desplegables** | 1 | 4 |
| **Bases de datos** | 1 PostgreSQL | 4 PostgreSQL + 1 Valkey |
| **Complejidad operacional** | Baja | Alta (broker, gateway, observabilidad) |
| **Escalado independiente** | No | Sí (cada servicio escala por su carga) |
| **Aislamiento de fallos** | No (un bug tumba todo) | Sí (con circuit breakers) |
| **Despliegues independientes** | No | Sí |
| **Consistencia transaccional** | ACID inmediata | Eventual (eventos + sagas) |
| **Latencia entre dominios** | Llamada en memoria | Red (HTTP/gRPC/eventos) |

### Recomendación final

**Empezar con 4 servicios + 4 PostgreSQL + 1 Valkey + 1 broker de eventos**, manteniendo:
- `Auth + Users` juntos en Identity Service
- `Doctors + Specialties` juntos en Doctors Service

Es el **punto óptimo** entre aislamiento de dominios y complejidad operacional para una clínica de tamaño mediano.

**No migrar si:**
- El equipo es <5 personas → el overhead operacional supera el beneficio
- No hay observabilidad madura → debugging se vuelve infernal
- No hay cultura de eventos y consistencia eventual → habrá race conditions en producción
