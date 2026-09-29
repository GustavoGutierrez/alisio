# Guía de estilo de Alisio

Use esta guía al diseñar la documentación y las superficies de producto de Alisio. Define la
paleta de marca, los roles por tema, los gradientes, los estados semánticos y los límites de
accesibilidad que mantienen una experiencia clara en modo claro y oscuro.

## Base de marca

La identidad central usa tres tonos fríos y un ancla profunda:

| Nombre | Token | Valor | Rol |
| --- | --- | --- | --- |
| Alisio Light Cyan | `--alisio-cyan-light` | `#60E0F9` | Highlights, brillos, badges y foco |
| Alisio Sky | `--alisio-sky` | `#07C4F9` | Acentos, estados activos y primario oscuro |
| Alisio Blue | `--alisio-blue` | `#01A5F7` | Primario en modo claro |
| Alisio Deep Ocean | `--alisio-deep-navy` | `#031C36` | Superficies secundarias y gradientes oscuros |

La escala completa de azul sirve para controles, enlaces, bordes, badges, tarjetas, bloques de
código, navegación, selección, foco y gradientes:

| Escala | Valor | Escala | Valor |
| --- | --- | --- | --- |
| 50 | `#EFFCFF` | 500 | `#07C4F9` |
| 100 | `#D8F7FE` | 600 | `#01A5F7` |
| 200 | `#B6F0FC` | 700 | `#087BC1` |
| 300 | `#85E7FB` | 800 | `#075A92` |
| 400 | `#60E0F9` | 900 | `#06345F` |
| 950 | `#031C36` |  |  |

## Tema claro

Mantenga la documentación luminosa y técnica: use un fondo blanco o ligeramente azulado, no una
superficie general azul saturada.

| Rol | Valor |
| --- | --- |
| Primario / hover | `#01A5F7` / `#087BC1` |
| Acento / highlight | `#07C4F9` / `#60E0F9` |
| Fondo / secundario | `#F8FCFF` / `#EFF9FE` |
| Superficie / hover | `#FFFFFF` / `#E8F7FD` |
| Borde / borde fuerte | `#CDECF8` / `#8EDAF2` |
| Texto / secundario / atenuado | `#06233D` / `#45647A` / `#6F8798` |
| Fondo de código | `#F0F8FC` |

La tipografía usa los roles de texto oscuro, con `#06233D` como predeterminado. Use texto
secundario y atenuado solo como apoyo; no use azul de marca como color general de texto.

## Tema oscuro

Use azul marino en vez de negro puro para conservar profundidad. En modo oscuro, Sky es el primario
porque tiene mejor presencia sobre el fondo Midnight.

| Rol | Valor |
| --- | --- |
| Primario / hover | `#07C4F9` / `#60E0F9` |
| Acento / highlight | `#01A5F7` / `#60E0F9` |
| Fondo / secundario | `#020E1C` / `#031C36` |
| Superficie / hover | `#062747` / `#08385F` |
| Borde / borde fuerte | `#0A456E` / `#087BC1` |
| Texto / secundario / atenuado | `#EDF9FF` / `#A8CDDD` / `#7297A9` |
| Fondo de código | `#03182D` |

## Superficies y componentes

- **Páginas:** use el fondo del tema; casi blanco en modo claro y Midnight en modo oscuro.
- **Tarjetas y áreas elevadas:** use el token de superficie, con su superficie hover y borde.
- **Acciones primarias:** use el gradiente de marca o el rol primario. Mantenga texto azul marino
  profundo sobre botones cyan claro.
- **Enlaces y navegación activa:** use la jerarquía primario/Sky, con un hover distinguible.
- **Código:** use el fondo específico de código, no una superficie genérica de tarjeta.
- **Foco y selección:** conserve el tratamiento cyan claro para que usuarios de teclado ubiquen su
  posición.

## Gradientes

Reserve los gradientes para momentos de marca destacados, como hero y llamados a la acción
primarios.

```css
/* Marca */
linear-gradient(135deg, #60E0F9 0%, #07C4F9 45%, #01A5F7 100%)

/* Encabezado profundo */
linear-gradient(135deg, #60E0F9 0%, #01A5F7 45%, #075A92 100%)

/* Tema oscuro */
linear-gradient(135deg, #031C36 0%, #06345F 45%, #01A5F7 100%)
```

## Estados semánticos

No use azul para todos los significados. Reserve colores semánticos para el estado y cyan Alisio
para información.

| Estado | Valor | Ejemplo |
| --- | --- | --- |
| Éxito | `#22C78A` | Herramienta completada |
| Advertencia | `#F5B942` | Permiso requerido |
| Error | `#F05D6C` | Herramienta falló |
| Información | `#07C4F9` | Información |
| Foco | `#60E0F9` | Foco de teclado |

## Accesibilidad y recursos

- Mantenga el texto en los roles de texto del tema y el foco visible; pruebe el contraste al crear o
  cambiar un token.
- No comunique un estado solo con color: acompáñelo con texto claro y, cuando ayude, un icono.
- Respete la preferencia de movimiento reducido. El video o la animación decorativa debe pausarse o
  ofrecer una alternativa visual estática.
- Use recursos responsivos con tamaño intrínseco explícito o contenedor estable. Los videos deben
  tener poster; las imágenes significativas, texto alternativo útil; evite texto incrustado en arte
  decorativo.

## Qué hacer y qué evitar

**Haga** de `#01A5F7` el primario claro, de `#07C4F9` el acento y de `#60E0F9` el highlight. Use
la jerarquía oscura sobre superficies Midnight.

**Evite** fondos claros azul saturado, negro puro como fondo oscuro y azul de marca en lugar de
estados semánticos de éxito, advertencia y error.
