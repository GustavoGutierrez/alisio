# Agentes

Los agentes son personas reutilizables: un nombre, unas instrucciones (un prompt de sistema), un
modelo y algunos ajustes del modelo. Alisio los guarda como archivos Markdown que otras
herramientas (Claude Code, OpenCode) también pueden leer, y permite crearlos, editarlos, probarlos
y cambiar entre ellos desde la interfaz web y la terminal.

## Dónde viven los agentes

| Ámbito | Ruta | Se carga cuando |
| --- | --- | --- |
| Proyecto | `<workspace>/.agents/agents/<id>.md` | el workspace es de confianza (desde la web o la terminal) |
| Global | `~/.agents/agents/<id>.md` | siempre |

Un workspace que no es de confianza guarda los agentes de proyecto pero no los carga; confía en él
desde el menú **⋯** del workspace en la barra lateral o con el botón del editor y se cargan al
momento.

Si el mismo id existe en los dos ámbitos, el agente de proyecto reemplaza al global; las listas
muestran ambos con una insignia Proyecto/Global y marcan el reemplazo. Los agentes nuevos van al
ámbito de proyecto cuando hay un workspace abierto y, si no, al global.

Alisio sigue leyendo sus otras ubicaciones de agentes (`.alisio/agents`, `<config>/agents`,
`.claude/agents`, `.opencode/agent(s)`); la ventana Agentes y `/agents manage` solo escriben y
listan los dos ámbitos `.agents/agents`.

## Formato del archivo

```markdown
---
name: code-reviewer
description: Reads a diff and reports bugs, risky changes and missing tests.
model: openai-compatible/gpt-5
mode: all
tools: Read, Grep
alisio:
  displayName: Code Reviewer
  reasoning:
    effort: high
    summary: auto
  text:
    format:
      type: text
    verbosity: medium
---

You are a meticulous code reviewer working inside the user's repository.
```

`name` es el id (minúsculas, dígitos y guiones), `description` y `model` siguen la convención
habitual de subagentes y el cuerpo son las instrucciones. Los ajustes propios de Alisio viven bajo
`alisio:`, que las demás herramientas ignoran. Cuando Alisio edita un archivo creado por otra
herramienta, todas las demás claves y comentarios se conservan tal cual.

## Web: la ventana Agentes

Abre **Agentes** en la barra lateral, justo encima de **Ajustes**.

- **Tus agentes** lista los agentes de proyecto y globales; haz clic en uno para editarlo, o
  elimínalo.
- Las **Plantillas** inician un agente nuevo ya relleno: Code Reviewer, Test Writer, Refactoring
  Assistant, Documentation Writer, Security Auditor, Bug Triage & Debugger, Migration Assistant,
  Research Agent, Customer Support Agent, DevOps Assistant, Meeting Assistant y Analytics Agent.
- **Crear** abre el editor. Describe el agente y pulsa **Crear con Alisio**: el modelo activo
  escribe el rol, el objetivo, el alcance, las reglas de herramientas, las restricciones y el
  formato de salida mientras el diálogo "Construyendo con Alisio" muestra el progreso (Cancelar
  detiene la llamada al modelo). El agente nuevo se guarda y puedes **Probarlo en un chat nuevo**
  o **Seguir en el editor**. Con instrucciones existentes (una plantilla o un agente guardado) el
  botón pasa a **Refinar con Alisio** y aplica los cambios que pidas.
- La pestaña **Configuración** tiene la definición (nombre, descripción, instrucciones, ámbito) y
  los ajustes del modelo. La lista de modelos sale de tus proveedores configurados; el formato de
  texto, el esfuerzo de razonamiento, la verbosidad y el resumen siguen lo que declara el modelo
  elegido, y se ofrecen todas las opciones cuando el proveedor no declara nada. **Guardar
  definición del agente** solo se activa con una definición válida y cambios sin guardar.
- **Configuración del agente** muestra la misma definición como petición a la API propia de
  Alisio, lista para copiar.
- La pestaña **Sesiones** lista los chats que usan el agente e inicia uno nuevo.

La guía de redacción sale de una skill llamada `create-agent` (o `agent-creator`) si tus skills de
proyecto o de usuario tienen una; si no, Alisio usa su guía `create-agent` incluida.

## Cambiar de agente

Cada agente cargado es también un comando, `/agent:<id>`; el prefijo `agent:` nunca choca con
comandos integrados, comandos de plugins, plantillas de prompts ni skills. `/agents` abre un
selector con búsqueda que marca el agente actual y ofrece `build` para volver al agente
predeterminado de Alisio. En la web, la insignia del agente en la cabecera del chat abre el mismo
selector.

El cambio se aplica desde el siguiente mensaje, nunca a mitad de un turno: entonces se aplican las
instrucciones del agente, su modo de solo lectura y su esfuerzo de razonamiento por defecto. Un
esfuerzo explícito (`/effort`, o el ajuste propio del chat) gana sobre el del agente. El modelo del
agente se aplica en el mismo chat solo si pertenece al proveedor del chat; si no, inicia un chat
nuevo con el agente.

El agente integrado `plan` termina con la herramienta `exit_plan`: el usuario revisa el plan y, si lo
acepta, el chat cambia a `build` y lo implementa. Véase [Modo plan y revisión del plan](/es/web#plan-review).

## Terminal: `/agents`

```text
/agents                       picker: switch agent, + Create agent…, ✎ Manage saved agents…
/agents new [description]     create (with a description: written by Alisio right away)
/agents templates             start from a template
/agents manage                edit, activate, try or delete saved agents
/agents edit <id> [project|global]
/agents delete <id> [project|global]
/agents reload                rediscover agent files (subagents plugin)
/agent:<id>                   activate an agent from the next prompt
```

El editor es una lista de campos; Enter edita uno. Las instrucciones se editan en una línea, con
`\n` para los saltos de línea, o se reescriben con **✦ Refinar con Alisio**. Mientras el modelo
escribe, la línea de pistas muestra "Building with Alisio" y Esc lo cancela. Tras crear un agente,
Alisio ofrece probarlo en una sesión nueva.

## API

```sh
curl -X POST http://127.0.0.1:4317/api/agents \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:4317" \
  -H "Cookie: alisio_session_4317=<session cookie>" \
  -d '{"workspace":"<workspace id>","scope":"project","name":"Code Reviewer","model":"openai-compatible/gpt-5","instructions":"You review diffs.","reasoning":{"effort":"high"},"text":{"format":{"type":"text"},"verbosity":"medium"}}'
```

| Método | Ruta | Uso |
| --- | --- | --- |
| `GET` | `/api/agents/definitions?workspace=` | ambos ámbitos, ámbito por defecto y directorios |
| `POST` | `/api/agents` | crear (`scope`, `workspace` opcional) |
| `GET` / `PUT` / `DELETE` | `/api/agents/:id?scope=&workspace=` | leer, actualizar, eliminar |
| `GET` | `/api/agents/templates` | plantillas |
| `GET` | `/api/agents/models?workspace=` | modelos configurados con sus capacidades |
| `POST` | `/api/agents/draft` | borrador o refinado con el modelo activo |
| `GET` | `/api/sessions?agent=<id>` | sesiones que usan un agente |

Las escrituras responden `{ agent, live }`. `live: true` significa que el Alisio en ejecución ya usa
el cambio: tras cada escritura se recarga el registro de agentes y los clientes reciben
`catalog_changed`. `live: false` (el plugin de subagentes está desactivado, el workspace no es de
confianza u otra ubicación tapa el archivo) significa que el archivo se guardó y que Alisio debe
reiniciarse para usarlo; la interfaz lo indica.

Consulta [Limitaciones conocidas](/es/limitations) para lo que aún no está conectado.
