# Registro de Decisiones Arquitectónicas (ADR)

## Índice

| # | Título | Estado |
|---|--------|--------|
| ADR-001 | JwtAuthGuard global con opt-out mediante @Public() | Aceptado |
| ADR-002 | Argon2id para hash de contraseñas y refresh tokens | Aceptado |
| ADR-003 | Refresh Token Rotation con detección de reuso | Aceptado |
| ADR-004 | UUID v4 como clave primaria en todas las entidades | Aceptado |
| ADR-005 | Migraciones explícitas en lugar de synchronize de TypeORM | Aceptado |
| ADR-006 | Soft delete manual con isActive en lugar de @DeleteDateColumn | Aceptado |
| ADR-007 | Configuración tipada con namespaces separados | Aceptado |
| ADR-008 | Swagger protegido con Basic Auth, deshabilitado en producción | Aceptado |

---

## ADR-001: JwtAuthGuard global con opt-out mediante @Public()

**Estado:** Aceptado

**Contexto:**
En una API con autenticación JWT, la mayoría de endpoints deben estar protegidos. El patrón habitual es aplicar el guard manualmente en cada controlador o handler, lo que genera el riesgo de olvidar proteger un endpoint nuevo.

**Decisión:**
Registrar `JwtAuthGuard` como `APP_GUARD` en `AppModule` para que se aplique a todos los handlers sin excepción. Los endpoints que deben ser públicos (login, register, refresh) se marcan explícitamente con el decorador `@Public()`, que establece la metadata `IS_PUBLIC_KEY = true`. El guard lee esta metadata con `Reflector` y retorna `true` sin verificar el token.

**Consecuencias:**

- *Positivo:* Ningún endpoint nuevo queda desprotegido por omisión. La seguridad es el estado por defecto.
- *Positivo:* El contrato es visible en el código: la ausencia de `@Public()` comunica que el endpoint requiere autenticación.
- *Negativo:* Los desarrolladores deben conocer el patrón `@Public()` para crear endpoints no autenticados; sin esta documentación, puede resultar confuso.
- *Negativo:* El health check raíz (`GET /`) también requiere `@Public()` aunque solo devuelva `{ status: 'ok' }`.

---

## ADR-002: Argon2id para hash de contraseñas y refresh tokens

**Estado:** Aceptado

**Contexto:**
La elección del algoritmo de hashing de contraseñas tiene implicaciones directas en la resistencia a ataques de fuerza bruta con hardware especializado (GPU, ASIC). bcrypt y scrypt son alternativas comunes pero tienen limitaciones en cuanto a memory-hardness.

**Decisión:**
Usar `argon2` (librería nativa) con el modo `argon2id` (resistente tanto a ataques de canal lateral como a GPU) con los siguientes parámetros:

- `memoryCost`: 64 MB
- `timeCost`: 3 iteraciones
- `parallelism`: 4 hilos

El mismo algoritmo se aplica para hashear los refresh tokens antes de almacenarlos en la base de datos, evitando que un acceso a la DB comprometa las sesiones activas.

**Consecuencias:**

- *Positivo:* Argon2id es el ganador de la Password Hashing Competition (2015) y la recomendación actual de OWASP.
- *Positivo:* Los refresh tokens hasheados protegen contra el robo de sesiones via SQL injection.
- *Negativo:* El costo de CPU/RAM por operación de login es mayor que bcrypt. Con los parámetros actuales (~64 MB, ~300 ms), el servidor soporta decenas de logins/segundo en hardware modesto; el rate limiting de 5 rpm mitiga el riesgo de DDoS por login.
- *Negativo:* La librería `argon2` requiere compilación nativa (node-gyp), lo que complica entornos de CI sin las dependencias del sistema.

---

## ADR-003: Refresh Token Rotation con detección de reuso

**Estado:** Aceptado

**Contexto:**
Los refresh tokens de larga duración (7 días) son un vector de ataque si son robados. Una vez comprometido, el atacante puede obtener access tokens indefinidamente hasta que el token expire.

**Decisión:**
Implementar **Refresh Token Rotation**: cada llamada a `POST /auth/refresh` emite un nuevo par (access + refresh) e invalida el anterior actualizando el hash en la base de datos. Si se detecta que el refresh token recibido no coincide con el hash almacenado (reuso de un token ya rotado), se interpreta como posible compromiso y se revoca toda la familia borrando el `refreshTokenHash` del usuario, forzando un nuevo login.

**Consecuencias:**

- *Positivo:* Si un refresh token es robado y el atacante lo usa primero, el usuario legítimo detectará que su sesión fue invalidada en el próximo refresh.
- *Positivo:* El robo del token de base de datos no compromete sessiones: solo están almacenados los hashes.
- *Negativo:* Si el cliente pierde la respuesta de refresh (error de red justo después de que el servidor actualiza el hash), el usuario queda con un token inválido y debe re-autenticarse. Se requiere manejo cuidadoso de errores en el frontend.
- *Negativo:* No hay soporte para múltiples dispositivos simultáneos: un refresh en el dispositivo A invalida la sesión del dispositivo B.

---

## ADR-004: UUID v4 como clave primaria en todas las entidades

**Estado:** Aceptado

**Contexto:**
Las APIs con IDs numéricos secuenciales exponen información sobre el volumen de registros y facilitan ataques de enumeración (IDOR: `GET /patients/1`, `GET /patients/2`, etc.).

**Decisión:**
Todas las entidades usan `UUID v4` generado por la base de datos (`DEFAULT uuid_generate_v4()`) como clave primaria. TypeORM se configura con `@PrimaryGeneratedColumn('uuid')`.

**Consecuencias:**

- *Positivo:* Previene la enumeración de recursos y hace los IDs impredecibles.
- *Positivo:* Los IDs son globalmente únicos, lo que facilita migraciones y fusiones de datos sin colisiones.
- *Negativo:* Los UUID ocupan más espacio (16 bytes vs 4-8 bytes) e indexan más lento que los enteros en PostgreSQL para tablas muy grandes.
- *Negativo:* Los logs y la depuración son más verbosos con UUIDs completos.
- *Nota:* La prevención de IDOR no depende únicamente de los UUID; los servicios implementan adicionalmente `assertCanRead` / `assertCanWrite` por roles.

---

## ADR-005: Migraciones explícitas en lugar de synchronize de TypeORM

**Estado:** Aceptado

**Contexto:**
TypeORM ofrece `synchronize: true` que ajusta el esquema de la base de datos automáticamente al arrancar la aplicación. Esto es conveniente en desarrollo pero peligroso en producción: puede eliminar columnas o tablas con datos reales si las entidades cambian.

**Decisión:**
`synchronize: false` en todas las configuraciones de TypeORM. Los cambios de esquema se expresan como archivos de migración TypeScript en `src/database/migrations/`, versionados con timestamp en el nombre. Los scripts `migration:generate`, `migration:run` y `migration:revert` en `package.json` gestionan el ciclo de vida.

**Consecuencias:**

- *Positivo:* El historial de migraciones documenta la evolución del esquema y permite rollback controlado.
- *Positivo:* Producción nunca sufre cambios de esquema no intencionados al desplegar.
- *Negativo:* El ciclo de desarrollo es más lento: cada cambio de entidad requiere generar y verificar la migración.
- *Negativo:* `ormconfig.ts` debe mantenerse sincronizado con la configuración de TypeORM del módulo para que el CLI de TypeORM funcione correctamente.

---

## ADR-006: Soft delete manual con isActive en lugar de @DeleteDateColumn

**Estado:** Aceptado

**Contexto:**
TypeORM ofrece `@DeleteDateColumn` que implementa soft delete automático con un campo `deletedAt`. Sin embargo, esto requiere que todos los queries usen `withDeleted: false` o el decorador `@SoftDelete()`, lo que puede causar fugas de datos si algún query olvidado no filtra los registros eliminados.

**Decisión:**
Implementar soft delete mediante el campo `is_active: boolean DEFAULT true` en la entidad `users`. Los servicios que necesitan filtrar usuarios inactivos usan `INNER JOIN` con la condición `user.isActive = true`, lo que hace el filtrado explícito y visible en el código. Los roles `doctor` y `patient` quedan inaccesibles cuando su usuario asociado está inactivo.

**Consecuencias:**

- *Positivo:* El filtrado es explícito; no hay riesgo de olvidar un `withDeleted: false`.
- *Positivo:* Los datos de auditoría (citas históricas, etc.) se preservan asociados al usuario inactivo.
- *Negativo:* Cada query de relaciones debe incluir el JOIN con `users` para filtrar inactivos, añadiendo complejidad a las consultas.
- *Negativo:* No hay fecha de eliminación registrada. Si se necesita auditoría de cuándo se desactivó un usuario, habría que añadir un campo `deactivated_at` manualmente.

---

## ADR-007: Configuración tipada con namespaces separados

**Estado:** Aceptado

**Contexto:**
`@nestjs/config` permite centralizar la configuración, pero sin estructura puede volverse un objeto plano difícil de navegar y propenso a typos en las claves de acceso.

**Decisión:**
Crear tres archivos de configuración con namespaces explícitos (`app`, `database`, `jwt`) usando `registerAs()` de `@nestjs/config`. Cada archivo valida sus propias variables de entorno (incluyendo validaciones de seguridad como la longitud mínima de secretos JWT). Un barrel export en `config/index.ts` centraliza las importaciones. El acceso se hace con `configService.get<T>('namespace.key')`.

**Consecuencias:**

- *Positivo:* Las claves de configuración son descubribles y tipadas (autocompletado en IDE).
- *Positivo:* La validación de secretos en `jwt.config.ts` implementa un patrón *fail-fast*: la aplicación no arranca en producción con secretos débiles.
- *Positivo:* Cada módulo puede importar solo el namespace que necesita.
- *Negativo:* Añade boilerplate comparado con `process.env.VARIABLE` directamente.

---

## ADR-008: Swagger protegido con Basic Auth, deshabilitado en producción

**Estado:** Aceptado

**Contexto:**
La documentación Swagger expone la superficie de ataque completa de la API (todos los endpoints, parámetros y schemas). Dejarla pública o habilitada en producción facilita el reconocimiento a atacantes.

**Decisión:**
Swagger solo se inicializa cuando `NODE_ENV !== 'production'`. La ruta `/api/docs` se protege con `express-basic-auth` usando credenciales definidas en las variables de entorno `SWAGGER_USER` y `SWAGGER_PASSWORD`. El acceso a endpoints autenticados dentro de Swagger requiere además un Bearer token JWT válido.

**Consecuencias:**

- *Positivo:* La documentación no es accesible en producción, reduciendo la superficie de ataque.
- *Positivo:* En desarrollo, el equipo tiene acceso a la documentación interactiva sin comprometer la seguridad.
- *Negativo:* El equipo de QA o frontend no puede usar Swagger en producción para debugging; necesitarán un entorno de staging.
- *Negativo:* Las credenciales de Swagger en `.env` son un secreto adicional a gestionar y rotar.
