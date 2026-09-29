# Publicación en npm

`pnpm publish` empaqueta y publica los paquetes de Alisio en el registro público de npm en orden
dependiente seguro (sdk → core → plugins → cli), de modo que los consumidores nunca resuelvan un
rango roto a mitad de la publicación. Aplica a cada manifiesto empaquetado los mismos chequeos de
fugas que `pnpm pack:check`.

## Ruta rápida

```sh
pnpm publish -- --all --dry-run               # vista previa de nombres, versiones, tarballs y orden
pnpm publish -- --all                         # build + publicar todos los paquetes (usted introduce el OTP)
pnpm publish -- --all --version 0.1.0-alpha.5 # subir todos los paquetes a una versión y publicar
pnpm publish -- --package cli                 # publicar solo la CLI
```

`npm` pedirá el código de un solo uso (OTP) de forma interactiva; debe introducirlo el operador. Las
claves y tokens viven en su configuración de npm, nunca en este script, y no se imprimen.

## Requisito: selección explícita

El valor por defecto es **no publicar nada**: debe pasar `--all` o al menos un `--package <nombre>`.
Los paquetes y flags desconocidos fallan rápido, antes de construir o publicar nada.

| Flag | Significado |
| --- | --- |
| `--all` | Todos los paquetes publicables (`sdk`, `core`, `plugin-memory`, `plugin-subagents`, `plugin-openai-compatible`, `cli`) |
| `--package <nombre>` | Un paquete, repetible; combinado con `--all` es la unión |
| `--version <v>` | Fija atómicamente `<v>` en cada `package.json` seleccionado antes de empaquetar (restaura todos los archivos si falla alguna escritura, de modo que un bump parcial nunca sale) |
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
5. Publica cada tarball con `npm publish <tarball> --access public` en orden dependiente seguro.
6. Ante cualquier fallo se detiene, imprime el `name@version` fallido y nunca omite ni publica a
   medias en silencio el resto de paquetes; el código de salida es distinto de cero.

Antes de cada publicación se imprime la línea de resumen `==> name@version`.

## Checklist

- [ ] `pnpm publish -- --all --dry-run` lista exactamente los paquetes que quiere publicar
- [ ] `--version` coincide con la versión del CHANGELOG/notas de versión al subir
- [ ] Los paquetes base (`sdk`, `core`) se publican antes que los plugins y la CLI
- [ ] Introduce el OTP cuando npm lo pida; el script no imprime ningún secreto
- [ ] `pnpm pack:check` y `pnpm test` pasan antes de publicar

## Siguiente paso

Ejecute primero `pnpm publish -- --all --dry-run` y después la publicación real. Consulte
[Limitaciones conocidas](/es/limitations) para lo que aún no se ha ejercitado contra el registro
real.