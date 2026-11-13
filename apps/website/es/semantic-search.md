# Búsqueda semántica

La búsqueda semántica encuentra texto por su **significado**, no por las palabras exactas. Alisio
incluye la capacidad compartida; el motor que hace el trabajo viene de un complemento que tú decides
activar.

## Qué es {#what-it-is}

Una búsqueda normal busca las palabras que escribiste. Una búsqueda semántica busca la idea que hay
detrás: una consulta por "reunión de presupuesto" puede encontrar una nota titulada "revisión
financiera trimestral" aunque no compartan ninguna palabra. Según el modelo que use el motor,
también puede funcionar entre idiomas, de modo que una pregunta en español encuentre un documento
escrito en inglés.

## Qué permite {#what-it-enables}

La búsqueda semántica es un bloque de construcción. Los complementos que la usan pueden ofrecer:

- **Conversar con tus propios documentos**, con respuestas que citan los pasajes de donde salieron
  (un cuaderno de investigación sobre tus fuentes).
- **Una memoria más inteligente**, que encuentra lo que guardaste por significado y no solo por
  palabras clave.
- **Archivos y notas relacionados**, para hallar lo que se parece a lo que estás leyendo.
- **Deduplicar y agrupar** contenido similar, como documentos casi idénticos o notas repetidas.

## Cómo funciona en Alisio {#how-it-works}

- **Alisio define la capacidad.** Aporta el contrato compartido y el servicio que usan los complementos,
  y nada más pesado, así la aplicación se mantiene pequeña.
- **Un complemento proveedor aporta el motor**: un modelo de embeddings (convierte el texto en números que
  capturan el significado) y un almacén de vectores (los guarda y los busca).
- **Instalar un complemento nunca lo activa.** Lo activas tú, y tu elección se guarda en tu configuración
  global. La configuración de un proyecto no puede activar un proveedor.
- **`/semantic` muestra el estado**: qué proveedores están registrados y activos, el modelo y la
  salud de cada uno.
- **Puede ejecutarse en local.** Que algo salga de tu equipo depende del proveedor que elijas.

## Estado actual {#status}

::: tip Instala un proveedor para activarla
Alisio 0.11.7 incluye la capacidad, no el motor, para que la aplicación siga siendo ligera. El
proveedor es `@alisio/plugin-semantic`, del catálogo de alisio-plugins: usa un almacén local LanceDB
con el modelo multilingual-e5-small e incluye una app Notebook para conversar con tus fuentes, con
respuestas citadas. Instálalo como cualquier otro complemento y actívalo cuando te lo pida. Sin un
proveedor activo, los complementos recurren a su propio comportamiento, por ejemplo la búsqueda por
palabras clave.
:::

## Privacidad y límites {#privacy}

- Los vectores y los índices permanecen donde el proveedor los guarde. Revisa qué hace tu proveedor
  antes de indexar documentos privados.
- Cambiar el modelo obliga a indexar de nuevo: los vectores de modelos distintos no son comparables,
  por lo que las colecciones existentes se rechazan hasta que se reconstruyan.
- Cada complemento tiene su propio espacio de nombres de colecciones. Los espacios de nombres evitan
  mezclas accidentales; no son un sandbox de seguridad, porque los complementos son código de confianza.
- Puedes desactivar la función con `semantic.enabled`.

## Para desarrolladores de complementos {#for-developers}

Los complementos pueden consumir la capacidad mediante `context.semantic` o aportar un motor mediante
`api.semantic`. Ambos miembros son opcionales, así que detéctalos y mantén una alternativa. Consulta
[Proveedores y consumidores de búsqueda semántica](/es/plugins#semantic-search) para la API y la
clave de configuración [`semantic`](/es/configuration#semantic) para los ajustes.
