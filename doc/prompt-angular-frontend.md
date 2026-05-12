# Prompt: Angular Frontend — Clinic App (BASE-API-NEST-DELUXE)

> Copia este documento completo y pégalo como primer mensaje a Claude Code en el proyecto Angular.

---

## Contexto del proyecto

Vas a construir el frontend Angular de una **clínica médica** que consume una API NestJS ya implementada y endurecida en seguridad (OWASP Top 10). El backend usa JWT con access token en memoria + refresh token en cookie HttpOnly, RBAC con tres roles, validación estricta de DTOs y rate limiting por IP.

La app gestiona: autenticación, pacientes, médicos, especialidades y citas médicas.

---

## Stack y versiones

- **Angular**: última versión estable disponible (≥ 19). Si hay una versión candidata estable, úsala.
- **Node.js**: versión LTS actual.
- **Gestor de paquetes**: `pnpm` (si no está disponible, `npm`).
- **CSS**: Angular Material 3 (`@angular/material`) + utilidades de `@angular/cdk`.
- **Iconos**: Material Symbols (`mat-icon`).
- **HTTP**: `HttpClient` con interceptores funcionales.
- **Estado/Reactividad**: Signals de Angular (no NgRx, no BehaviorSubject como estado primario).
- **Formularios**: **Formularios reactivos** (`ReactiveFormsModule`) — ver sección "Por qué reactivos".
- **Testing**: Vitest + Angular Testing Library (si está disponible), o Jest como alternativa.
- **Linting**: ESLint con `@angular-eslint`.
- **Tipado**: TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess: true`).

---

## Por qué formularios reactivos (no template-driven)

Usa **exclusivamente `ReactiveFormsModule`** en toda la app.

| Criterio | Reactivos | Template-driven |
|---|---|---|
| Validación programática | ✅ Full control | ❌ Solo directivas |
| Reglas dinámicas (si rol = X, campo Y requerido) | ✅ Trivial | ❌ Complejo |
| Test unitario sin DOM | ✅ Sí | ❌ No |
| Integración con signals (`toSignal`) | ✅ Natural | ❌ Difícil |
| Cross-field validation (confirmPassword, hora inicio < fin) | ✅ Validators compuestos | ❌ Workarounds |
| Prevención de manipulación del modelo desde la plantilla | ✅ Modelo es la fuente de verdad | ❌ Two-way binding en DOM |

Los formularios reactivos son el estándar para apps de producción con reglas de negocio complejas. Los template-driven son adecuados solo para formularios triviales de 1-2 campos.

---

## Arquitectura y patrones Angular modernos (≥ 19)

### Estructura de proyecto

```
src/
├── app/
│   ├── core/                        # Servicios singleton, interceptores, guards
│   │   ├── auth/
│   │   │   ├── auth.service.ts      # Señales de estado + lógica auth
│   │   │   ├── auth.guard.ts        # Guard funcional
│   │   │   └── auth.interceptor.ts  # Interceptor funcional (Bearer + 401 retry)
│   │   ├── http/
│   │   │   └── error.interceptor.ts # Interceptor global de errores
│   │   └── models/                  # Interfaces TS para toda la app
│   ├── features/
│   │   ├── auth/                    # Login, Register
│   │   ├── dashboard/               # Home post-login
│   │   ├── patients/                # CRUD pacientes
│   │   ├── doctors/                 # CRUD médicos
│   │   ├── specialties/             # CRUD especialidades
│   │   └── appointments/            # CRUD citas
│   ├── shared/
│   │   ├── components/              # Componentes reutilizables (toast, confirm-dialog, etc.)
│   │   └── validators/              # Validadores personalizados (passwordStrength, timeRange, etc.)
│   ├── app.config.ts                # provideRouter, provideHttpClient, provideAnimations
│   └── app.routes.ts                # Rutas lazy con loadComponent
```

### Reglas de arquitectura

1. **Standalone components en todos lados** — no usar `NgModule` en ningún archivo nuevo.
2. **`inject()`** en lugar de constructor injection en todos los servicios y componentes.
3. **Control flow moderno** — usar `@if`, `@for`, `@switch`, `@defer` en plantillas. No usar `*ngIf`, `*ngFor`, `*ngSwitch`.
4. **Signals como estado primario**:
   - `signal()` para estado local mutable.
   - `computed()` para valores derivados.
   - `effect()` solo cuando haya side effects reales (logging, storage).
   - `toSignal()` para convertir Observables a signals.
   - `input()` en lugar de `@Input()`.
   - `output()` en lugar de `@Output()`.
   - `viewChild()` / `contentChild()` en lugar de `@ViewChild()` / `@ContentChild()`.
5. **Lazy loading** por feature con `loadComponent` y `loadChildren`.
6. **Smart/dumb components**: Los componentes de feature son smart (acceden a servicios), los de `shared/` son dumb (solo inputs/outputs).
7. **`takeUntilDestroyed()`** para limpiar subscripciones (`DestroyRef`).

---

## Modelos TypeScript (alineados con la API)

Crea en `src/app/core/models/` los siguientes tipos. Son contratos estrictos con la API:

```typescript
// auth.models.ts
export type UserRole = 'admin' | 'doctor' | 'patient';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

// api-error.model.ts
export interface ApiError {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

// patient.models.ts
export type Gender = 'male' | 'female' | 'other';

export interface Patient {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  birthDate: string | null;   // YYYY-MM-DD
  gender: Gender | null;
  phone: string | null;
  address: string | null;
  createdAt: string;
  updatedAt: string;
}

// doctor.models.ts
export interface Doctor {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  licenseNumber: string;
  phone: string | null;
  specialties: Specialty[];
  createdAt: string;
  updatedAt: string;
}

// specialty.models.ts
export interface Specialty {
  id: string;
  name: string;
  description: string | null;
}

// appointment.models.ts
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  date: string;            // YYYY-MM-DD
  startTime: string;       // HH:MM
  endTime: string;         // HH:MM
  status: AppointmentStatus;
  notes: string | null;
  patient?: Patient;
  doctor?: Doctor;
  createdAt: string;
  updatedAt: string;
}

// user.models.ts (solo admin)
export interface User {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

---

## Servicio de autenticación (`AuthService`)

El `AuthService` es el núcleo de seguridad. Implementa con signals:

```typescript
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  // Estado reactivo (NUNCA exponer el signal directamente como writable)
  private readonly _accessToken = signal<string | null>(null);
  private readonly _currentUser = signal<AuthUser | null>(null);

  // Lectura pública (readonly)
  readonly accessToken = this._accessToken.asReadonly();
  readonly currentUser = this._currentUser.asReadonly();
  readonly isAuthenticated = computed(() => this._accessToken() !== null);
  readonly userRole = computed(() => this._currentUser()?.role ?? null);
  readonly isAdmin = computed(() => this._currentUser()?.role === 'admin');
  readonly isDoctor = computed(() => this._currentUser()?.role === 'doctor');
  readonly isPatient = computed(() => this._currentUser()?.role === 'patient');

  // Métodos: login, register, refresh, logout
  // Ver implementación completa abajo
}
```

**Reglas de implementación:**

- El `accessToken` se guarda **solo en memoria** (campo de clase/signal). Jamás en `localStorage`, `sessionStorage` o cookie.
- El `refresh_token` es una **cookie HttpOnly gestionada exclusivamente por el navegador**. Nunca leerla ni escribirla desde JS.
- La llamada a `/auth/refresh` incluye `{ withCredentials: true }`.
- Toda petición autenticada incluye `Authorization: Bearer <token>` vía interceptor.
- Al hacer logout: POST `/auth/logout` (con el Bearer token actual) → limpiar signals → navegar a `/login`.

---

## Interceptor de autenticación (funcional)

```typescript
// core/auth/auth.interceptor.ts
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.accessToken();

  const authReq = token
    ? req.clone({
        setHeaders: { Authorization: `Bearer ${token}` },
        withCredentials: true,
      })
    : req.clone({ withCredentials: true });

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401 && !req.url.includes('/auth/')) {
        return authService.refresh().pipe(
          switchMap(() => {
            const newToken = authService.accessToken();
            const retryReq = req.clone({
              setHeaders: { Authorization: `Bearer ${newToken}` },
              withCredentials: true,
            });
            return next(retryReq);
          }),
          catchError(() => {
            authService.logout();
            return throwError(() => error);
          })
        );
      }
      return throwError(() => error);
    })
  );
};
```

**Registrar en `app.config.ts`:**

```typescript
export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),
    provideAnimationsAsync(),
  ],
};
```

---

## Guards funcionales

```typescript
// core/auth/auth.guard.ts
export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) return true;

  // Intentar refresh antes de redirigir
  return authService.refresh().pipe(
    map(() => true),
    catchError(() => {
      router.navigate(['/login']);
      return of(false);
    })
  );
};

// core/auth/roles.guard.ts
export const rolesGuard = (allowedRoles: UserRole[]): CanActivateFn => () => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const role = authService.userRole();

  if (role && allowedRoles.includes(role)) return true;

  router.navigate(['/403']);
  return false;
};
```

**Rutas ejemplo:**

```typescript
export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/auth/login/login.component') },
  { path: 'register', loadComponent: () => import('./features/auth/register/register.component') },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/dashboard/dashboard.component'),
    children: [
      { path: 'patients', loadChildren: () => import('./features/patients/patients.routes') },
      { path: 'doctors', loadChildren: () => import('./features/doctors/doctors.routes') },
      {
        path: 'users',
        canActivate: [rolesGuard(['admin'])],
        loadChildren: () => import('./features/users/users.routes'),
      },
      { path: 'appointments', loadChildren: () => import('./features/appointments/appointments.routes') },
      { path: 'specialties', loadChildren: () => import('./features/specialties/specialties.routes') },
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
    ],
  },
  { path: '403', loadComponent: () => import('./shared/components/forbidden/forbidden.component') },
  { path: '**', loadComponent: () => import('./shared/components/not-found/not-found.component') },
];
```

---

## Formularios reactivos: implementación segura

### Validadores personalizados (`src/app/shared/validators/`)

```typescript
// password-strength.validator.ts
export function passwordStrengthValidator(): ValidatorFn {
  return (control): ValidationErrors | null => {
    const value: string = control.value ?? '';
    const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return regex.test(value) ? null : { passwordStrength: true };
  };
}

// passwords-match.validator.ts
export function passwordsMatchValidator(
  passwordKey: string,
  confirmKey: string
): ValidatorFn {
  return (group): ValidationErrors | null => {
    const pass = group.get(passwordKey)?.value;
    const confirm = group.get(confirmKey)?.value;
    return pass === confirm ? null : { passwordsMismatch: true };
  };
}

// time-range.validator.ts — startTime < endTime
export function timeRangeValidator(
  startKey: string,
  endKey: string
): ValidatorFn {
  return (group): ValidationErrors | null => {
    const start: string = group.get(startKey)?.value ?? '';
    const end: string = group.get(endKey)?.value ?? '';
    if (!start || !end) return null;
    return start < end ? null : { invalidTimeRange: true };
  };
}
```

### Formulario de login (ejemplo completo)

```typescript
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly isLoading = signal(false);
  protected readonly apiError = signal<string | null>(null);
  protected readonly showPassword = signal(false);

  protected readonly form = this.fb.group({
    email: this.fb.control('', [Validators.required, Validators.email]),
    password: this.fb.control('', [Validators.required, Validators.minLength(8)]),
  });

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.isLoading.set(true);
    this.apiError.set(null);

    const { email, password } = this.form.getRawValue();

    this.authService.login(email, password).subscribe({
      next: () => this.router.navigate(['/']),
      error: (err: HttpErrorResponse) => {
        this.apiError.set(this.extractErrorMessage(err));
        this.isLoading.set(false);
      },
    });
  }

  private extractErrorMessage(err: HttpErrorResponse): string {
    const body = err.error as ApiError;
    if (!body?.message) return 'Error inesperado. Intente nuevamente.';
    return Array.isArray(body.message) ? body.message.join(' ') : body.message;
  }
}
```

**Plantilla del formulario (usar control flow moderno):**

```html
<form [formGroup]="form" (ngSubmit)="submit()">
  <mat-form-field>
    <mat-label>Correo electrónico</mat-label>
    <input matInput formControlName="email" type="email" autocomplete="email" />
    @if (form.controls.email.errors?.['required'] && form.controls.email.touched) {
      <mat-error>El correo es requerido</mat-error>
    }
    @if (form.controls.email.errors?.['email'] && form.controls.email.touched) {
      <mat-error>Formato de correo inválido</mat-error>
    }
  </mat-form-field>

  <mat-form-field>
    <mat-label>Contraseña</mat-label>
    <input matInput formControlName="password"
           [type]="showPassword() ? 'text' : 'password'"
           autocomplete="current-password" />
    <button mat-icon-button matSuffix type="button" (click)="showPassword.update(v => !v)">
      <mat-icon>{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
    </button>
  </mat-form-field>

  @if (apiError()) {
    <mat-error class="api-error">{{ apiError() }}</mat-error>
  }

  <button mat-flat-button color="primary" type="submit" [disabled]="isLoading()">
    @if (isLoading()) { Ingresando... } @else { Ingresar }
  </button>
</form>
```

---

## Servicios de recurso (patrón con signals)

Cada feature tiene un servicio que expone signals en lugar de Observables crudos:

```typescript
@Injectable({ providedIn: 'root' })
export class PatientsService {
  private readonly http = inject(HttpClient);
  private readonly BASE = '/api/v1/patients';

  private readonly _patients = signal<Patient[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly patients = this._patients.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  loadAll(): void {
    this._loading.set(true);
    this.http.get<Patient[]>(this.BASE).pipe(
      takeUntilDestroyed(),
    ).subscribe({
      next: data => { this._patients.set(data); this._loading.set(false); },
      error: err => { this._error.set(this.parseError(err)); this._loading.set(false); },
    });
  }

  create(dto: Omit<Patient, 'id' | 'createdAt' | 'updatedAt'>): Observable<Patient> {
    return this.http.post<Patient>(this.BASE, dto).pipe(
      tap(p => this._patients.update(list => [...list, p]))
    );
  }

  update(id: string, dto: Partial<Patient>): Observable<Patient> {
    return this.http.patch<Patient>(`${this.BASE}/${id}`, dto).pipe(
      tap(updated => this._patients.update(list => list.map(p => p.id === id ? updated : p)))
    );
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${this.BASE}/${id}`).pipe(
      tap(() => this._patients.update(list => list.filter(p => p.id !== id)))
    );
  }

  private parseError(err: HttpErrorResponse): string {
    const body = err.error as ApiError;
    if (!body?.message) return 'Error inesperado';
    return Array.isArray(body.message) ? body.message.join(' ') : body.message;
  }
}
```

---

## Endpoints de la API

### Base URL

```typescript
// environment.ts
export const environment = {
  production: false,
  apiUrl: 'http://localhost:3000/api/v1',
};
```

Configura un interceptor base URL o usa `provideHttpClient` con un `baseUrl` provider.

### Mapa completo de endpoints

| Módulo | Método | Ruta | Auth requerida | Rol |
|---|---|---|---|---|
| **Auth** | POST | `/auth/register` | No | — |
| | POST | `/auth/login` | No | — |
| | POST | `/auth/refresh` | Cookie | — |
| | POST | `/auth/logout` | Bearer | Cualquier rol |
| **Users** | GET | `/users` | Bearer | admin |
| | GET | `/users/:id` | Bearer | admin |
| | POST | `/users` | Bearer | admin |
| | PATCH | `/users/:id` | Bearer | admin |
| | DELETE | `/users/:id` | Bearer | admin |
| **Patients** | GET | `/patients` | Bearer | admin |
| | GET | `/patients/:id` | Bearer | Dueño o admin |
| | GET | `/patients/user/:userId` | Bearer | Dueño |
| | POST | `/patients` | Bearer | Cualquier rol |
| | PATCH | `/patients/:id` | Bearer | Dueño |
| | DELETE | `/patients/:id` | Bearer | admin |
| **Doctors** | GET | `/doctors` | Bearer | Cualquier rol |
| | GET | `/doctors/:id` | Bearer | Cualquier rol |
| | GET | `/doctors/specialty/:id` | Bearer | Cualquier rol |
| | POST | `/doctors` | Bearer | admin |
| | PATCH | `/doctors/:id` | Bearer | admin |
| | POST | `/doctors/:id/specialties/:sid` | Bearer | admin |
| | DELETE | `/doctors/:id/specialties/:sid` | Bearer | admin |
| | DELETE | `/doctors/:id` | Bearer | admin |
| **Specialties** | GET | `/specialties` | Bearer | Cualquier rol |
| | GET | `/specialties/:id` | Bearer | Cualquier rol |
| | POST | `/specialties` | Bearer | admin |
| | PATCH | `/specialties/:id` | Bearer | admin |
| | DELETE | `/specialties/:id` | Bearer | admin |
| **Appointments** | GET | `/appointments` | Bearer | admin |
| | GET | `/appointments/:id` | Bearer | Dueño o admin |
| | GET | `/appointments/patient/:id` | Bearer | Dueño |
| | GET | `/appointments/doctor/:id` | Bearer | Doctor dueño o admin |
| | GET | `/appointments/date/:date` | Bearer | admin |
| | POST | `/appointments` | Bearer | Cualquier rol |
| | PATCH | `/appointments/:id` | Bearer | Dueño |
| | PATCH | `/appointments/:id/status` | Bearer | Dueño |
| | DELETE | `/appointments/:id` | Bearer | Dueño |

### Formato de error de la API

```typescript
// Todos los errores tienen esta forma:
{
  statusCode: 400 | 401 | 403 | 404 | 409 | 500,
  message: string | string[],   // string[] para errores de validación
  error: string,
  timestamp: string,
  path: string,
}
```

---

## Checklist de seguridad frontend

### Almacenamiento de tokens
- [ ] `accessToken` solo en memoria (signal/variable de clase en `AuthService`).
- [ ] Jamás `localStorage.setItem('token', ...)` ni `sessionStorage`.
- [ ] `refresh_token` es HttpOnly — nunca intentar leerlo con `document.cookie`.
- [ ] Toda petición HTTP incluye `withCredentials: true` (para la cookie).

### Autenticación y sesión
- [ ] Interceptor captura 401 → intenta refresh → reintenta la petición original → si falla, logout.
- [ ] Logout llama POST `/auth/logout` con el Bearer token antes de limpiar el estado local.
- [ ] Al refrescar la página, intentar GET `/auth/refresh` antes de redirigir a login.
- [ ] Guards funcionales en todas las rutas protegidas.

### Formularios
- [ ] Usar `NonNullableFormBuilder` para evitar tipos `T | null` innecesarios.
- [ ] `form.markAllAsTouched()` antes de mostrar errores (no mostrar errores en campos no tocados).
- [ ] No mostrar mensajes que expongan información interna del servidor.
- [ ] Validar contraseña con el mismo regex que el backend antes de enviar.
- [ ] `autocomplete="off"` solo en campos donde sea necesario (no abusar — el autocompletar es accesibilidad).
- [ ] Deshabilitar el botón submit durante `isLoading` para prevenir doble envío.

### Autorización en UI
- [ ] Ocultar/deshabilitar elementos de UI según `userRole` (signal `isAdmin`, `isDoctor`, `isPatient`).
- [ ] Nunca omitir el guard del router: la UI es solo UX, el guard es seguridad.
- [ ] Redirigir a `/403` si el backend devuelve 403 (no silenciar).

### XSS
- [ ] No usar `[innerHTML]` con datos del servidor sin sanitizar.
- [ ] Angular sanitiza automáticamente interpolación `{{ }}` y bindings `[property]`.
- [ ] Si hay contenido rich text, usar `DomSanitizer.sanitize(SecurityContext.HTML, value)`.

### CSRF
- [ ] La cookie `refresh_token` usa `SameSite: Strict` — el backend ya protege contra CSRF.
- [ ] No implementar tokens CSRF adicionales (el backend no los requiere).

### Variables de entorno
- [ ] `environment.ts` para dev, `environment.prod.ts` para producción.
- [ ] Nunca hardcodear secretos en el frontend (el frontend no tiene secretos).
- [ ] La URL de la API viene de `environment.apiUrl`.

---

## UX y accesibilidad

- Usar `mat-snack-bar` para notificaciones de éxito/error globales.
- Componente `<app-spinner>` reutilizable que reacciona al signal `loading`.
- Diálogo de confirmación antes de DELETE con `MatDialog`.
- Skeleton loaders en tablas con `@defer` + `@placeholder`.
- Todos los formularios con `aria-label` o `<label>` asociado.
- Mensajes de error con `role="alert"` para screen readers.
- Contraste mínimo AA (Angular Material 3 lo cumple por defecto con temas bien configurados).

---

## Configuración del proyecto

### `app.config.ts`

```typescript
import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withViewTransitions } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { errorInterceptor } from './core/http/error.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    provideAnimationsAsync(),
  ],
};
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "strictTemplates": true,
    "useDefineForClassFields": false
  }
}
```

### Proxy de desarrollo (`proxy.conf.json`)

```json
{
  "/api": {
    "target": "http://localhost:3000",
    "secure": false,
    "changeOrigin": true,
    "logLevel": "debug"
  }
}
```

```json
// angular.json — en serve → options
{
  "proxyConfig": "proxy.conf.json"
}
```

Con el proxy, las peticiones Angular usan rutas relativas (`/api/v1/...`) y el proxy las redirige al backend en `:3000`. No hay problema de CORS en desarrollo.

---

## Reglas generales de implementación

1. Nada de `any` — tipado estricto en todos los servicios, componentes y plantillas.
2. Nada de `as unknown as X` — si hace falta un cast, el modelo de datos está mal.
3. Nada de comentarios que expliquen el código — los nombres bien elegidos son suficientes.
4. Un archivo por componente/servicio/guard — no agrupar clases en el mismo archivo.
5. Nada de `NgModule` — todo standalone.
6. Nada de Observables expuestos en plantillas sin `async` pipe o `toSignal()`.
7. Nada de `console.log` en producción — usar un servicio de logger que respete `environment.production`.
8. Componentes de lista usan `trackBy` (o `track` con el nuevo `@for`).
9. Errores HTTP siempre manejados (nunca silenciados con catch vacío).
10. Verificar con `ng build --configuration production` antes de declarar listo.

---

## Flujo de arranque recomendado

```
1. ng new clinic-frontend --standalone --routing --style=scss
2. ng add @angular/material
3. Crear estructura de carpetas: core/, features/, shared/
4. Implementar AuthService con signals
5. Implementar authInterceptor + errorInterceptor
6. Implementar authGuard + rolesGuard
7. Implementar feature auth (login + register) con formularios reactivos
8. Verificar flujo completo: login → refresh → logout
9. Implementar features por módulo: patients → doctors → specialties → appointments
10. Implementar dashboard con control de acceso por rol
11. Tests de servicios (lógica) y guards
12. ng build --configuration production → 0 errores
```

---

*Este prompt es específico para la API de `BASE-API-NEST-DELUXE`. El backend está corriendo en `http://localhost:3000` por defecto.*
