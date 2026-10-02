---
name: alisio-publish
description: "Publicar versiones estables (semver 0.x) de Alisio en npm: elegir versión, subir los 7 paquetes juntos, CHANGELOG, pnpm run publish, verificación con instalación real, tag vX.Y.Z y aviso a los plugins externos. Trigger: publicación, release, bump, nueva versión npm."
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
   misma versión — sube a la siguiente (`0.1.x`).
3. **Los publishes de npm son asíncronos**: "Your package is being processed…" es normal;
   verifica el tarball con HTTP 200, no solo la metadata (espera 1-5 min y reintenta).
4. **OTP/tokens**: npm exige OTP por paquete (2FA `auth-and-writes`). El operador escribe el
   OTP; nunca se pega en el chat.
5. **Propagación del dist-tag**: tras publicar, `latest` puede tardar en actualizarse; usa
   `--prefer-online` en instalaciones para saltar la caché local.
6. **Los 7 paquetes salen juntos y con la misma versión** (`sdk`, `core`, `server`, `cli`,
   `plugin-memory`, `plugin-subagents`, `plugin-openai-compatible`); `packages/web` (privado) y
   el `package.json` raíz se mantienen en esa misma versión por consistencia. `--all` se niega a
   publicar si no coinciden.

## Política de versiones (semver 0.x)

- Correcciones: `0.1.x` (0.1.1, 0.1.2…). Funcionalidades o cualquier cambio que pueda romper:
  `0.2.0`, `0.3.0`… Mientras sea 0.x una versión menor puede romper la API pública (contrato de
  `@alisio/sdk`, formato de configuración, protocolo web/SSE; las migraciones de BD solo avanzan).
- `1.0.0` solo cuando el SDK, el formato de configuración y el protocolo de eventos estén
  congelados. **Los plugins externos** (repo `alisio-plugins`, p. ej. `@alisio/plugin-deepseek`)
  declaran `@alisio/sdk` como peer (`^0.1.0` para la línea 0.1, `^0.2.0` para 0.2): un rango con
  circunflejo en 0.x no cruza versiones menores; quien soporte ambas declara `^0.1.0 || ^0.2.0`.
- Prereleases opcionales: `-rc.N` o `-alpha.N`. `latest` es para estables: el script pasa
  `--tag latest` a las estables y **no pasa `--tag` a las prereleases** (npm aplica su tag por
  defecto, que podría ser `latest`), así que una prerelease solo se publica con cuidado y
  sabiendo eso.
- Ejemplo: `0.1.0` estable → `0.1.1` fix → `0.2.0` con features o cambios incompatibles.

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
# 1. Añade arriba "## [<versión>] - <AAAA-MM-DD>" (la versión es la de todos los paquetes) con
#    ### Added / ### Improved / ### Fixed. Una estable ordena por encima de sus prereleases.
# 2. Regenera los datos embebidos (módulo TS que viaja dentro de dist; lo comprueba un test):
pnpm changelog:data
git add CHANGELOG.md packages/core/src/changelog/data.ts
```

Sin entrada para la versión del CLI, `/changelog` y la línea de novedades tras actualizar no
muestran nada de esa versión. `pnpm build` también regenera los datos.

### 1. Bump de versión de los 7 paquetes

Fija la misma versión en los 7 paquetes publicables, en `packages/web` y en el `package.json`
raíz (`<V>` = versión elegida, p. ej. `0.1.1`):

```bash
cd <REPO>
V=<V>
for f in packages/*/package.json package.json; do
  node -e 'const fs=require("fs");const [f,v]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=v;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$f" "$V"
done
git diff --stat
pnpm run publish -- --all --dry-run   # plan: 7 paquetes, misma versión, tag latest
pnpm pack:check 2>&1 | tail -9        # tarballs limpios (el changelog viaja como dist/*.js)
pnpm typecheck 2>&1 | tail -1
```

Alternativa: `pnpm run publish -- --all --version <V>` hace el bump atómico de los 7 paquetes
(no toca `packages/web` ni el raíz: súbelos a mano).

Los rangos entre paquetes (`workspace:*` / `workspace:^`) los reescribe `pnpm pack`:
`workspace:*` pasa a la versión exacta y `workspace:^` a `^<V>`. No se editan a mano.

### 2. Verificación previa y commit

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:cli && pnpm test:compiled && pnpm pack:check && pnpm docs:build
git add -A
git diff --cached --check
git commit -m "chore: release <V>"
git push origin main
```

Antes del commit, escaneo de secretos (rutas privadas y patrones `sk-`, `AIza`, `BSADz`) si
el diff toca config/README/docs. Nunca añadas atribución de IA al mensaje de commit.

### 3. Publicar

```bash
cd <REPO>
pnpm run publish -- --all            # orden: sdk, core, plugins, server, cli; el operador pone el OTP
```

Alternativas: `--package <name>` (uno o repetido; solo para una corrección puntual y aun así con
la regla de versión única en mente), `--version <v>`, `--dry-run` (plan sin efectos),
`--no-build`.

### 4. Verificación

```bash
# Espera propagación y confirma metadata + tarball 200 (VERIFICAR, no asumir):
for i in 1 2 3 4 5 6 7 8 9 10; do
  ok=1
  for p in sdk core server alisio-code plugin-memory plugin-subagents plugin-openai-compatible; do
    v=$(curl -s "https://registry.npmjs.com/@alisio%2f$p?ts=$(date +%s%N)" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('dist-tags',{}).get('latest','?'))" 2>/dev/null)
    [ "$v" = "<V>" ] || ok=0
  done
  [ "$ok" = "1" ] && break
  sleep 20
done
# Prueba real de instalación:
PREFIX=$(mktemp -d)
npm install -g --prefix "$PREFIX" @alisio/alisio-code@<V> --prefer-online --no-audit --no-fund
"$PREFIX/bin/alisio" --version      # debe imprimir <V>
"$PREFIX/bin/alisio" doctor
rm -rf "$PREFIX"
```

### 5. Tag y release

Solo tras publicar y verificar la instalación:

```bash
git tag -a v<V> -m "Alisio <V>"
git push origin v<V>
```

Después crea el GitHub Release `v<V>` con las notas (copiadas del CHANGELOG). El script nunca
etiqueta ni hace push.

### 6. Aviso al mantenedor de los plugins externos

Dile al mantenedor de `alisio-plugins`: la versión publicada, que `@alisio/sdk` debe declararse
como peer `^0.1.0` (acepta 0.1.x, no 0.2.0), y — si la versión es una menor nueva (0.2.0) — que
los plugins deben subir su peer y revisar los cambios incompatibles del CHANGELOG antes de
publicar de nuevo.

## Errores comunes

| Error | Causa | Fix |
|---|---|---|
| `E403 You cannot publish over the previously published versions` | Esa versión ya existe | Sube a la siguiente versión (`0.1.x`) en los 7 paquetes |
| `E404 PUT … Not found` | Sesión npm expirada/inválida (el registry está bien) | `npm logout && npm login` |
| `E409 Cannot publish over previously staged version` | Publish previo quedó en staging asíncrono | Esperar y reverificar con tarball 200; si persiste, subir versión |
| `EUNSUPPORTEDPROTOCOL workspace:*` en instalación | Se publicó con `npm publish` directo | Republicar con `pnpm run publish` en versión nueva |
| `--all releases every package at one version` | Los 7 paquetes no tienen la misma versión | Igualar versiones (paso 1) o usar `--version <V>` |
| `alisio --version` ≠ paquete | Loader no encuentra manifest (binario sin inyección) | Reconstruir: el binario inyecta `ALISIO_PACKAGE_VERSION` desde el manifest del CLI |
| Tarball 404 tras publish OK | Propagación async | Reintentar cada 20-30s hasta 200 |
| `docs` dice versión vieja | Token `__ALISIO_VERSION__` solo en build | Verificar en HTML generado, no en fuente |
| Un plugin externo no resuelve `@alisio/sdk` | Su peer es `^0.1.0-alpha.x` y la versión es 0.2.0+ | El plugin sube su peer al rango estable actual |

## Reglas de contexto

- **AGENTS.md raíz** es la fuente de identidad de Alisio: no añadir rutas absolutas.
- El flujo de changesets (`pnpm changeset version`, workflow `release.yml`) NO se usa para
  publicar: los bumps son manuales y los publishes salen de `pnpm run publish`.
