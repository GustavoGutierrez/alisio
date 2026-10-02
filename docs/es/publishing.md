# Publicación en npm

`pnpm publish` empaqueta y publica los paquetes de Alisio en el registro público de npm en orden
dependiente seguro (sdk → core → plugins y server → cli), de modo que los consumidores nunca resuelvan un
rango roto a mitad de la publicación. Aplica a cada manifiesto empaquetado los mismos chequeos de
fugas que `pnpm pack:check`.

## Ruta rápida

```sh
pnpm publish -- --all --dry-run               # vista previa de nombres, versiones, tarballs y orden
pnpm publish -- --all                         # build + publicar todos los paquetes (usted introduce el OTP)
pnpm publish -- --all --version 0.1.1         # subir todos los paquetes a una versión estable y publicar
pnpm publish -- --package cli                 # publicar solo la CLI
```

`npm` pedirá el código de un solo uso (OTP) de forma interactiva; debe introducirlo el operador. Las
claves y tokens viven en su configuración de npm, nunca en este script, y no se imprimen.

## Requisito: selección explícita

El valor por defecto es **no publicar nada**: debe pasar `--all` o al menos un `--package <nombre>`.
Los paquetes y flags desconocidos fallan rápido, antes de construir o publicar nada.

| Flag | Significado |
| --- | --- |
| `--all` | Todos los paquetes publicables (`sdk`, `core`, `plugin-memory`, `plugin-subagents`, `plugin-openai-compatible`, `server`, `cli`) |
| `--package <nombre>` | Un paquete, repetible; combinado con `--all` es la unión |
| `--version <v>` | Fija atómicamente `<v>` (estable como `0.1.1`, o prerelease como `0.2.0-rc.1`) en cada `package.json` seleccionado antes de empaquetar (restaura todos los archivos si falla alguna escritura, de modo que un bump parcial nunca sale) |
| `--dry-run` | Imprime exactamente lo que se publicaría (nombres, versiones, tarballs, orden) y sale — sin build, sin bump, sin empaquetar, sin publicar |
| `--build` | Construye primero (`pnpm build`). Activado por defecto; pase `--no-build` para omitirlo |

## Qué hace y qué garantiza

1. Analiza los flags y resuelve cada paquete a `packages/<dir>`.
2. Con `--version`: sube el número de cada `package.json` seleccionado de forma atómica e imprime la
   versión nueva.
3. Construye (`pnpm build`) salvo con `--no-build`.
4. Empaqueta cada paquete con `pnpm pack` en un directorio temporal y aplica al **manifiesto
   empaquetado** el chequeo de fugas de pack-check (sin `workspace:`, sin export
   `alisio-source`/`./src/`, `exports` apuntando a `./dist/`, que no sea `private`).
5. Publica cada tarball con `npm publish <tarball> --access public` en orden dependiente seguro. Una
   versión estable se publica con `--tag latest`; una prerelease no pasa `--tag`, así que npm aplica
   su etiqueta por defecto (use una prerelease solo si no le importa que pase a ser `latest`, o
   publíquela a mano con una etiqueta explícita desde un tarball empaquetado).
6. Ante cualquier fallo se detiene, imprime el `name@version` fallido y nunca omite ni publica a
   medias en silencio el resto de paquetes; el código de salida es distinto de cero.

Antes de cada publicación se imprime la línea de resumen `==> name@version`.

Con `--all` el script se niega a publicar si los paquetes no están todos en una misma versión: los
siete paquetes se publican juntos.

## Estabilidad y versionado

Alisio sigue semver en su forma 0.x:

- **Numeración.** Los siete paquetes (`@alisio/sdk`, `@alisio/core`, `@alisio/server`,
  `@alisio/alisio-code`, `@alisio/plugin-memory`, `@alisio/plugin-subagents`,
  `@alisio/plugin-openai-compatible`) comparten una sola versión. La primera versión estable es
  `0.1.0`. Las correcciones salen como `0.1.x`; las funcionalidades y todo lo que pueda romper salen
  como `0.2.0`, `0.3.0`, etc.
- **Las prereleases son opcionales** y usan `-rc.N` o `-alpha.N` (`0.2.0-rc.1`). `latest` es solo
  para versiones estables.
- **Qué cuenta como API pública:** el contrato de `@alisio/sdk` (hooks, herramientas, comandos y
  eventos de plugins), el formato del archivo de configuración y el protocolo web/SSE de
  `alisio serve`. Las migraciones de SQLite solo avanzan: una versión nueva de Alisio actualiza sus
  datos, una anterior puede no poder leerlos. Mientras sea 0.x, una versión menor puede cambiar
  cualquiera de ellos; el changelog lo indica.
- **Los plugins** declaran `@alisio/sdk` como dependencia peer con `^0.2.0`, que acepta 0.2.x y no
  0.1.x ni 0.3.0 (los rangos con circunflejo en 0.x nunca cruzan una versión menor). Un plugin que
  soporte ambas líneas declara `^0.1.0 || ^0.2.0`.
- **1.0.0** está prevista para cuando el SDK, el formato de configuración y el protocolo de eventos
  estén congelados. No se publicará antes, y desde entonces los cambios incompatibles exigirán una
  versión mayor.

## Etiqueta de release

Tras una publicación correcta y una instalación verificada, etiquete el commit del release:

```sh
git tag -a v0.1.0 -m "Alisio 0.1.0"
git push origin v0.1.0
```

Use la misma versión que los paquetes (`vX.Y.Z`). Las etiquetas se crean a mano después de publicar;
el script nunca etiqueta, hace commit ni push.

## Checklist

- [ ] `pnpm publish -- --all --dry-run` lista exactamente los paquetes que quiere publicar
- [ ] `--version` coincide con la versión del CHANGELOG/notas de versión al subir
- [ ] Los paquetes base (`sdk`, `core`) se publican antes que los plugins, el servidor y la CLI
- [ ] Existe la entrada de `CHANGELOG.md` para la versión y se ejecutó `pnpm changelog:data`
- [ ] Tras publicar, `git tag -a vX.Y.Z` y `git push origin vX.Y.Z`
- [ ] Introduce el OTP cuando npm lo pida; el script no imprime ningún secreto
- [ ] `pnpm pack:check` y `pnpm test` pasan antes de publicar

## Siguiente paso

Ejecute primero `pnpm publish -- --all --dry-run` y después la publicación real. Consulte
[Limitaciones conocidas](/es/limitations) para lo que aún no se ha ejercitado contra el registro
real.