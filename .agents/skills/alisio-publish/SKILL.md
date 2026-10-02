---
name: alisio-publish
description: "Publicar versiones npm de Alisio: bump manual alpha, commit, publish con pnpm run publish, verificación y errores comunes. Trigger: publicación, release, bump, nueva versión npm."
---

# Alisio npm publishing workflow

Flujo canónico para publicar paquetes de Alisio en npm (org `@alisio`). **Sin rutas
absolutas del usuario**: usa la raíz del checkout como `<REPO>` (el orquestador la completa
en las instrucciones).

## Reglas de oro

1. **NUNCA `npm publish` directo** en este monorepo: rompe el protocolo `workspace:*` y
   filtra exports de desarrollo en el tarball. Solo `pnpm run publish` (empaqueta con pnpm,
   reescribe `workspace:` y aplica `publishConfig.exports`).
2. **`package@version` es inmutable en npm**: si un publish falla a medias, no reintentes la
   misma versión — bumpea a la siguiente.
3. **Los publishes de npm son asíncronos**: "Your package is being processed…" es normal;
   verifica el tarball con HTTP 200, no solo la metadata (espera 1-5 min y reintenta).
4. **OTP/tokens**: npm exige OTP por paquete (2FA `auth-and-writes`). El operador escribe el
   OTP; nunca se pega en el chat.
5. **Propagación del dist-tag**: tras publicar, `latest` puede tardar en actualizarse; usa
   `--prefer-online` en instalaciones para saltar la caché local.

## Flujo estándar

```bash
cd <REPO>
git status --short          # confirmar árbol limpio o cambios intencionales
```

### 0. CHANGELOG (antes del bump)

`CHANGELOG.md` (raíz) es la fuente de `/changelog` en la TUI y la web. Solo entran cambios
**visibles para el usuario** (nada de refactors, tests ni docs internas), cortos y en inglés.

```bash
cd <REPO>
# 1. Renombra "## [Unreleased]" a "## [<versión del CLI>] - <AAAA-MM-DD>" y deja un nuevo
#    "## [Unreleased]" vacío arriba. La versión es la del paquete `cli` (la que verá el usuario).
# 2. Regenera los datos embebidos (módulo TS que viaja dentro de dist; lo comprueba un test):
pnpm changelog:data
git add CHANGELOG.md packages/core/src/changelog/data.ts
```

Sin entrada para la versión del CLI, `/changelog` muestra `Unreleased` y la línea de novedades
tras actualizar no aparece. `pnpm build` también regenera los datos.

### 1. Bump manual de versiones (alpha)

Identifica los paquetes afectados (sdk, core, cli, plugins) y sube cada uno en la cadena alpha:

```bash
python3 - <<'PY'
import json
bumps = {
    "packages/sdk/package.json": "0.1.0-alpha.N+1",
    "packages/core/package.json": "0.1.0-alpha.N+1",
    "packages/plugin-memory/package.json": "0.1.0-alpha.N+1",
    "packages/plugin-subagents/package.json": "0.1.0-alpha.N+1",
    "packages/cli/package.json": "0.1.0-alpha.N+1",
}
for path, ver in bumps.items():
    d = json.load(open(path))
    d["version"] = ver
    open(path, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
pnpm pack:check 2>&1 | tail -9   # tarballs limpios (el changelog viaja como dist/*.js)
pnpm typecheck 2>&1 | tail -1
```

### 2. Commit y push

```bash
git add -A
git diff --cached --check
git commit -m "chore: bump <pkg> to alpha.X"
git push origin main
```

Antes del commit, escaneo de secretos (rutas privadas y patrones `sk-`, `AIza`, `BSADz`) si
el diff toca config/README/docs.

### 3. Publicar

```bash
cd <REPO>
pnpm run publish -- --package sdk --package core --package plugin-memory --package plugin-subagents --package cli
```

Alternativas: `--package <name>` (uno o repetido), `--all` (los 9), `--version <v>` (bump dentro
del script), `--dry-run` (plan sin efectos). **El CLI y plugins solo se incluyen si cambiaron.**

### 4. Verificación

```bash
# Espera propagación y confirma metadata + tarball 200 (VERIFICAR, no asumir):
for i in 1 2 3 4 5 6 7 8 9 10; do
  ok=1
  for p in sdk core alisio-code; do
    v=$(curl -s "https://registry.npmjs.com/@alisio%2f$p?ts=$(date +%s%N)" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('dist-tags',{}).get('latest','?'))" 2>/dev/null)
    [ "$v" = "0.1.0-alpha.X" ] || ok=0
  done
  [ "$ok" = "1" ] && break
  sleep 20
done
# Prueba real de instalación:
PREFIX=$(mktemp -d /tmp/alisio-verify-XXXX)
npm install -g --prefix "$PREFIX" @alisio/alisio-code@0.1.0-alpha.X --prefer-online --no-audit --no-fund
"$PREFIX/bin/alisio" --version
rm -rf "$PREFIX"
```

## Errores comunes

| Error | Causa | Fix |
|---|---|---|
| `E403 You cannot publish over the previously published versions` | Esa versión ya existe | Bump a la siguiente alpha |
| `E404 PUT … Not found` | Sesión npm expirada/inválida (el registry está bien) | `npm logout && npm login` |
| `E409 Cannot publish over previously staged version` | Publish previo quedó en staging asíncrono | Esperar y reverificar con tarball 200; si persiste, subir versión |
| `EUNSUPPORTEDPROTOCOL workspace:*` en instalación | Se publicó con `npm publish` directo | Republicar con `pnpm run publish` en versión nueva |
| `alisio --version` ≠ paquete | Loader no encuentra manifest (versiones viejas, binario sin inyección) | Usar α actual: el loader sube hasta el manifest (fix ≥ alpha.12) |
| Tarball 404 tras publish OK | Propagación async | Reintentar cada 20-30s hasta 200 |
| `docs` dice versión vieja | Token `__ALISIO_VERSION__` solo en build | Verificar en HTML generado, no en fuente |

## Reglas de contexto

- **AGENTS.md raíz** es la fuente de identidad de Alisio: no añadir rutas absolutas.
- El comando `pnpm changeset version` NO se usa para releases normales (promueve fuera de
  prerelease a `0.1.0` estable); los bumps son manuales con el patrón alpha.