# Diagrama Entidad-Relación — Clinic API

Basado en las entidades TypeORM del proyecto (`user.entity.ts`, `patient.entity.ts`, `doctor.entity.ts`, `specialty.entity.ts`, `appointment.entity.ts`) y las migraciones (`1776681637179-InitialSchema.ts`, `1776700000000-AddRefreshTokenToUser.ts`).

```mermaid
erDiagram

    users {
        uuid id PK "PRIMARY KEY, UUID v4"
        varchar email UK "UNIQUE NOT NULL"
        varchar password_hash "Argon2id hash, NOT NULL"
        enum role "admin | doctor | patient, NOT NULL"
        boolean is_active "DEFAULT true, soft delete flag"
        varchar refresh_token_hash "Argon2id hash, NULLABLE"
        timestamp created_at "DEFAULT NOW()"
        timestamp updated_at "DEFAULT NOW() ON UPDATE"
    }

    patients {
        uuid id PK "PRIMARY KEY, UUID v4"
        uuid user_id FK "UNIQUE, FK → users.id"
        varchar first_name "NOT NULL"
        varchar last_name "NOT NULL"
        date birth_date "NULLABLE"
        enum gender "male | female | other, NULLABLE"
        varchar phone "NULLABLE"
        varchar address "NULLABLE"
        timestamp created_at "DEFAULT NOW()"
        timestamp updated_at "DEFAULT NOW() ON UPDATE"
    }

    doctors {
        uuid id PK "PRIMARY KEY, UUID v4"
        uuid user_id FK "UNIQUE, FK → users.id"
        varchar first_name "NOT NULL"
        varchar last_name "NOT NULL"
        varchar license_number UK "UNIQUE NOT NULL"
        varchar phone "NULLABLE"
        timestamp created_at "DEFAULT NOW()"
        timestamp updated_at "DEFAULT NOW() ON UPDATE"
    }

    specialties {
        uuid id PK "PRIMARY KEY, UUID v4"
        varchar name UK "UNIQUE NOT NULL"
        varchar description "NULLABLE"
        timestamp created_at "DEFAULT NOW()"
        timestamp updated_at "DEFAULT NOW() ON UPDATE"
    }

    doctor_specialties {
        uuid doctor_id PK,FK "FK → doctors.id, ON DELETE CASCADE"
        uuid specialty_id PK,FK "FK → specialties.id, ON DELETE NO ACTION"
    }

    appointments {
        uuid id PK "PRIMARY KEY, UUID v4"
        uuid patient_id FK "FK → patients.id, NOT NULL"
        uuid doctor_id FK "FK → doctors.id, NOT NULL"
        date date "NOT NULL"
        time start_time "NOT NULL"
        time end_time "NOT NULL"
        enum status "scheduled | confirmed | cancelled | completed | no_show"
        text notes "NULLABLE, sin límite en BD (type: text)"
        timestamp created_at "DEFAULT NOW()"
        timestamp updated_at "DEFAULT NOW() ON UPDATE"
    }

    users ||--o| patients : "OneToOne (user_id)"
    users ||--o| doctors : "OneToOne (user_id)"
    patients ||--o{ appointments : "OneToMany (patient_id)"
    doctors ||--o{ appointments : "OneToMany (doctor_id)"
    doctors }o--o{ specialties : "ManyToMany (doctor_specialties)"
```

---

## Notas sobre las relaciones

| Relación | Cardinalidad | Columna FK | ON DELETE |
|----------|-------------|------------|-----------|
| `users` → `patients` | 1:1 (opcionales) | `patients.user_id` | NO ACTION |
| `users` → `doctors` | 1:1 (opcionales) | `doctors.user_id` | NO ACTION |
| `patients` → `appointments` | 1:N | `appointments.patient_id` | NO ACTION |
| `doctors` → `appointments` | 1:N | `appointments.doctor_id` | NO ACTION |
| `doctors` ↔ `specialties` | N:M | `doctor_specialties` (tabla intermedia) | CASCADE |

### Soft delete

La eliminación lógica se implementa mediante la columna `users.is_active`. No existe una columna `deleted_at` de TypeORM (`@DeleteDateColumn`); el soft delete se gestiona manualmente en los servicios estableciendo `is_active = false`. Los queries de lectura usan `INNER JOIN` sobre `users` para filtrar automáticamente los registros inactivos.

### Enums en base de datos

Los enums se almacenan como `varchar` / tipo nativo de PostgreSQL según la configuración de TypeORM:

- `users.role`: `admin`, `doctor`, `patient`
- `patients.gender`: `male`, `female`, `other`
- `appointments.status`: `scheduled`, `confirmed`, `cancelled`, `completed`, `no_show`

### Tabla intermedia `doctor_specialties`

Es una tabla pura de unión (sin columnas adicionales) generada por TypeORM para la relación `@ManyToMany` entre `Doctor` y `Specialty`. Las dos FKs forman el `PRIMARY KEY` compuesto, pero tienen comportamientos de borrado distintos: `doctor_id` tiene `ON DELETE CASCADE` (si se elimina el médico, sus filas en la tabla intermedia se borran automáticamente) y `specialty_id` tiene `ON DELETE NO ACTION` (no se puede borrar una especialidad mientras tenga médicos asignados).
