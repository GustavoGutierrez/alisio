# Technical Specification: Plugin Apps — páginas completas de plugins en el área principal

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Origen | Especificación del owner del 2026-11-09 |
| Proyecto | Alisio |
| Estado | **Implementada y publicada en 0.11.5 (2026-11-09; commits `606aeb0` y `7dcb8ee`).** Archivada |
| Fecha | 2026-11-09 |
| Paquetes afectados | `@alisio/sdk` (aditivo: `PluginAPI.apps?`, tipos `PluginApp*`, `PLUGIN_APP_LIMITS`); `@alisio/core` (`src/plugins/apps.ts`, `plugins/host.ts`); `@alisio/server` (`routes/plugin-apps.ts`, códigos de error); `@alisio/web` (grupo Apps del panel, `components/apps/`, `store/plugin-apps*.ts`) |
| Paquetes nuevos | Ninguno. Ejemplo genérico en `examples/plugins/hello-app/` |
| Relación con otras especificaciones | Independiente. Reutiliza el patrón de vistas de plugin (`api.views`) |
| Superficies | Web (`alisio serve`) y Alisio Desktop. HTTP: tres rutas nuevas (§4) |
| Política de versión | Solo aditiva; el rango peer `@alisio/sdk >=0.9.0 <0.12.0` de los plugins sigue siendo válido |

**Desviaciones de la implementación respecto a este texto:** el grupo **Apps** va en el panel izquierdo justo encima de Proyectos (no bajo cada proyecto) y no se muestra si no hay apps registradas (decisión del owner, 2026-11-09). El iframe no tiene `allow-forms`: las apps usan botones o Enter en lugar de `<form>`. El CSP del frame añade la directiva `sandbox` para conservar el origen opaco si la URL se abre directamente. Pruebas: `tests/plugin-apps.test.ts`, `tests/server-plugin-apps.test.ts`, `tests/web-plugin-apps.test.ts`. Limitaciones en `docs/implementation-status.md` y `docs/limitations.md`.

## 1. Comportamiento obligatorio

Una página completa significa **todo el contenedor situado junto al panel de proyectos**, donde Alisio muestra normalmente la conversación. Al abrir una aplicación de plugin:

- El panel de proyectos de Alisio permanece disponible.
- El área principal muestra exclusivamente el layout del plugin: biblioteca, editor, formularios, paneles y herramientas que este defina.
- Se ocultan el encabezado del chat, sus mensajes, el input de conversación, las estadísticas y su panel derecho.
- La navegación del host ofrece volver al chat. Conserva la conversación, su borrador y los adjuntos pendientes.
- Cambiar entre chat y plugin conserva la instancia del editor y sus cambios sin guardar. Cambiar de proyecto usa otra instancia y otro contexto.
- En móvil, el botón Proyectos permite abrir la navegación existente de Alisio.

La interfaz se sirve desde el mismo servidor autenticado de Alisio y se monta en un iframe aislado dentro de su área principal. El iframe es un detalle de aislamiento de estilos y ejecución: no implica una ventana, pestaña, servidor o aplicación independiente. No se abre ninguna URL de loopback adicional.

## 2. Base inspeccionada y entrega

| Repositorio | Commit base |
|---|---|
| Alisio | `273dcc69dea72d8d276b358fdeaca6b31fa1442c` |
| Catálogo de plugins | `b860a7da8e1516f3b421a08c5dc86c99fea3d50f` |

El SDK original 0.11.4 contiene herramientas, comandos, modelos, sesiones, recursos, persistencia y vistas JSON de lectura. No contiene este registro de aplicaciones web. La entrega incorpora cambios reales en SDK, core, server y web, además de pruebas, y se publicó en Alisio 0.11.5.

## 3. Contrato implementado

Se añade `PluginAPI.apps?`. Es opcional para mantener compatibilidad de plugins antiguos. Una aplicación nueva comprueba su disponibilidad y explica que requiere el host actualizado si falta.

```ts
api.apps.register({
  id: 'studio',
  label: { en: 'Writing', es: 'Redacción' },
  html: () => loadPackagedHtml(),
  actions: {
    generate: {
      effect: 'write',
      inputSchema: { type: 'object' },
      handler: (input, context) => generate(input, context.sessionId),
    },
  },
  busy: () => hasBackgroundJobs(),
  dispose: () => cancelOwnedJobs(),
});
```

Las funciones del ejemplo pertenecen al plugin. `register` retorna una función de baja; el host también elimina el registro al cerrar el plugin o revertir un setup fallido. `dispose` es sincrónico e idempotente: inicia la cancelación y libera sus recursos. `busy` protege trabajos de la aplicación frente a la expulsión del workspace por inactividad.

Cada registro aporta una entrada al proyecto. Varias apps de un plugin tienen IDs distintos. Los IDs se delimitan por workspace, plugin y aplicación, evitando colisiones. El frontend puede construir su propia navegación interna y cualquier layout dentro de ese contenedor. La navegación opcional declarativa, el icono de entrada y el enrutamiento profundo son ampliaciones posteriores; no confundirlos con este contrato ya implementado.

`PluginAppContext` contiene `sessionId`, `workspace`, `signal` e `idempotencyKey?`. El servidor obtiene la sesión de la ruta autenticada; no acepta una identidad inventada en el input. El menú elige la sesión actual del proyecto o una existente; crea una si el proyecto aún no tiene sesiones. La instancia conserva esa sesión al alternar con otros chats.

## 4. Montaje y transporte

`PluginAppOutlet` se monta dentro de `main` en `packages/web/src/app.tsx`. El panel de proyectos permanece fuera de ese contenedor. El contenido del chat se conserva montado pero oculto e inaccesible mientras una app está activa; así se preservan también los adjuntos pendientes del composer. Los paneles de conversación laterales no se muestran durante la app.

| Ruta implementada | Función |
|---|---|
| GET `/api/workspaces/:wid/apps` | Catálogo de apps de plugins habilitados |
| GET `/api/sessions/:sid/apps/:plugin/:app/frame` | HTML autocontenido de la aplicación |
| POST `/api/sessions/:sid/apps/:plugin/:app/actions/:action` | Acción validada y autorizada |

No se añadieron servidores HTTP por plugin. Todas las rutas pasan por las guardas existentes de cookie, Host y Origin de Alisio. La comprobación de plugin habilitado se repite en cada acción.

El HTML usa scripts con `nonce="__ALISIO_NONCE__"`; el servidor sustituye ese marcador por un nonce aleatorio. El frame no recibe cookies, credenciales de proveedor ni acceso al DOM padre. El sandbox omite `allow-same-origin`. CSP permite solo conexiones blob para PDF.js y bloquea conexiones de red directas, navegación base y formularios. Se permiten recursos data/blob necesarios para assets y descargas. Los plugins backend siguen siendo código de confianza en proceso; el iframe no los convierte en un sandbox de Node.

Al cargar el iframe, el host transfiere un `MessagePort` exclusivamente a su `contentWindow`. El plugin acepta el primer canal procedente de `window.parent`. Los mensajes son:

```ts
// Host -> frame, con el MessagePort transferido
{ type: 'alisio.app.connect', locale: 'es', visible: true }
// Frame -> puerto del host
{ type: 'request', id: 'uuid', action: 'documents.list', input: {} }
// Host -> puerto del frame
{ type: 'response', id: 'uuid', result: /* resultado del handler */ }
// Actualizaciones del host
{ type: 'locale', locale: 'en' }
{ type: 'visibility', visible: false }
```

Errores del transporte se devuelven como códigos, sin volcar inputs ni secretos. El host permite ocho peticiones simultáneas por frame. El límite HTTP es 37 MiB de entrada, 90 MiB de resultado y 30 segundos por acción. Las acciones largas deben devolver un job rápidamente; no mantener una compilación o inferencia completa dentro de esa petición. El HTML tiene un límite de 8 MiB. Un timeout de Promise no detiene código CPU sin cooperación.

## 5. Permisos y modelos

Cada acción declara `read`, `write` o `process` y un esquema JSON de entrada. El core valida el esquema y consulta `decideEffect`, la misma decisión de efectos del host, con las capacidades efectivas de la sesión. Las acciones no concedidas se rechazan; esta primera versión no abre un diálogo de aprobación ad hoc ni amplía permisos automáticamente.

Los handlers reutilizan `api.models.list/resolve`, `api.model.complete` y `api.sessions.create/run/cancel`. No importan SDKs de proveedores ni solicitan claves separadas. Un input de prompt y un botón son componentes del plugin que invocan una acción; esta selecciona completado directo o ejecución del agente según su necesidad.

Para usar funciones de otros plugins, el agente hijo recibe una lista explícita de herramientas permitidas y pasa por el runner existente. Deben estar instaladas y disponibles en la sesión y respetar sus permisos. No se invocan handlers de otro plugin directamente ni se importan sus módulos.

## 6. Idioma y estado

La señal `locale` real de Alisio determina las etiquetas del menú y se envía al frame al abrir y en cada cambio. Scribe usa español o inglés sin un selector de idioma independiente. La lengua del manuscrito es un dato distinto y no cambia al traducir la interfaz.

El frame se conserva al volver al chat; conserva prompt, código, documento y selección. El frontend suspende su polling cuando está oculto. Los trabajos continúan en el backend. Recargar completamente Alisio recupera documentos y trabajos persistidos, pero no recupera texto que nunca se guardó; se advierte al salir cuando hay edición pendiente.

## 7. Ciclo de vida y límites

- Registro durante setup; inferencia solo después, en handlers.
- Rollback de registro si setup falla; validación de IDs y acciones.
- Estado y servicios de Scribe pertenecen a cada activación del plugin; no se comparten disposers globales entre workspaces.
- Deshabilitar un plugin bloquea inmediatamente nuevas acciones. El menú se refresca cada 15 segundos; el frame muestra indisponibilidad cuando recibe `not_found`.
- Cerrar el host o desregistrar cancela los controladores del plugin. La interrupción inmediata de trabajos ya iniciados al cambiar el estado habilitado necesita integración adicional con el mecanismo de desactivación del host.
- Los frames visitados permanecen en memoria hasta recargar la UI. Una política de expulsión con recuperación de buffers es una mejora posterior.
- Backend JSON atómico de Scribe: un proceso escritor por directorio de estado. No se presenta como almacenamiento multiproceso.

## 8. Extensiones futuras del contrato

Estas capacidades no son condición para ocupar el contenedor del chat, que ya está implementado en 0.11.5:

1. `navigation?: false`, iconos declarativos y rutas profundas con recuperación de estado.
2. API de jobs del host con SSE, cursores, reanudación e idempotencia durable entre reinicios.
3. Broker `services.register/discover/call` con esquemas, versiones, permisos efectivos por intersección, profundidad máxima y prevención de ciclos.
4. `model.stream?` con cancelación, uso y presupuestos compartidos; no simular deltas.
5. SDK de navegador distribuido, handles de archivos y descargas por streaming en lugar de base64.
6. Revocación inmediata de frames/puertos y cancelación coordinada al deshabilitar; gestión de frames inactivos.
7. Capacidades, tema y configuración genéricas de apps y compatibilidad de protocolo explícita.

Los contratos `contracts/*.proposed.*` representan ese objetivo ampliado. El contrato implementado es el de este documento y del SDK publicado; no instalar el manifiesto propuesto como si fuera necesario para Scribe 0.2.

## 9. Instalación y aceptación

Requiere Alisio 0.11.5 o posterior.

Aceptar únicamente si se verifica:

- Entrada de la app en el grupo Apps (encima de Proyectos) y panel de proyectos disponible.
- Área principal completamente ocupada por Scribe; chat, composer y dock ocultos.
- Volver al chat conserva borrador y adjuntos; reabrir Scribe conserva edición pendiente.
- ES/EN siguen la preferencia de Alisio, sin cambiar la lengua del documento.
- Dos proyectos no cruzan sesión, documentos ni permisos.
- Cookie, Host, Origin, validación y permisos rechazan llamadas no autorizadas.
- Registrar/desregistrar y rollback no dejan entradas residuales.
- Host antiguo informa incompatibilidad; no abre una UI independiente como alternativa.

Verificado con la batería de entrega completa y una ejecución real en Chromium contra `alisio serve` (capturas en `docs/assets/web-ui/plugin_apps_web_ui*.webp`). Solo se probó en Linux.

## Actualización de motor en Scribe 0.3

La instalación del plugin resuelve automáticamente la dependencia binaria por OS/CPU, mediante las optionalDependencies de node-tectonic. Es selección durante la instalación, no descarga de todos los binarios ni un comando del usuario. Los recursos TeX se incluyen para uso offline y PDF.js/worker se empaquetan localmente. El host permite `worker-src blob:` y `connect-src blob:` para el visor, sin acceso de red directo desde la UI. El motor nativo mantiene el permiso de procesos existente.
