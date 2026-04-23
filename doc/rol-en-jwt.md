# Por qué incluir el rol en el token JWT no es mala idea

La respuesta corta es: **el modelo de amenaza lo justifica**. Aquí los argumentos ordenados por peso:

---

## 1. El JWT está firmado, no solo codificado

El rol viaja en el payload del token, que está en Base64 pero está **criptográficamente firmado**. Un usuario puede leer el payload, pero no puede modificarlo sin invalidar la firma. Si alguien intenta cambiar `"role": "user"` por `"role": "admin"`, el servidor rechazará el token al verificarlo.

> El riesgo real no es que el rol esté visible — es que pueda ser alterado. La firma lo previene.

---

## 2. El vector de ataque real está cerrado por diseño

El argumento clásico contra roles en el token es: *"¿qué pasa si el usuario se asigna un rol privilegiado al registrarse?"*. En esta API ese vector **no existe** porque el registro no expone el campo `role` — es asignado exclusivamente por el sistema o por un administrador. El problema que justificaría sacar el rol del token simplemente no aplica aquí.

---

## 3. Mantiene la autenticación stateless

Si el rol no está en el token, cada request protegido necesita ir a la base de datos a buscar el rol del usuario. Eso:

- Rompe el modelo stateless de JWT
- Introduce latencia en cada petición
- Genera carga innecesaria en la base de datos

Con el rol en el token, el guard puede autorizar en memoria, sin I/O.

---

## 4. El costo real de un rol "stale" es bajo en este contexto

El único riesgo legítimo que queda es: *¿qué pasa si el rol cambia pero el token viejo sigue activo?*

Eso es manejable con:
- Tiempos de expiración cortos (ej. 15 min a 1 hora)
- Refresh tokens para renovar el access token
- O en casos extremos, una blocklist de tokens revocados

Pero ese es un trade-off conocido y aceptado del modelo JWT, no un fallo de diseño específico de poner el rol ahí.

---

## Resumen

| Situación | ¿Rol en token? |
|---|---|
| Usuarios pueden auto-asignarse roles | Peligroso |
| Roles cambian muy frecuentemente | Riesgoso sin revocación |
| **Roles los asigna solo el sistema/admin** | **Perfectamente válido** |
| Necesitas stateless + rendimiento | Recomendado |

El principio clave es: **el diseño de seguridad depende del modelo de amenaza, no de reglas absolutas**. En una API donde el control de roles es exclusivamente del lado del servidor, poner el rol en el token es una decisión pragmática y defendible.
