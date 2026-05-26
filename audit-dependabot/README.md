# Auditoría de Dependabot — clinic-api

> Fecha del informe: **2026-05-26**
> Repositorio: `MiguelAngelRamos/base-nest-deluxe`
> Fuente: `gh api repos/.../dependabot/alerts`
> Panel oficial: <https://github.com/MiguelAngelRamos/base-nest-deluxe/security/dependabot>

Este documento describe las **4 vulnerabilidades** abiertas que Dependabot ha detectado en el árbol de dependencias del proyecto. Ninguna afecta a código que escribimos nosotros — todas vienen de paquetes transitivos.

## Resumen ejecutivo

| # | Paquete | Severidad | Scope | Versión actual | Versión parchada | CVE |
|---|---------|-----------|-------|----------------|------------------|------|
| 1 | `fast-uri` | 🔴 **High** | dev | 3.1.0 | 3.1.1 | CVE-2026-6321 |
| 2 | `fast-uri` | 🔴 **High** | dev | 3.1.0 | 3.1.2 | CVE-2026-6322 |
| 4 | `uuid` | 🟡 Moderate | runtime | 11.1.0 | 11.1.1 | CVE-2026-41907 |
| 5 | `qs` | 🟡 Moderate | runtime | 6.15.1 | 6.15.2 | CVE-2026-8723 |

### ¿Por qué el CI no las ve?

El job `sca-audit` del pipeline corre `pnpm audit --prod` y solo retorna `high+critical` en **dependencias de producción**. Por eso:

- ✅ Las **2 high de fast-uri** están en **devDependencies** → fuera del scope del audit del CI (correcto, no llegan a producción).
- ✅ Las **2 moderate de uuid y qs** están en runtime, pero el threshold del CI es `high+critical` → pasan sin bloquear.

Dependabot, en cambio, escanea **todo el árbol** (dev + prod) y reporta cualquier severidad. Por eso ve 4 mientras `pnpm audit --prod` ve 2.

## Detalle por vulnerabilidad

### 🔴 #1 y #2 — `fast-uri` (High, devDependencies)

**Qué es `fast-uri`:** parser de URIs usado por `ajv` (validador JSON Schema). Llega al proyecto como dependencia transitiva del CLI y del build:

```
fast-uri@3.1.0
└─ ajv@8.18.0
   ├─ @angular-devkit/core ← @nestjs/cli (devDep)
   └─ schema-utils ← webpack ← ts-loader (devDep)
```

**Vulnerabilidad #1 — CVE-2026-6321 (path traversal):**
Permite traversal de paths mediante segmentos `..` codificados como `%2E%2E`. Un atacante que controle URIs de entrada al parser podría salir del directorio esperado.

**Vulnerabilidad #2 — CVE-2026-6322 (host confusion):**
Permite confundir el host de una URI mediante delimitadores de autoridad (`@`, `:`) codificados como porcentaje. Útil para bypasses de allowlists basadas en host.

**Riesgo real en este proyecto:** **bajo**. `fast-uri` solo se ejecuta en tiempo de **build local y CI** (resolviendo schemas de Angular DevKit, schemas de webpack/ts-loader). No corre en el contenedor de producción — el `Dockerfile` hace multi-stage y la imagen final solo contiene `dist/` + `node_modules` de producción, sin `@nestjs/cli` ni `ts-loader`.

**Acción:** `pnpm.overrides` en `package.json` para forzar `fast-uri@>=3.1.2`. Ver [remediacion.md](remediacion.md).

---

### 🟡 #4 — `uuid` (Moderate, runtime)

**Qué es `uuid`:** librería de generación de UUIDs. Llega al proyecto vía:

```
uuid@11.1.0
└─ typeorm@0.3.28 (dependencia directa de clinic-api)
```

**Vulnerabilidad — CVE-2026-41907 (missing buffer bounds check):**
Las funciones `v3`, `v5`, `v6` aceptan un parámetro opcional `buf` (Buffer destino) sin verificar que tenga al menos 16 bytes de capacidad. Pasar un Buffer pequeño causa una escritura fuera de límites — potencial memory corruption en Node.js nativo.

**Riesgo real en este proyecto:** **mínimo**. El código del proyecto **no llama a uuid directamente con un Buffer personalizado**. TypeORM internamente solo usa `uuid.v4()` (que no tiene esta vulnerabilidad). El gadget solo se activa cuando llamas `uuid.v3(name, namespace, buf)` con un `buf` no validado y atacante-controlado.

**Acción:** `pnpm.overrides` para forzar `uuid@>=11.1.1`. TypeORM 0.3.28 admite uuid 8.x–11.x → la sobreescritura es segura sin tocar `typeorm`.

---

### 🟡 #5 — `qs` (Moderate, runtime)

**Qué es `qs`:** parser/stringifier de query strings. Llega al proyecto vía:

```
qs@6.15.1
└─ body-parser@2.2.2
   └─ express@5.2.1
      └─ @nestjs/platform-express@11.1.19
```

**Vulnerabilidad — CVE-2026-8723 (DoS en stringify):**
`qs.stringify` lanza `TypeError` no controlada cuando recibe `null`/`undefined` en arrays con `arrayFormat: 'comma'` y `encodeValuesOnly: true`. Un atacante que controle la construcción de query strings puede tirar el proceso.

**Riesgo real en este proyecto:** **bajo**. La API solo usa `qs` indirectamente vía Express para **parsear** query strings entrantes, no para `stringify`. El gadget vulnerable es la salida, no la entrada. Para explotar haría falta que el código del proyecto invocara `qs.stringify` con datos atacante-controlados — cosa que no hace.

**Acción:** `pnpm.overrides` para forzar `qs@>=6.15.2`. Express 5.2.1 acepta qs 6.x → seguro.

## Cómo verificar el estado

```powershell
# Ver todas las alertas abiertas
gh api repos/MiguelAngelRamos/base-nest-deluxe/dependabot/alerts `
  --jq '.[] | select(.state == "open") | {n: .number, sev: .security_advisory.severity, pkg: .dependency.package.name, scope: .dependency.scope}'

# Reproducir el audit que corre el CI (solo prod, high+)
pnpm audit --prod

# Ver el árbol que trae un paquete vulnerable
pnpm why fast-uri
pnpm why qs
pnpm why uuid
```

## Próximos pasos

1. Aplicar `pnpm.overrides` según [remediacion.md](remediacion.md).
2. Re-ejecutar `pnpm install --no-frozen-lockfile` (genera nuevo lockfile con las versiones forzadas).
3. Verificar que `pnpm audit --prod` siga retornando exit 0.
4. Verificar que Dependabot cierre las 4 alertas (puede tardar unos minutos en re-escanear tras el push).
5. Commit con el nuevo `package.json` y `pnpm-lock.yaml`.
