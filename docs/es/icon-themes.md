# Cómo crear un plugin de tema de iconos

Un tema de iconos reemplaza los iconos de archivo y carpeta del panel web por SVG de un conjunto
estilo VSCode. Un plugin aporta un tema; el usuario activa como máximo uno a la vez con el ajuste
`web.iconTheme`, y el servidor sirve solo los archivos del tema activo. Alisio no incluye ningún
conjunto de iconos, así que el plugin es dueño de sus recursos.

## El punto de extensión `icon-theme`

Registre un proveedor en el punto de extensión `icon-theme`. Las rutas son absolutas porque el host
las resuelve contra la instalación del plugin, no contra el workspace.

```ts
interface IconThemeProvider {
  /** Id estable: letras minúsculas, dígitos y guiones. Es el valor de `web.iconTheme`. */
  id: string;
  /** Etiqueta humana que muestra el selector de temas. */
  label: string;
  /** Ruta absoluta al JSON del manifiesto de tema de iconos estilo VSCode. */
  manifestPath: string;
  /** Directorio absoluto que contiene los archivos SVG. */
  iconsDir: string;
}
```

## Un plugin mínimo

`setup` registra el proveedor una vez. Resuelva ambas rutas desde la ubicación del propio plugin
para que funcionen tanto desde `src/` como desde `dist/`.

```ts
import { definePlugin } from "@alisio/sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export default definePlugin({
  id: "acme.icon-theme",
  name: "Acme Icons",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.extensions.register("icon-theme", {
      id: "acme",
      label: "Acme Icons",
      manifestPath: join(root, "material-icons.json"),
      iconsDir: join(root, "icons"),
    });
  },
});
```

::: tip Un proveedor, un tema
Un plugin puede registrar varios proveedores, pero el usuario activa como máximo uno. Mantenga `id`
estable: es el valor que se guarda en `web.iconTheme`.
:::

## El formato del manifiesto

El manifiesto sigue la forma de los temas de iconos de VSCode. `iconDefinitions` asocia una clave
interna a una ruta SVG (relativa a `iconsDir` o al directorio del manifiesto); los mapas de búsqueda
apuntan un archivo, una carpeta o una extensión a una de esas claves.

```json
{
  "iconDefinitions": {
    "_ts": { "iconPath": "./file_type_typescript.svg" },
    "_folder": { "iconPath": "./folder.svg" },
    "_folderOpen": { "iconPath": "./folder-open.svg" }
  },
  "file": "_ts",
  "folder": "_folder",
  "folderExpanded": "_folderOpen",
  "fileNames": { "package.json": "_ts" },
  "fileExtensions": { "ts": "_ts", "d.ts": "_ts" },
  "folderNames": { "src": "_folder" },
  "folderNamesExpanded": { "src": "_folderOpen" }
}
```

## Cómo Alisio resuelve y sirve los iconos

La web resuelve cada entrada en este orden: un nombre de carpeta en `folderNames` (su variante
`folderNamesExpanded` cuando está abierta), luego el valor por defecto `folderExpanded`/`folder`; un
nombre de archivo en `fileNames`, luego la clave más larga que coincida en `fileExtensions`, luego el
valor por defecto `file`. Una clave ausente cae en los iconos en línea, así que el panel sigue
funcionando con un conjunto incompleto. El servidor lee el manifiesto una vez y solo sirve el tema
activo:

```text
GET /api/icon-themes              -> { active, themes: [{ id, label }] }
GET /api/icon-theme/manifest      -> el manifiesto activo (404 si no hay ninguno)
GET /api/icon-theme/icons/:name   -> un image/svg+xml con ETag fuerte (404 si no hay ninguno)
```

Los nombres de icono se validan contra `^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$` y se confinan a
`iconsDir`, así que `..`, las rutas absolutas y los nombres que no son SVG se rechazan. Consulte el
[contrato de plugin](/es/plugins) para el resto de la API.

## Instalar y seleccionar un tema

Instale un plugin de tema como cualquier otro y elíjalo en **Ajustes → Apariencia → Tema de
iconos**.

```bash
alisio install npm:@alisio/plugin-material-icons
alisio serve
```

Seleccionar un tema escribe el ajuste global `web.iconTheme`; `Ninguno` restaura los iconos en
línea.

## Licencias y atribución

Un conjunto de iconos es trabajo de otra persona. Siga su licencia: copie el `LICENSE` y la
atribución originales en el plugin y su README, mantenga las rutas originales de los iconos y no
relicencie los iconos. Alisio no incluye ningún conjunto de iconos y no se pronuncia sobre los que
usted instale.
