# IDOR en este proyecto — Qué es, dónde aparece y cómo se previene

Este documento explica con detalle qué es **IDOR** (*Insecure Direct Object
References*), por qué es peligroso, cómo este proyecto lo previene, y muestra
**todo el código comprometido** en cada caso. Sin dar nada por sentado.

---

## 1. ¿Qué es IDOR?

**IDOR** son las siglas de *Insecure Direct Object References* —
"Referencias directas inseguras a objetos". Es una vulnerabilidad de **control
de acceso** clasificada por OWASP dentro de **A01:2021 / A01:2025 — Broken
Access Control**, la categoría número uno del Top 10 desde hace años.

### La definición exacta

Un IDOR ocurre cuando una API expone una **referencia directa** a un objeto
interno (típicamente un ID en la URL, en el body o en un parámetro) y **no
verifica si el usuario autenticado tiene permiso para acceder a ese objeto
específico**.

El error conceptual es simple pero devastador: **autenticar no es lo mismo
que autorizar**.

- **Autenticación** responde a "¿quién eres?" — la valida `JwtAuthGuard`.
- **Autorización** responde a "¿puedes acceder *a esto*?" — y se le suele olvidar.

Si una API solo verifica que haya un token válido (autenticación) pero no
comprueba que el recurso solicitado **pertenezca** al usuario del token
(autorización por ownership), cualquier usuario autenticado puede acceder a
los recursos de cualquier otro usuario simplemente cambiando el ID en la URL.

### El ejemplo canónico

```http
GET /api/v1/patients/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <token-de-juan>
```

Si la API responde con los datos del paciente sin comprobar nada más que
"el token es válido", entonces Juan acaba de leer la ficha clínica de otro
paciente cuyo UUID adivinó, robó o copió de un enlace. Ese es el IDOR clásico.

### Por qué es especialmente grave en una clínica

En esta API gestionamos:

- **Datos clínicos de pacientes** (historiales, fechas de nacimiento, género).
- **Agendas de médicos** (citas, horarios, disponibilidad).
- **Información médica sensible** asociada a citas (notas clínicas).

Un IDOR aquí no es solo una violación de privacidad — puede ser una violación
de regulaciones sanitarias (HIPAA, GDPR Art. 9 sobre datos sensibles). Por
eso este proyecto trata IDOR como un riesgo **crítico**, no como un detalle.

---

## 2. El patrón vulnerable — cómo NO hacerlo

Antes de mostrar la solución, conviene ver claramente el antipatrón. Un endpoint
vulnerable a IDOR tendría esta forma:

```typescript
// ❌ CÓDIGO VULNERABLE — NO usado en este proyecto
@UseGuards(JwtAuthGuard)
@Get('patients/:id')
async findOne(@Param('id') id: string) {
  // El único control es "el token es válido".
  // No se mira quién pide ni si el recurso le pertenece.
  return this.patientRepository.findOne({ where: { id } });
}
```

Lo que falla: la función recibe un `id` desde la URL y devuelve el recurso sin
comprobar nada sobre **el usuario que está haciendo la petición**. Cualquier
token válido — de cualquier paciente — accede a cualquier ficha. La autenticación
está; la autorización no.

---

## 3. Cómo este proyecto lo previene — la arquitectura completa

La defensa contra IDOR aquí está construida en **cuatro capas** que trabajan
juntas. Cada capa es independiente y aporta una protección distinta — es
**defense in depth** aplicada al control de acceso.

```
Petición HTTP con Authorization: Bearer <token>
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ CAPA 1 — JwtAuthGuard (global, en app.module.ts)              │
│ "¿Quién es este?" — autenticación                              │
│ Inyecta req.user = { id, email, role }                         │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ CAPA 2 — RolesGuard + @Roles                                  │
│ "¿Puede ENTRAR a este endpoint según su rol?" — RBAC          │
│ findAll de pacientes solo ADMIN, etc.                          │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ CAPA 3 — @CurrentUser() decorator                             │
│ Extrae req.user y lo pasa tipado al servicio                   │
│ Garantiza que la autorización ocurra con datos del token,      │
│ no con un userId del body (que sería manipulable)              │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ CAPA 4 — Servicios con helpers de ownership                   │
│ "¿Puede acceder a ESTE RECURSO concreto?" — autorización fina │
│ assertCanRead, assertCanWrite, assertCanAccess                 │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
        Acceso permitido — solo si las cuatro capas pasaron
```

---

## 4. Las piezas, una por una

### 4.1 — `AuthenticatedUser` — el contrato del principal

Antes de ver cómo se usa, hay que ver **qué es** el usuario autenticado en este
sistema. Es un tipo canónico que viaja por todas las capas.

**Archivo:** `src/common/types/authenticated-user.interface.ts`

```typescript
import { UserRole } from '../../users/entities/user.entity';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Sin RBAC / IDOR (#3, #4)
// Mitigación: tipo canónico del usuario autenticado que
//   viaja en req.user tras pasar JwtAuthGuard. Evita que
//   cada capa redescubra la forma del objeto.
// Justificación OWASP A01/A04: centralizar el contrato del
//   principal autenticado facilita auditar las decisiones de
//   autorización y previene checks ad-hoc inconsistentes.
// ─────────────────────────────────────────────
export interface AuthenticatedUser {
  id: string;       // userId — UUID del usuario autenticado
  email: string;
  role: UserRole;   // 'admin' | 'doctor' | 'patient'
}
```

**Qué hay que entender:**

- Tres campos. Nada más. No hay `password`, no hay datos personales — es solo
  la **identidad mínima** necesaria para autorizar.
- `id` es el `userId` extraído del claim `sub` del JWT. Es la pieza clave: las
  comprobaciones de ownership comparan este `id` contra `patient.userId`,
  `doctor.userId`, etc.
- Este tipo es lo que devuelve `JwtStrategy.validate()` y lo que NestJS adjunta
  a `req.user` automáticamente.

---

### 4.2 — `@CurrentUser()` — el decorator que extrae el principal

Para que los métodos del controlador y del servicio puedan usar el principal,
hay que extraerlo de `req.user`. Hacerlo a mano cada vez sería repetitivo y
propenso a errores. Por eso existe este decorator.

**Archivo:** `src/common/decorators/current-user.decorator.ts`

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: IDOR (#4)
// Mitigación: @CurrentUser() extrae req.user inyectado por
//   JwtAuthGuard. Permite pasar el principal autenticado como
//   argumento tipado al servicio, donde se hacen los checks
//   de ownership de manera explícita y testeable.
// Justificación OWASP A01 Broken Access Control: evita que
//   los servicios confíen ciegamente en parámetros de URL y
//   obliga a contrastar "quién pide" vs "qué recurso".
// ─────────────────────────────────────────────
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
```

**Qué hay que entender línea por línea:**

- **`createParamDecorator(...)`** — API de NestJS para crear decoradores de
  parámetros. Igual que `@Body()`, `@Param()`, `@Req()`.
- **`(_data, ctx) => ...`** — la función que se ejecuta para producir el valor
  del argumento. `_data` sería un argumento del decorator (no se usa aquí), `ctx`
  es el contexto de ejecución.
- **`ctx.switchToHttp().getRequest()`** — obtiene el objeto `Request` de Express.
- **`request.user`** — el objeto que `JwtStrategy.validate()` colocó allí. Si
  esta línea ejecutara y `request.user` fuera `undefined`, sería porque el
  endpoint no está protegido por `JwtAuthGuard` — un bug de configuración.

**Por qué es crítico para prevenir IDOR:** garantiza que la información de
autorización viene del **token verificado**, no del body o de un parámetro
manipulable por el cliente. Un atacante puede mentir en el body (`"userId": "<id-de-otro>"`),
pero no puede mentir en `req.user` — eso lo pone el servidor a partir de la
firma del JWT.

---

### 4.3 — `RolesGuard` y `@Roles()` — RBAC declarativo

La segunda capa es el RBAC: comprobar que el rol del usuario permite acceder
al endpoint. Esto **no resuelve IDOR completo**, pero corta una clase entera
de problemas: por ejemplo, que un paciente pueda llamar a `findAll` y obtener
una lista de todos los pacientes.

**Archivo:** `src/common/guards/roles.guard.ts`

```typescript
@Injectable()
export class RolesGuard implements CanActivate {

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // getAllAndOverride combina metadata de método y clase —
    // el método prevalece si ambos tienen @Roles
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Sin @Roles en el handler/clase — este guard no opina.
    // El JwtAuthGuard ya se aseguró de que haya usuario autenticado.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        'No tienes permisos para acceder a este recurso',
      );
    }

    return true;
  }
}
```

**Qué hay que entender:**

- **`reflector.getAllAndOverride(ROLES_KEY, ...)`** — lee la metadata que
  `@Roles(UserRole.ADMIN)` puso en el handler o la clase. Si no hay nada, el
  guard pasa sin opinar (otros endpoints siguen sus propias reglas).
- **`requiredRoles.includes(user.role)`** — comprueba si el rol del usuario
  está en la lista de roles permitidos.
- **`throw new ForbiddenException(...)`** — devuelve **403 Forbidden**, no 401.
  La diferencia es importante: 401 = "no sé quién eres", 403 = "sé quién eres
  pero no puedes". El usuario está autenticado, solo carece de permiso.

**Cómo se usa en un controlador:**

```typescript
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('patients')
export class PatientsController {

  @Get()
  @Roles(UserRole.ADMIN)   // ← solo admins pueden listar
  findAll() { ... }

  @Get(':id')
  // sin @Roles — cualquier usuario autenticado pasa el guard,
  // pero el servicio aplicará ownership (capa 4)
  findOne(...) { ... }
}
```

**Lo importante:** RBAC controla quién puede llamar al endpoint, **no** qué
recursos específicos puede ver. Un paciente cualquiera pasa `RolesGuard` en
`GET /patients/:id` (no hay `@Roles` restrictivo), pero la capa 4 lo bloqueará
si pide la ficha de otro paciente.

---

### 4.4 — Helpers de ownership en los servicios — la capa que mata IDOR

Esta es la capa donde realmente se previene IDOR. Cada servicio que maneja
recursos sensibles tiene helpers privados que comparan el `currentUser` contra
el dueño del recurso solicitado.

El patrón se repite — vamos a verlo en dos servicios concretos.

---

## 5. Casos concretos en este proyecto

### Caso 1 — Un paciente intentando leer la ficha de otro paciente

**Escenario:** Juan (paciente) sabe que el UUID de la ficha de María es
`550e8400-...`. Hace `GET /api/v1/patients/550e8400-...` con su propio token.

**Archivo:** `src/patients/patients.controller.ts`

```typescript
@Get(':id')
@ApiOperation({ summary: 'Obtener paciente por id (ownership)' })
findOne(
  @Param('id', ParseUUIDPipe) id: string,
  @CurrentUser() user: AuthenticatedUser,   // ← extrae el principal
) {
  return this.patientsService.findOne(id, user);  // ← lo pasa al servicio
}
```

**Archivo:** `src/patients/patients.service.ts`

```typescript
async findOne(id: string, currentUser: AuthenticatedUser): Promise<Patient> {
  const patient = await this.patientRepository
    .createQueryBuilder('patient')
    .innerJoin('patient.user', 'user', 'user.isActive = :active', {
      active: true,
    })
    .where('patient.id = :id', { id })
    .getOne();

  if (!patient) {
    throw new NotFoundException(`Paciente con id ${id} no encontrado`);
  }

  this.assertCanRead(currentUser, patient);   // ← AQUÍ se previene IDOR
  return patient;
}

// Helper de autorización
private assertCanRead(user: AuthenticatedUser, patient: Patient): void {
  if (user.role === UserRole.ADMIN || user.role === UserRole.DOCTOR) return;
  if (patient.userId === user.id) return;
  throw new ForbiddenException(
    'No tienes permisos para acceder a este recurso',
  );
}
```

**Qué hay que entender línea por línea de `assertCanRead`:**

- **`if (user.role === ADMIN || user.role === DOCTOR) return;`** — las dos
  primeras ramas. Un admin puede ver cualquier ficha (rol administrativo).
  Un doctor también puede ver cualquier ficha (necesario para atender pacientes).
- **`if (patient.userId === user.id) return;`** — la rama del paciente. Un
  paciente solo pasa si el `userId` de la ficha coincide con su propio `id`
  del JWT. Si Juan tiene `id = "juan-uuid"` y la ficha de María tiene
  `userId = "maria-uuid"`, esos UUIDs **no coinciden** y caemos en la última línea.
- **`throw new ForbiddenException(...)`** — 403, mensaje genérico, sin filtrar
  ninguna información sobre el recurso.

**Aplicado al escenario:**

```
GET /patients/550e8400-...   (UUID de María)
Authorization: Bearer <token-de-juan>
        │
        ▼
JwtAuthGuard valida el token de Juan
req.user = { id: "juan-uuid", email: "juan@...", role: "patient" }
        │
        ▼
RolesGuard: no hay @Roles en findOne → pasa
        │
        ▼
Controller findOne ejecuta:
  - id = "550e8400-..." (de la URL)
  - user = { id: "juan-uuid", role: "patient" }   (de @CurrentUser)
  - llama service.findOne(id, user)
        │
        ▼
Service findOne carga el paciente de BD
  patient = { id: "550e8400-...", userId: "maria-uuid", ... }
        │
        ▼
assertCanRead(juan, patient):
  - juan.role === ADMIN? No
  - juan.role === DOCTOR? No
  - patient.userId === juan.id? 
      "maria-uuid" === "juan-uuid"? NO
  - throw ForbiddenException
        │
        ▼
🛑 HTTP 403 — "No tienes permisos para acceder a este recurso"
   La ficha de María nunca llega al cliente.
```

---

### Caso 2 — Un paciente creando una ficha de paciente para OTRO usuario

**Escenario:** Juan se registró como usuario y ahora va a crear su ficha de
paciente. Pero en lugar de poner su propio `userId` en el body, pone el de
María, intentando "secuestrar" su ficha o crear una ficha falsa sobre ella.

```http
POST /api/v1/patients
Authorization: Bearer <token-de-juan>
Content-Type: application/json

{
  "userId": "maria-uuid",   ← intenta usar el userId de OTRO usuario
  "firstName": "María",
  "lastName": "García",
  "birthDate": "1990-01-15"
}
```

**Archivo:** `src/patients/patients.service.ts` — método `create()`

```typescript
// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Privilege escalation lateral al crear pacientes (#4)
// Mitigación: si el caller es PATIENT, se fuerza que el userId
//   del DTO coincida con su propio id. ADMIN puede crear fichas
//   para cualquier userId (flujo administrativo). DOCTOR no puede
//   crear pacientes — no es su responsabilidad.
// Justificación OWASP A01 + A04: evita que un paciente legítimo
//   cree una ficha sobre otro userId para acceder a sus datos.
// ─────────────────────────────────────────────
async create(
  createPatientDto: CreatePatientDto,
  currentUser: AuthenticatedUser,
): Promise<Patient> {

  if (currentUser.role === UserRole.DOCTOR) {
    throw new ForbiddenException(
      'Los médicos no pueden crear pacientes',
    );
  }

  if (
    currentUser.role === UserRole.PATIENT &&
    createPatientDto.userId !== currentUser.id
  ) {
    throw new ForbiddenException(
      'Solo puedes crear tu propia ficha de paciente',
    );
  }

  // ... resto del método
}
```

**Qué hay que entender:**

- **`createPatientDto.userId`** viene del **body** — el cliente lo envía. Es
  manipulable. Juan puso `"maria-uuid"`.
- **`currentUser.id`** viene del **token verificado** — es la identidad real
  de Juan. **No es manipulable** sin romper la firma del JWT.
- La comparación `createPatientDto.userId !== currentUser.id` detecta
  exactamente este intento: el cliente está afirmando ser otra persona.
- Si Juan hubiera puesto `"juan-uuid"` (el suyo), la comparación pasaría y
  podría crear su ficha legítimamente.

**Aplicado al escenario:**

```
POST /patients con body { userId: "maria-uuid", ... }
Authorization: Bearer <token-de-juan>
        │
        ▼
service.create():
  currentUser = { id: "juan-uuid", role: "patient" }
  dto.userId = "maria-uuid"
        │
        ▼
if (PATIENT && dto.userId !== currentUser.id):
  "maria-uuid" !== "juan-uuid"  → true
  throw ForbiddenException
        │
        ▼
🛑 HTTP 403 — "Solo puedes crear tu propia ficha de paciente"
```

**Por qué este chequeo NO se podría hacer solo con RBAC:** ambos pacientes
tienen el rol `PATIENT`. RBAC dice "los pacientes pueden crear fichas". La
pregunta más fina — "¿este paciente puede crear *esta* ficha?" — solo se
puede responder cruzando el `userId` del body con el `id` del token.

---

### Caso 3 — Un médico intentando ver la agenda de otro médico

**Escenario:** El Dr. Ramírez quiere ver la agenda de la Dra. López. Hace
`GET /api/v1/appointments/doctor/<id-de-lopez>` con su propio token.

**Archivo:** `src/appointments/appointments.service.ts` — método `findByDoctor()`

```typescript
async findByDoctor(
  doctorId: string,
  currentUser: AuthenticatedUser,
): Promise<Appointment[]> {
  const doctor = await this.doctorRepository.findOne({
    where: { id: doctorId },
  });
  if (!doctor) {
    throw new NotFoundException(`Médico con id ${doctorId} no encontrado`);
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: IDOR en /appointments/doctor/:id (#4)
  // Mitigación: DOCTOR solo puede consultar sus propias citas;
  //   PATIENT no tiene acceso directo a las agendas por médico
  //   (obtendría información sobre otros pacientes).
  // ─────────────────────────────────────────────
  if (currentUser.role === UserRole.DOCTOR) {
    const ownDoctorId = await this.resolveDoctorIdForUser(currentUser);
    if (!ownDoctorId || ownDoctorId !== doctorId) {
      throw new ForbiddenException(
        'Solo puedes consultar tu propia agenda',
      );
    }
  } else if (currentUser.role === UserRole.PATIENT) {
    throw new ForbiddenException(
      'Los pacientes no pueden listar las citas de un médico',
    );
  }

  return this.appointmentRepository
    .createQueryBuilder('appointment')
    // ... query
    .getMany();
}

// Helper que resuelve el doctorId a partir del userId del JWT
private async resolveDoctorIdForUser(
  user: AuthenticatedUser,
): Promise<string | null> {
  if (user.role !== UserRole.DOCTOR) return null;
  const doctor = await this.doctorRepository.findOne({
    where: { userId: user.id },
  });
  return doctor?.id ?? null;
}
```

**Qué hay que entender — y el detalle clave de este caso:**

Hay que distinguir dos UUIDs distintos que es muy fácil confundir:

- **`user.id`** — el id del **registro en la tabla `users`**. Es lo que firma
  el JWT en el claim `sub`.
- **`doctor.id`** — el id del **registro en la tabla `doctors`**. Es lo que
  va en la URL `/appointments/doctor/<doctor.id>`.

Un mismo médico tiene **ambos**: una fila en `users` (autenticación) y otra en
`doctors` (datos profesionales) enlazadas por `doctor.userId = user.id`.

`resolveDoctorIdForUser` traduce un `user.id` a su `doctor.id` correspondiente.
Esto es necesario porque la URL usa `doctor.id`, pero el JWT solo lleva `user.id`.

**Aplicado al escenario:**

```
GET /appointments/doctor/<id-de-doctora-lopez>
Authorization: Bearer <token-de-doctor-ramirez>
        │
        ▼
currentUser = { id: "ramirez-userid", role: "doctor" }
doctorId    = "lopez-doctorid"  (de la URL)
        │
        ▼
resolveDoctorIdForUser(ramirez):
  - busca en doctors: WHERE userId = "ramirez-userid"
  - devuelve "ramirez-doctorid"
        │
        ▼
if (ownDoctorId !== doctorId):
  "ramirez-doctorid" !== "lopez-doctorid"  → true
  throw ForbiddenException
        │
        ▼
🛑 HTTP 403 — "Solo puedes consultar tu propia agenda"
```

La rama del `else if (PATIENT)` añade una protección extra: los pacientes ni
siquiera pueden listar agendas por médico, porque eso revelaría datos de otros
pacientes (los que tienen citas con ese médico).

---

### Caso 4 — Un paciente creando una cita para otro paciente

**Escenario:** Juan intenta crear una cita poniendo el `patientId` de María
en el body, para llenarle la agenda o para inscribirse a una hora reservada
para ella.

**Archivo:** `src/appointments/appointments.service.ts` — método `create()`

```typescript
async create(
  createAppointmentDto: CreateAppointmentDto,
  currentUser: AuthenticatedUser,
): Promise<Appointment> {

  // ... validación de horario ...

  if (currentUser.role === UserRole.PATIENT) {
    const ownPatientId = await this.resolvePatientIdForUser(currentUser);
    if (!ownPatientId || ownPatientId !== createAppointmentDto.patientId) {
      throw new ForbiddenException(
        'Solo puedes crear citas para ti mismo',
      );
    }
  }

  if (currentUser.role === UserRole.DOCTOR) {
    const ownDoctorId = await this.resolveDoctorIdForUser(currentUser);
    if (!ownDoctorId || ownDoctorId !== createAppointmentDto.doctorId) {
      throw new ForbiddenException(
        'Los médicos solo pueden crear citas en las que participen',
      );
    }
  }

  // ... resto
}

// Helper análogo a resolveDoctorIdForUser, pero para pacientes
private async resolvePatientIdForUser(
  user: AuthenticatedUser,
): Promise<string | null> {
  if (user.role !== UserRole.PATIENT) return null;
  const patient = await this.patientRepository.findOne({
    where: { userId: user.id },
  });
  return patient?.id ?? null;
}
```

**Qué hay que entender:**

- El patrón es idéntico al Caso 2, pero ahora la comparación se hace contra
  **`patient.id`** (no `user.id`), porque el body de la cita habla en términos
  de pacientes y médicos, no de usuarios.
- `resolvePatientIdForUser` traduce el `user.id` del JWT al `patient.id` que
  correspondería en la tabla `patients`.
- La comparación final: `ownPatientId !== createAppointmentDto.patientId`. Si
  Juan firma con su `user.id` (que se traduce a `juan-patientid`) e intenta
  poner `patientId = "maria-patientid"` en el body, no coinciden.

**Una protección adicional simétrica para doctores:** un médico no puede crear
una cita asignándola a otro médico. La rama del `if (DOCTOR)` lo bloquea.

---

### Caso 5 — Citas: lectura con tres roles, tres reglas distintas

Este es el caso más complejo y también el más representativo de cómo se diseña
una autorización fina. Una cita médica involucra a **dos partes** (paciente y
médico) y un tercero administrativo (admin). Las reglas de quién puede leerla
son distintas para cada rol.

**Archivo:** `src/appointments/appointments.service.ts` — helper `assertCanAccess`

```typescript
// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: IDOR en appointments (#4)
// Mitigación: helpers de autorización — solo las partes
//   involucradas (paciente, médico) o un ADMIN pueden leer
//   o modificar una cita específica.
// Justificación OWASP A01 + A04: una cita médica contiene
//   datos clínicos sensibles; terceros no deben acceder ni
//   modificar agendas ajenas.
// ─────────────────────────────────────────────
private async assertCanAccess(
  user: AuthenticatedUser,
  appointment: Appointment,
): Promise<void> {
  if (user.role === UserRole.ADMIN) return;

  if (user.role === UserRole.PATIENT) {
    const patient = await this.patientRepository.findOne({
      where: { userId: user.id },
    });
    if (patient && patient.id === appointment.patientId) return;
  }

  if (user.role === UserRole.DOCTOR) {
    const doctor = await this.doctorRepository.findOne({
      where: { userId: user.id },
    });
    if (doctor && doctor.id === appointment.doctorId) return;
  }

  throw new ForbiddenException(
    'No tienes permisos para acceder a esta cita',
  );
}
```

**Qué hay que entender — las tres ramas:**

**Rama ADMIN:** acceso libre. Un administrador gestiona el sistema.

**Rama PATIENT:** el paciente solo accede a la cita si **él es el paciente
de esa cita**. La comparación se hace traduciendo su `user.id` al `patient.id`
correspondiente y comparándolo con `appointment.patientId`.

**Rama DOCTOR:** el médico solo accede a la cita si **él es el médico de esa
cita**. Misma lógica que arriba pero contra `doctor.id` y `appointment.doctorId`.

**Si ninguna rama returnó:** la cita no le pertenece al usuario en ninguno de
los sentidos posibles → 403.

**Por qué este diseño es elegante:**

- Las **dos partes** de la cita (paciente, médico) tienen acceso por su rol
  natural en la cita — no hace falta una lógica especial.
- El **admin** lo gestiona como sysadmin, sin ser parte de la cita.
- **Cualquier otro usuario autenticado** (otro paciente, otro médico) cae al
  `throw` del final.

`assertCanAccess` se invoca desde `findOne()`, `updateStatus()`, `update()` y
`remove()` — todas las operaciones que tocan una cita específica.

---

## 6. Defense in depth — por qué hay tantas capas

Una pregunta natural: si el helper de ownership en el servicio (capa 4) ya es
suficiente para detener IDOR, ¿por qué tener también `RolesGuard` y `@Roles`?

Porque cada capa cubre un fallo distinto:

| Si falla esta capa... | ...se queda esta como red de seguridad |
|---|---|
| Olvidan poner `@Roles(ADMIN)` en `findAll` | Aún se exige token (capa 1) y, si fuera un endpoint sensible, el servicio comprobaría ownership por recurso (capa 4) |
| Un servicio nuevo olvida llamar a `assertCanRead` | RBAC en el controller limita quién entra (capa 2 o 3) — un paciente no llega a `GET /admin/...` |
| El JWT es inválido | `JwtAuthGuard` lo rechaza antes de tocar nada (capa 1) |
| El usuario fue desactivado | `JwtStrategy.validate()` consulta `isActive` y lanza 401 antes de llegar al controller |

**El principio que guía todo esto:** ninguna capa por sí sola es suficiente.
Son redundantes deliberadamente — cuando una falla, otra la cubre. Es la
diferencia entre "seguridad por casualidad" (un único punto de control que
hay que recordar) y "seguridad por diseño" (varios puntos independientes
que se respaldan entre sí).

---

## 7. La tabla maestra — IDOR en cada endpoint sensible

| Endpoint | Recurso | Capa que previene IDOR | Helper |
|---|---|---|---|
| `GET /patients/:id` | Ficha de paciente | Service `findOne` | `assertCanRead` |
| `POST /patients` | Crear ficha | Service `create` | Comparación `dto.userId !== currentUser.id` |
| `PATCH /patients/:id` | Modificar ficha | Service `update` | `assertCanWrite` |
| `GET /patients/user/:userId` | Ficha por userId | Service `findByUserId` | `assertCanRead` |
| `GET /appointments/:id` | Cita específica | Service `findOne` | `assertCanAccess` |
| `POST /appointments` | Crear cita | Service `create` | `resolvePatientIdForUser` + comparación |
| `PATCH /appointments/:id` | Modificar cita | Service `update` (vía `findOne`) | `assertCanAccess` |
| `PATCH /appointments/:id/status` | Cambiar estado | Service `updateStatus` (vía `findOne`) | `assertCanAccess` |
| `DELETE /appointments/:id` | Cancelar cita | Service `remove` (vía `findOne`) | `assertCanAccess` |
| `GET /appointments/patient/:patientId` | Citas de un paciente | Service `findByPatient` | Comparación + filtro doctor para DOCTOR |
| `GET /appointments/doctor/:doctorId` | Agenda de un médico | Service `findByDoctor` | `resolveDoctorIdForUser` + comparación |

---

## 8. Reglas de oro contra IDOR — extraídas de este proyecto

Estas son las decisiones de diseño concretas que cualquier nuevo módulo del
proyecto debería seguir para mantener la inmunidad contra IDOR:

1. **El servicio recibe siempre `currentUser: AuthenticatedUser`.** Cualquier
   método que acceda a un recurso parametrizado por ID debe recibir también
   al solicitante.

2. **Nunca comparar `dto.userId` consigo mismo.** Comparar siempre contra
   `currentUser.id` extraído del token verificado.

3. **Cargar el recurso primero, autorizar después.** El patrón es:
   `cargar → si no existe → 404 → autorizar → si no autorizado → 403`. Un
   atacante no debe poder distinguir "no existe" de "no me lo dejan ver"
   por el orden de los chequeos — pero en este proyecto el 404 antes del 403
   es deliberado: con `ParseUUIDPipe` el formato del UUID ya está validado,
   así que un 404 tras `ParseUUIDPipe` es informativo legítimo.

4. **Cuando un mismo dominio tiene IDs distintos** (`user.id` vs `patient.id`
   vs `doctor.id`), traducirlos explícitamente con helpers como
   `resolvePatientIdForUser` — nunca asumir que el ID del JWT sirve directamente.

5. **El admin pasa por una rama `if`, no por la ausencia de chequeo.** El
   helper siempre se ejecuta; el admin retorna temprano. Así el código de
   autorización es el mismo para todos los roles, solo cambia la decisión.

6. **403, no 404 ni 401, cuando hay autenticación pero no autorización.** El
   código HTTP comunica con precisión qué falló — eso ayuda al cliente legítimo
   y al equipo de seguridad cuando auditan logs.

7. **El comentario `[SECURE-FIX]` en el código es la trazabilidad.** Cada
   helper de ownership lleva el bloque que documenta qué vulnerabilidad
   resuelve, con qué motivo y bajo qué categoría OWASP. Eso convierte el
   código en su propia documentación de seguridad.

---

## 9. Conclusión

IDOR no se previene con una única salvaguarda — se previene con una
**arquitectura** donde:

- **Quién** se establece en una capa central (`JwtAuthGuard` + `JwtStrategy`).
- **Qué puede entrar** lo dicta `RolesGuard` con `@Roles` (RBAC declarativo).
- **Qué puede tocar específicamente** lo decide cada servicio mediante
  helpers de ownership que cruzan la identidad del solicitante con la
  propiedad del recurso (autorización imperativa por recurso).

Lo que mantiene este sistema robusto frente a IDOR no es ninguna línea de
código en concreto — es que las cuatro capas son **independientes** y
**redundantes**, y cuando se añade un módulo nuevo se sigue el mismo patrón.
La defensa contra IDOR está cocida en la forma de programar, no en una
biblioteca instalada.
