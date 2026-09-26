# Contexto: AGENTS.md y skills

Alisio construye las instrucciones del modelo a partir de archivos de instrucciones del proyecto
(`AGENTS.md`, según la convención [agents.md](https://agents.md/)) y expone Agent Skills mediante
revelación progresiva.

## AGENTS.md

### Qué archivos se leen

| Alcance | Archivos |
| --- | --- |
| Global | `<config home>/AGENTS.md`; `<config home>/AGENTS.override.md` lo reemplaza cuando existe |
| Proyecto | Un archivo por directorio, recorriendo desde la raíz del workspace hasta el directorio de trabajo |

En cada directorio gana el primer archivo existente:

| Orden | Archivo | Tipo en `context_explain` |
| --- | --- | --- |
| 1 | `AGENTS.override.md` | `override` |
| 2 | `AGENTS.md` | `agents` |
| 3 | `AGENT.md` (alias heredado, conservado por compatibilidad) | `legacy` |
| 4 | `CLAUDE.md`, solo con `context.claudeMdFallback: true` | `claude` |

`Agente.md` ya no se lee. Los archivos se concatenan empezando por la raíz, bajo una cabecera que
indica al modelo que, ante instrucciones en conflicto, gana el archivo más cercano y que los prompts
explícitos del usuario tienen prioridad sobre ellas.

### Archivos anidados

Los archivos de instrucciones de directorios por debajo del directorio de trabajo se adjuntan de
forma perezosa, cuando una herramienta toca una ruta bajo ellos:

- una vez por sesión y por archivo, y de nuevo si el archivo cambia;
- en las herramientas de lectura, las instrucciones se adjuntan al resultado de la herramienta;
- en las llamadas de escritura o de procesos, la llamada se devuelve al modelo con las nuevas
  instrucciones para que la reconsidere antes de reintentarla.

### Límite de tamaño

El conjunto de archivos de instrucciones está limitado a `context.maxBytes` (por defecto 32 KiB). Se
conservan los archivos más cercanos; los más lejanos se truncan o se descartan con un aviso de
truncado.

```json
{
  "context": { "claudeMdFallback": false, "maxBytes": 32768 }
}
```

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `claudeMdFallback` | `false` | Usar `CLAUDE.md` en directorios sin archivo `AGENTS` |
| `maxBytes` | `32768` | Bytes totales de archivos de instrucciones (1024–1048576) |

`alisio context explain <path>` (y la herramienta `context_explain`) muestra qué archivos se aplican a
una ruta y su tipo. La plantilla integrada [`/init`](/es/prompt-templates#built-in-init) crea o
actualiza el `AGENTS.md` raíz.

## Skills

Las skills son directorios que contienen un archivo `SKILL.md` con frontmatter `name` y
`description`.

### Descubrimiento

Las raíces se recorren en este orden; gana la primera skill con un nombre dado, y las posteriores se
informan como ocultadas:

| Orden | Raíces | Cuándo |
| --- | --- | --- |
| 1 | `.agents/skills`, `.alisio/skills`, `.claude/skills` en cada directorio desde el directorio de trabajo hasta la raíz del workspace | Solo proyectos de confianza (`--trust-project` o un `--config` explícito) |
| 2 | Rutas de la clave de configuración `skills` | Siempre |
| 3 | `~/.agents/skills`, `<config home>/skills` | Siempre |
| 4 | Directorios registrados por plugins (`api.resources.skills`) | Cuando el plugin está cargado |

El recorrido está acotado: como máximo 5 niveles de profundidad y 2000 directorios.

### Validación

Los nombres siguen la especificación de Agent Skills: 1–64 letras minúsculas y dígitos con guiones
simples, sin guion al principio ni al final. La descripción es obligatoria (hasta 1024 caracteres).
Un nombre de directorio que no coincide con el nombre de la skill solo produce una advertencia.
`alisio skills validate [path]` informa todos los diagnósticos.

### Revelación progresiva

Al principio solo se incluyen en el contexto el nombre y la descripción de cada skill. El cuerpo se
carga con la herramienta `skill_load` o con `/skill:name`, y los archivos de apoyo con
`skill_resource`. `skill_search` busca en el catálogo.

```sh
alisio skills list
alisio skills validate ./.agents/skills
```
