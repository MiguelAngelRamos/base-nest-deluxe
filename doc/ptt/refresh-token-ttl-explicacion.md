# ¿Qué sentido tiene que el refresh token dure 7 días si se renueva cada 15 minutos?

## La clave: el TTL de 7 días NO es "cuánto dura en uso activo"

Es **"cuánto tiempo puedes estar completamente inactivo y volver sin hacer login"**.

---

## Escenario A — Usuario activo (sesión continua)

```
09:00 → Login → access token (exp: 09:15) + refresh token (exp: +7 días)
09:15 → Access token expira → /auth/refresh automático
         → nuevo access token (exp: 09:30) + nuevo refresh token (exp: +7 días RENOVADO)
09:30 → Access token expira → /auth/refresh automático
         → nuevo access token (exp: 09:45) + nuevo refresh token (exp: +7 días RENOVADO)
...
```

> El refresh token **nunca llega a sus 7 días** porque se renueva cada 15 min.
> El usuario puede estar logueado semanas sin hacer login de nuevo.

---

## Escenario B — Usuario que cierra el navegador y vuelve días después

```
Lunes 09:00     → Login → access token + refresh token (exp: Lunes + 7 días)
Lunes 09:15     → Cierra el navegador. Se va de vacaciones.

Miércoles 10:00 → Abre el navegador
                  El access token expiró hace días → /auth/refresh automático
                  El refresh token AÚN ES VÁLIDO (solo han pasado 2 días de 7)
                  → nuevo par emitido, sesión restaurada sin login
                  El usuario no tuvo que escribir su contraseña.

Lunes siguiente → Abre el navegador (8 días inactivo)
                  El refresh token expiró
                  → 401, debe hacer login
```

---

## El TTL de 7 días responde a esta pregunta

> **¿Cuánto tiempo puede un usuario estar completamente ausente y volver a encontrar su sesión activa?**

| TTL del refresh | Experiencia de usuario | Riesgo si es robado |
|---|---|---|
| 1 hora | Login frecuente | Ventana de ataque mínima |
| 7 días | Puedes ausentarte una semana y volver sin login | Ventana de 7 días si es robado |
| 30 días | Experiencia muy fluida (estilo Gmail) | Ventana de 30 días |
| Sin expiración | Nunca haces login de nuevo | Token robado válido para siempre |

---

## Rotación y TTL resuelven problemas distintos

| Mecanismo | Qué problema resuelve |
|---|---|
| **Rotación** (nuevo refresh en cada uso) | Detecta robo: si alguien usa tu refresh token, tú quedas bloqueado y viceversa. El token robado solo sirve una vez. |
| **TTL de 7 días** | Limita el daño si el token es robado y el ataque no es detectado por la rotación. Eventualmente expira solo. |

Son dos defensas independientes que se complementan:

- **Sin rotación** → un token robado dura 7 días en silencio.
- **Con rotación** → el primer uso del token robado activa la alarma.
- **El TTL** es el seguro de respaldo si la rotación no detecta el robo a tiempo.

---

## Resumen

El refresh token de 7 días **no es el tiempo entre renovaciones** —ese es de 15 minutos cuando el usuario está activo—. Es el **tiempo máximo de inactividad total** antes de que la sesión muera y el usuario deba autenticarse de nuevo.

Mientras el usuario use la app, el contador se reinicia en cada renovación y el timer de 7 días nunca llega a cero.
