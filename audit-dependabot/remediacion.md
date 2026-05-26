# Plan de remediación — alertas de Dependabot

> Documento operativo. Ver [README.md](README.md) para el contexto de cada vulnerabilidad.

## Estrategia general

Las 4 alertas son **dependencias transitivas** — no podemos actualizar el paquete vulnerable directamente porque está varios niveles de profundidad. La estrategia correcta con pnpm es usar el campo `pnpm.overrides` en `package.json`, que **fuerza** una versión específica de un paquete sin importar quién lo pida.

> **Importante:** `overrides` puede romper compatibilidad si el paquete intermedio depende de una API específica de la versión vulnerable. En estos 3 casos los bumps son **patch versions** (3.1.0 → 3.1.2, 11.1.0 → 11.1.1, 6.15.1 → 6.15.2) — semánticamente sin breaking changes.

## Cambio concreto en `package.json`

Añadir o extender el bloque `pnpm.overrides` (justo después del bloque `pnpm.onlyBuiltDependencies` que ya existe):

```json
{
  "pnpm": {
    "onlyBuiltDependencies": [
      "argon2"
    ],
    "overrides": {
      "fast-uri@<3.1.2": ">=3.1.2",
      "uuid@<11.1.1": ">=11.1.1",
      "qs@<6.15.2": ">=6.15.2"
    }
  }
}
```

### Por qué la sintaxis `paquete@<X.Y.Z`

Solo aplica la sobreescritura a versiones vulnerables. Si una dependencia ya pide una versión parchada, pnpm no la fuerza. Esto evita romper algo más adelante cuando upstream actualice por su cuenta.

## Pasos para aplicar

```powershell
# 1. Editar package.json con el bloque de overrides arriba (manual o con tu editor).

# 2. Regenerar el lockfile con las nuevas resoluciones.
#    NO usar --frozen-lockfile aquí — necesitamos que el lockfile cambie.
pnpm install

# 3. Verificar que las versiones ahora son las parchadas.
pnpm why fast-uri   # debe mostrar 3.1.2
pnpm why uuid       # debe mostrar 11.1.1
pnpm why qs         # debe mostrar 6.15.2

# 4. Volver a correr el audit local.
pnpm audit --prod

# 5. Correr tests para asegurarnos de que no rompió nada.
pnpm exec jest --ci
pnpm exec eslint "{src,apps,libs,test}/**/*.ts"
```

## Verificación posterior al push

```powershell
# Ver alertas abiertas tras el merge a main (puede tardar 1-2 min en re-escanear).
gh api repos/MiguelAngelRamos/base-nest-deluxe/dependabot/alerts `
  --jq '.[] | select(.state == "open") | {n: .number, pkg: .dependency.package.name}'
```

El resultado esperado es una lista vacía (o solo nuevas alertas que aparezcan después).

Las 4 alertas actuales deberían pasar a `state: fixed` automáticamente cuando Dependabot vea que las versiones del lockfile son ≥ patched.

## Mensaje de commit sugerido

```
chore(security): pin patched versions of fast-uri, uuid, qs via pnpm overrides

Resuelve las 4 alertas de Dependabot:
- fast-uri 3.1.0 → 3.1.2  (CVE-2026-6321, CVE-2026-6322 — high, devDep)
- uuid     11.1.0 → 11.1.1 (CVE-2026-41907 — moderate, transitive de typeorm)
- qs       6.15.1 → 6.15.2 (CVE-2026-8723 — moderate, transitive de express)

Todas son patch versions sin breaking changes esperados.
```

## Si algo sale mal

### `pnpm install` falla con un peer dep error

Algunos paquetes intermedios podrían quejarse si las versiones nuevas cambian peer dependencies. En ese caso, mira el error concreto y:

- Si es un warning informativo → ignorar, seguir adelante.
- Si es un error real → relajar el override a la versión más cercana al rango original (ej: `fast-uri@<3.1.2` → `>=3.1.2 <3.2`).

### Algún test falla después del bump

Si `uuid@11.1.1` introdujo algo que rompe TypeORM (poco probable, es patch), revisar el changelog:

- <https://github.com/uuidjs/uuid/blob/main/CHANGELOG.md>

Si efectivamente hay incompatibilidad, abrir un issue upstream a TypeORM y considerar pinear `uuid@11.1.1` exacto en lugar de `>=11.1.1`.

### Dependabot sigue mostrando las alertas tras 10 minutos

- Forzar un re-scan: ir a `Settings → Security & analysis → Dependabot → Refresh` (si la opción existe), o simplemente esperar al próximo escaneo programado (típicamente cada 24h, pero los pushes lo aceleran).
- Alternativa manual: cerrar las alertas en la UI marcando "Resolved" con justificación "Fix released" si confirmamos que la versión del lockfile es la parchada.
