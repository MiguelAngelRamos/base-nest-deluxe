# Docker — Comandos de referencia (Clinic API)

Referencia rápida para construir la imagen y gestionar el contenedor de `clinic-api`.
Basado en el `Dockerfile` multi-stage (deps → builder → runner) del proyecto.

---

## 1. Construir la imagen

BuildKit es obligatorio para que los cache mounts de pnpm funcionen.

```powershell
$env:DOCKER_BUILDKIT = "1"

docker build -t clinic-api:latest .
```

Con tag de versión (recomendado en equipos):

```powershell
docker build -t clinic-api:1.0.0 -t clinic-api:latest .
```

---

## 2. Crear y correr el contenedor

### Mínimo — solo para probar

```powershell
docker run --rm -p 3000:3000 --env-file .env clinic-api:latest
```

### Hardening completo

```powershell
docker run --rm `
  -p 3000:3000 `
  --env-file .env `
  --read-only `
  --tmpfs /tmp `
  --cap-drop=ALL `
  --security-opt=no-new-privileges `
  --name clinic-api `
  clinic-api:latest
```

| Flag | Por qué |
|---|---|
| `--env-file .env` | Inyecta secretos sin meterlos en la imagen |
| `--read-only` | Sistema de archivos de solo lectura (FS inmutable) |
| `--tmpfs /tmp` | Node necesita `/tmp` escribible; se monta en RAM |
| `--cap-drop=ALL` | Elimina todos los Linux capabilities |
| `--security-opt=no-new-privileges` | Impide escalar privilegios vía setuid/setgid |
| `--name clinic-api` | Nombre fijo para poder referenciar el contenedor |

### En background (modo daemon)

Igual que el hardening completo, pero con `-d` para que el contenedor corra desprendido de la terminal:

```powershell
docker run --rm -d --name clinic-api `
  -p 3000:3000 `
  --env-file .env `
  --read-only --tmpfs /tmp `
  --cap-drop=ALL --security-opt=no-new-privileges `
  clinic-api:latest
```

| Flag añadido | Por qué |
|---|---|
| `-d` | Detached — devuelve el prompt enseguida; el contenedor sigue corriendo |

> Para ver qué hace usa `docker logs -f clinic-api` (sección 3).

---

## 3. Verificar que funciona

```powershell
# Logs en vivo
docker logs -f clinic-api

# Healthcheck manual al prefijo global de la API
curl http://localhost:3000/api/v1

# Estado del healthcheck definido en el Dockerfile
docker inspect --format='{{.State.Health.Status}}' clinic-api
```

---

## 4. Detener y limpiar

```powershell
# Graceful shutdown — dumb-init reenvía SIGTERM a Node
docker stop clinic-api

# Eliminar el contenedor (no borra la imagen)
docker rm clinic-api

# Eliminar la imagen
docker rmi clinic-api:latest
```

---

## 5. Sobreescribir ARGs en build

Los ARGs del Dockerfile tienen valores por defecto pero se pueden pisar en tiempo de build:

```powershell
docker build `
  --build-arg NODE_VERSION=24.0.0 `
  --build-arg PNPM_VERSION=10.0.0 `
  -t clinic-api:latest .
```

---

## 6. Inspección y depuración

```powershell
# Ver tamaño de cada capa
docker history clinic-api:latest

# Entrar al contenedor en ejecución (solo para depurar — Alpine trae sh)
docker exec -it clinic-api sh

# Ver todas las variables de entorno del contenedor
docker inspect --format='{{range .Config.Env}}{{println .}}{{end}}' clinic-api

# Ver el usuario con el que corre el proceso
docker exec clinic-api id
```

> El proceso debe correr como `uid=1000(node)`, nunca como `root`.
