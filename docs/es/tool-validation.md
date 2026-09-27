# Validación de herramientas

Esta página es una lista de comprobación (smoke validation) de las herramientas de Alisio: para cada
herramienta, una llamada concreta y el resultado que demuestra que está conectada y es alcanzable.
Registra el alcance de la verificación de herramientas; los límites de runtime y empaquetado están en
[Limitaciones conocidas](/es/limitations) y el modelo de efectos en
[Herramientas y permisos](/es/tools).

## Alcance

- Cubre las herramientas que Alisio trae: el conjunto integrado y las que añaden los plugins
  integrados `memory` y `subagents`.
- Las herramientas MCP de terceros quedan fuera, salvo por el hecho de que dependen de su servidor:
  la lista es la que exponga el servidor conectado.
- La validación es una llamada real en una sesión, no una prueba unitaria, y cada fila es
  reproducible por un usuario con los mismos flags.

## Herramientas integradas

| Herramienta | Efecto | Validación | Resultado esperado |
| --- | --- | --- | --- |
| `read_file` | `read` | Leer un archivo versionado como `package.json` | El contenido y una huella `sha256` |
| `list_files` | `read` | Listar un directorio como `packages` | Entradas con `nextOffset` y `truncated` |
| `search_text` | `read` | Buscar un literal que exista en el repo | Coincidencias con archivo y línea |
| `git_status` | `read` | Ejecutarla dentro de un repositorio Git | La salida de `git status --porcelain=v1` |
| `git_diff` | `read` | Ejecutarla con cambios pendientes | Un diff unificado |
| `skill_load` | `read` | Cargar un skill instalado | La raíz del skill y sus instrucciones |
| `skill_search` | `read` | Buscar un término | Skills coincidentes, o `[]` si no hay |
| `skill_resource` | `read` | Leer un archivo dentro de un skill | El contenido del archivo |
| `context_explain` | `read` | Explicar los `AGENTS.md` de una ruta | Los ámbitos que aplican, el más cercano al final |
| `ask_user_question` | `read` | Hacer 1-4 preguntas en la TUI | Las respuestas elegidas, o un error rápido en headless |
| `write_file` | `write` | Crear un archivo de prueba | La ruta nueva y un `sha256` |
| `edit_file` | `write` | Reemplazar una coincidencia única | Un `sha256` actualizado |
| `run_process` | `process` | Ejecutar `git rev-parse --short HEAD` | El id corto del commit |
| `shell` | `process` | Ejecutar `pwd && node --version` | El directorio de trabajo y la versión de Node |
| `execute` | `process` | Llamar una herramienta de lectura en un snippet | El resultado de esa herramienta como JSON |
| `webfetch` | `external` | Descargar `https://example.com` | Estado 200 y el texto de la página |
| `websearch` | `external` | Buscar cualquier consulta | Resultados ordenados, o un error del proveedor |
| `plugin_install` | `process` | Instalar un plugin npm conocido | La ruta instalada y la entrada en la configuración |

## Herramientas de plugin

| Herramienta | Efecto | Validación | Resultado esperado |
| --- | --- | --- | --- |
| `memory_save` | `internal` | Guardar una observación | El id y la acción (`created`, `updated`, `duplicate`) |
| `memory_search` | `internal` | Buscar una palabra ya guardada | Filas compactas, o `[]` |
| `memory_get` | `internal` | Pedir un id guardado | La observación completa |
| `memory_context` | `internal` | Llamarla al inicio de sesión | Un bloque de contexto acotado |
| `memory_timeline` | `internal` | Pedir los vecinos de un id | Filas anteriores y posteriores |
| `memory_pin` | `internal` | Fijar y luego soltar un id | `pinned: true`, y después `false` |
| `memory_forget` | `internal` | Borrado lógico; `hard: true` lo elimina | `forgotten: true` |
| `task` | `internal` | Delegar una tarea pequeña de solo lectura | Un id de tarea, en primer plano o en segundo |
| `task_status` | `internal` | Consultar ese id | Estado, agente y número de tokens |
| `task_wait` | `internal` | Esperar ese id | El informe final del subagente |
| `send_message` | `internal` | Enviar un mensaje a una tarea terminada | Se reanuda en segundo plano |

## Herramientas condicionadas por permisos

Las herramientas `read` están siempre disponibles y las `internal` solo tocan el estado propio de
Alisio; `write`, `process` y `external` necesitan un flag o una aprobación interactiva en la TUI.
Para validar una herramienta condicionada, concede su efecto antes.

| Efecto | Habilitar con | Ejecución headless sin flag |
| --- | --- | --- |
| `read` | Siempre habilitado | Disponible |
| `write` | `--allow-write`, o aprobar en la TUI | No disponible |
| `process` | `--allow-process`, o aprobar en la TUI | No disponible |
| `external` | `--allow-external`, `--allow-mcp`, `--allow-agents`, o aprobar en la TUI | No disponible |
| `internal` | Siempre habilitado | Disponible |

`--read-only` gana sobre cualquier flag `--allow-*`: el efecto nunca se ofrece, ni en la TUI ni en
headless.

## Dependencias externas

- `list_files` y `search_text` necesitan el ejecutable `rg` en el `PATH`.
- `webfetch` y `websearch` necesitan acceso a la red. `websearch` usa el `websearch.provider`
  configurado y, si no, una instancia pública de SearXNG; las instancias públicas pueden responder
  con una página de verificación anti-bots en lugar de resultados, así que configura un proveedor
  para un uso fiable.
- Las herramientas MCP solo existen tras conectar su servidor (`--allow-mcp`, o el global
  `mcp.allow`).
- `ask_user_question` necesita una interfaz interactiva enlazada; en headless falla rápido y le pide
  al modelo que pregunte en texto plano.

## Procedimiento

```sh
# Interactivo: la lectura es inmediata; aprueba write/process/external por llamada
alisio

# O arranca permisivo durante la sesión
alisio --allow-write --allow-process --allow-external

# Headless: un flag sin definir deja el efecto no disponible
alisio run "lista las herramientas disponibles" --allow-write --allow-process --allow-external
```

Tras cambiar herramientas, ejecuta las comprobaciones del repositorio (`pnpm check`) para mantener en
verde el typecheck, el lint, las pruebas, el end-to-end de la CLI y los gates de documentación.

## Última ejecución

Instantánea del 2026-09-27 (Node v22.19.0, commit `ace8def`): todas las herramientas integradas y de
plugin anteriores respondieron como se esperaba, salvo `websearch`, que falló porque la instancia
pública por defecto de SearXNG devolvió una página de verificación anti-bots — un problema del
proveedor, no de la herramienta. `ask_user_question` se ejecutó en la TUI interactiva y devolvió
respuestas. `plugin_install` no se ejecutó porque cambia estado global.
