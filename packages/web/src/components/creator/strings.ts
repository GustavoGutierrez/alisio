/**
 * Texts of the plugin creator page. They live with the page (a lazy chunk), not in `i18n/en.ts`:
 * the always-loaded dictionary has a size budget. Same locale signal and `{name}` placeholders as
 * `t()`; English and Spanish keep the same keys (checked by a test). Plain words for people who do
 * not program: "checks" instead of "tests", "add-on" next to "plugin".
 */
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  title: "Plugin creator",
  lead: "Describe a task you repeat and Alisio builds a small add-on (a plugin) that does it for you. It writes the plugin, checks it automatically and you decide when to install it.",
  back: "Back to chat",
  readOnly:
    "Alisio is running in read-only mode, so plugins cannot be created, built, installed or deleted here. You can still look at the ones you have.",

  // How it works
  howTitle: "How it works",
  how1Title: "Describe",
  how1Body: "Tell Alisio, in your own words, what you need.",
  how2Title: "Alisio builds and checks it",
  how2Body: "It writes the plugin and runs automatic checks to make sure it works.",
  how3Title: "You install it",
  how3Body: "When it is ready, install it with one click and use it in your chats.",

  // New request
  newTitle: "Create a new plugin",
  requestLabel: "What should the plugin do?",
  requestPlaceholder:
    "For example: take my students' grades from a spreadsheet and make a report card PDF for each one.",
  tipsTitle: "Tips for a good result",
  tip1: "Say what goes in (a file, a table, some text) and what should come out.",
  tip2: "Give one real example if you can.",
  tip3: "Start small: you can ask for changes later.",
  requestEmpty: "Describe what the plugin should do first.",
  requestTooLong: "The description can have at most {max} characters.",
  modelLabel: "Model",
  modelDefault: "Default model",
  modelHint: "The AI model that writes the plugin.",
  modelsLoading: "Loading models…",
  modelMissing: "That model is not configured anymore. Choose another one.",
  create: "Create plugin",
  creating: "Starting…",
  examplesTitle: "Try one of these",
  example1: "Convert grades to a report card PDF",
  example2: "Track monthly expenses in a table",
  example3: "Summarize a folder of documents",

  // List
  listTitle: "My plugins",
  listLoading: "Loading your plugins…",
  listFailed: "Your plugins could not be loaded: {message}",
  emptyTitle: "No plugins yet",
  emptyBody: "Your first plugin is one sentence away. Pick an example or write your own idea.",
  newPlugin: "New plugin",
  version: "Version {version}",
  badgeBuilding: "Building",
  badgeInstalled: "Installed",
  badgeUpdate: "Update available",
  badgeNotInstalled: "Not installed",
  badgeFailed: "Could not start",

  // Build view
  buildTitle: "Building “{name}”",
  stepsLabel: "Progress",
  step_plan: "Plan",
  step_tests: "Write checks",
  step_code: "Write the plugin",
  step_run_tests: "Run checks",
  step_package: "Package",
  stepPending: "Waiting",
  stepRunning: "In progress",
  stepDone: "Done",
  stepFailed: "Needs attention",
  elapsed: "Time: {time}",
  working: "Alisio is working on your plugin…",
  waitingApproval: "Alisio is waiting for your permission.",
  idle: "Alisio has finished for now.",
  feedTitle: "What Alisio is doing",
  feedEmpty: "Alisio's messages will appear here.",
  showDetails: "Show technical details",
  hideDetails: "Hide technical details",
  approvalTitle: "Alisio needs your permission",
  approvalExplain:
    "To check the plugin, Alisio needs to run it on this computer. Allow it if you trust the request; Deny stops this step.",
  replyLabel: "Reply to Alisio",
  replyPlaceholder: "Answer a question or add a detail…",
  send: "Send",
  stop: "Stop",
  stopped: "Stopped.",
  runFailed: "Something went wrong while building the plugin.",
  tryAgain: "Try again",
  tryAgainPrompt:
    "Please continue building the plugin. Fix what failed, run the checks again and package it.",
  sessionFailed: "Alisio could not start: {message}",

  // Detail
  detailLoading: "Loading the plugin…",
  tabOverview: "Overview",
  tabStats: "Stats",
  tabFiles: "Files",
  tabDatabase: "Data",
  tabsLabel: "Plugin sections",
  statusTitle: "Status",
  statusNotInstalled: "Not installed yet. Build it, then install it to use it in your chats.",
  statusInstalled: "Installed (version {version}) and ready to use in your chats.",
  statusUpdate:
    "Version {installed} is installed. A newer version ({version}) is ready: update to use it.",
  packageReady: "Package ready",
  packageNotReady: "Needs a new build",
  descriptionTitle: "What it does",
  historyTitle: "Request history",
  historyCreate: "First request",
  historyModify: "Change",
  noBuild: "This plugin has not been built yet. Use “Build and check” to try it.",

  // Stats
  statsGeneration: "Time to create",
  statsBuild: "Last build took",
  statsFiles: "Files",
  statsSize: "Total size",
  statsPackage: "Package size",
  statsPassed: "Checks passed",
  statsFailed: "Checks failed",
  statsWhen: "Last build: {when}",
  statsNone: "No numbers yet: build the plugin first.",

  // Files
  filesLoading: "Loading files…",
  filesFailed: "The files could not be loaded: {message}",
  filesSummary: "{count} files · {size}",
  filesPick: "Choose a file to see its content.",
  fileBinary: "This is not a text file, so it cannot be shown here ({size}).",
  fileTruncated: "Only the beginning of this large file is shown.",
  fileLoading: "Opening…",
  readOnlyView: "Read only",
  filesLabel: "Plugin files",

  // Database
  dbLead:
    "This plugin keeps its information in tables. Each box is a table; lines show how they are connected.",
  dbPk: "Key",
  dbFk: "Link to {table}",
  dbFkLegend: "Link to another table",
  dbTable: "Table {name}",
  dbColumns: "Columns of {name}",
  dbColumn: "Column",
  dbType: "Type",
  dbNotes: "Notes",
  dbRequired: "Required",
  dbListView: "Show as a list",
  dbDiagramView: "Show as a diagram",
  dbDiagram: "Diagram of the plugin's tables",

  // Actions
  actionsLabel: "Plugin actions",
  build: "Build and check",
  building: "Checking…",
  install: "Install and enable",
  update: "Update",
  modify: "Ask for changes",
  download: "Download",
  share: "Share",
  delete: "Delete",
  buildOk: "The plugin passed every check and is ready to install.",
  buildFailedTests: "{failed} of {total} checks failed. Ask Alisio to fix them.",
  buildFailedInvalid: "The plugin has problems that must be fixed before installing:",
  buildFixWithAlisio: "Ask Alisio to fix it",
  fixPrompt:
    "The build found these problems. Please fix them, run the checks again and package the plugin:\n{list}",
  busy: "This plugin is busy with another task. Wait a moment and try again.",
  notBuilt: "Build the plugin first.",
  notFound: "This plugin no longer exists.",

  // Modify
  modifyTitle: "Ask for changes",
  modifyLabel: "What should change?",
  modifyPlaceholder: "For example: also add the class average at the end of each report.",
  modifySend: "Send changes",
  cancel: "Cancel",

  // Install
  installTitle: "Install “{name}”?",
  installBody:
    "Installing adds this plugin to Alisio so you can use it in your chats. It runs on this computer with your permissions, like any program you install.",
  installBody2: "You can turn it off or remove it later in Settings → Plugins.",
  installConfirm: "Install and enable",
  updateTitle: "Update “{name}”?",
  updateBody: "Alisio replaces the installed version with the new one. Your plugin data is kept.",
  updateConfirm: "Update",
  installing: "Installing…",
  installDone: "“{name}” is installed and enabled.",
  installDoneRestart: "“{name}” is installed. Restart Alisio to start using it.",
  installEnableFailed: "“{name}” is installed but could not be turned on: {message}",
  installFailed: "The plugin could not be installed: {message}",
  installNeedsBuild:
    "Build and check it first: only a plugin that passed every check can be installed.",
  installActivationFailed: "“{name}” could not start, so Alisio undid the install.",
  activationTitle: "Installed but it could not start",
  activationBody:
    "The plugin is installed, but Alisio could not start it, so its tools are not available. Alisio can read the reason and fix it.",
  activationRolledBackTitle: "It could not start, so Alisio undid the install",
  activationRolledBackBody:
    "Nothing changed in your Alisio: the previous version, if there was one, is still in place. Alisio can read the reason and fix it.",
  activationReason: "Show the reason",
  activationFix: "Ask Alisio to fix it",
  activationFixPrompt:
    "The plugin was installed but Alisio could not start it. Alisio said: {message}\nPlease fix the cause, run the checks again and build the plugin.",
  lastBuildFailedTitle: "The last check found problems that must be fixed before installing.",
  gaveUpTitle: "Alisio could not finish this plugin",
  gaveUpBody:
    "It tried several times and some checks still fail. Try again and Alisio starts over from these problems.",
  retryPrompt:
    "Try again: the last builds failed with these problems. Fix them, run the checks and build the plugin:\n{list}",

  // Download
  downloadHint:
    "The download is a .tgz file. Anyone can install it in Alisio from Settings → Plugins → Install from file.",
  downloadStarted: "Download started.",

  // Delete
  deleteTitle: "Delete “{name}”?",
  deleteBody:
    "This removes the plugin's files and its history from the plugin creator. It cannot be undone.",
  deleteUninstall: "Also uninstall it from Alisio",
  deleteUninstallHint:
    "Leave this unchecked to keep using the installed plugin; it just will not appear here anymore.",
  deleteConfirm: "Delete",
  deleted: "“{name}” was deleted.",
  deletedRestart: "“{name}” was deleted. Restart Alisio to finish removing it.",

  // Share
  shareTitle: "Share your plugin",
  shareLead: "Made something useful? Other people with Alisio can use it too.",
  sharePrivateTitle: "Share privately",
  sharePrivate1: "Download the plugin file (.tgz).",
  sharePrivate2: "Send it by e-mail, chat or a USB drive.",
  sharePrivate3: "The other person opens Settings → Plugins → Install from file and picks it.",
  shareNpmTitle: "Share with everyone on npm",
  shareNpmLead:
    "npm is a free public library of add-ons. Publishing there lets anyone install your plugin by its name.",
  shareNpm1: "Create a free account at npmjs.com.",
  shareNpm2: "Open a terminal and sign in:",
  shareNpm3: "Go to the plugin folder:",
  shareNpm4: "Publish it:",
  shareNpm5: "To publish an update later, raise the version and publish again:",
  shareFolder: "Plugin folder",
  shareCatalogTitle: "Get it into the Alisio catalog",
  shareCatalog:
    "Want everyone to find it in Settings → Plugins → Catalog? Send the npm link of your plugin to the Alisio developer:",
  shareEncourage: "Sharing a plugin that saves you time can save time for many people too.",
  copy: "Copy",
  copied: "Copied",
  close: "Close",
};

const es: typeof en = {
  title: "Creador de complementos",
  lead: "Describe una tarea que repites y Alisio crea un pequeño complemento que la hace por ti. Escribe el complemento, lo comprueba automáticamente y tú decides cuándo instalarlo.",
  back: "Volver al chat",
  readOnly:
    "Alisio está en modo de solo lectura, así que aquí no se pueden crear, preparar, instalar ni eliminar complementos. Puedes seguir viendo los que tienes.",

  howTitle: "Cómo funciona",
  how1Title: "Describe",
  how1Body: "Cuéntale a Alisio, con tus palabras, lo que necesitas.",
  how2Title: "Alisio lo crea y lo comprueba",
  how2Body:
    "Escribe el complemento y hace comprobaciones automáticas para asegurarse de que funciona.",
  how3Title: "Tú lo instalas",
  how3Body: "Cuando esté listo, instálalo con un clic y úsalo en tus chats.",

  newTitle: "Crear un complemento nuevo",
  requestLabel: "¿Qué debe hacer el complemento?",
  requestPlaceholder:
    "Por ejemplo: tomar las notas de mis estudiantes de una hoja de cálculo y hacer un boletín en PDF para cada uno.",
  tipsTitle: "Consejos para un buen resultado",
  tip1: "Di qué entra (un archivo, una tabla, un texto) y qué debe salir.",
  tip2: "Da un ejemplo real si puedes.",
  tip3: "Empieza por algo pequeño: luego puedes pedir cambios.",
  requestEmpty: "Primero describe qué debe hacer el complemento.",
  requestTooLong: "La descripción puede tener como máximo {max} caracteres.",
  modelLabel: "Modelo",
  modelDefault: "Modelo predeterminado",
  modelHint: "El modelo de IA que escribe el complemento.",
  modelsLoading: "Cargando modelos…",
  modelMissing: "Ese modelo ya no está configurado. Elige otro.",
  create: "Crear complemento",
  creating: "Empezando…",
  examplesTitle: "Prueba con uno de estos",
  example1: "Convertir notas en un boletín en PDF",
  example2: "Llevar los gastos del mes en una tabla",
  example3: "Resumir una carpeta de documentos",

  listTitle: "Mis complementos",
  listLoading: "Cargando tus complementos…",
  listFailed: "No se pudieron cargar tus complementos: {message}",
  emptyTitle: "Aún no tienes complementos",
  emptyBody:
    "Tu primer complemento está a una frase de distancia. Elige un ejemplo o escribe tu propia idea.",
  newPlugin: "Nuevo complemento",
  version: "Versión {version}",
  badgeBuilding: "Creándose",
  badgeInstalled: "Instalado",
  badgeUpdate: "Actualización disponible",
  badgeNotInstalled: "Sin instalar",
  badgeFailed: "No pudo iniciarse",

  buildTitle: "Creando «{name}»",
  stepsLabel: "Progreso",
  step_plan: "Planear",
  step_tests: "Escribir comprobaciones",
  step_code: "Escribir el complemento",
  step_run_tests: "Hacer las comprobaciones",
  step_package: "Empaquetar",
  stepPending: "En espera",
  stepRunning: "En curso",
  stepDone: "Hecho",
  stepFailed: "Requiere atención",
  elapsed: "Tiempo: {time}",
  working: "Alisio está trabajando en tu complemento…",
  waitingApproval: "Alisio espera tu permiso.",
  idle: "Alisio ha terminado por ahora.",
  feedTitle: "Lo que está haciendo Alisio",
  feedEmpty: "Aquí aparecerán los mensajes de Alisio.",
  showDetails: "Mostrar detalles técnicos",
  hideDetails: "Ocultar detalles técnicos",
  approvalTitle: "Alisio necesita tu permiso",
  approvalExplain:
    "Para comprobar el complemento, Alisio necesita ejecutarlo en este equipo. Permítelo si confías en la petición; Denegar detiene este paso.",
  replyLabel: "Responder a Alisio",
  replyPlaceholder: "Responde una pregunta o añade un detalle…",
  send: "Enviar",
  stop: "Detener",
  stopped: "Detenido.",
  runFailed: "Algo salió mal al crear el complemento.",
  tryAgain: "Intentar de nuevo",
  tryAgainPrompt:
    "Por favor, continúa creando el complemento. Corrige lo que falló, vuelve a hacer las comprobaciones y empaquétalo.",
  sessionFailed: "Alisio no pudo empezar: {message}",

  detailLoading: "Cargando el complemento…",
  tabOverview: "Resumen",
  tabStats: "Estadísticas",
  tabFiles: "Archivos",
  tabDatabase: "Datos",
  tabsLabel: "Secciones del complemento",
  statusTitle: "Estado",
  statusNotInstalled:
    "Aún no está instalado. Prepáralo y luego instálalo para usarlo en tus chats.",
  statusInstalled: "Instalado (versión {version}) y listo para usar en tus chats.",
  statusUpdate:
    "La versión {installed} está instalada. Hay una versión más nueva ({version}) lista: actualiza para usarla.",
  packageReady: "Paquete listo",
  packageNotReady: "Necesita prepararse de nuevo",
  descriptionTitle: "Qué hace",
  historyTitle: "Historial de peticiones",
  historyCreate: "Primera petición",
  historyModify: "Cambio",
  noBuild: "Este complemento aún no se ha preparado. Usa «Preparar y comprobar» para probarlo.",

  statsGeneration: "Tiempo de creación",
  statsBuild: "La última preparación tardó",
  statsFiles: "Archivos",
  statsSize: "Tamaño total",
  statsPackage: "Tamaño del paquete",
  statsPassed: "Comprobaciones superadas",
  statsFailed: "Comprobaciones fallidas",
  statsWhen: "Última preparación: {when}",
  statsNone: "Aún no hay cifras: primero prepara el complemento.",

  filesLoading: "Cargando archivos…",
  filesFailed: "No se pudieron cargar los archivos: {message}",
  filesSummary: "{count} archivos · {size}",
  filesPick: "Elige un archivo para ver su contenido.",
  fileBinary: "No es un archivo de texto, así que no se puede mostrar aquí ({size}).",
  fileTruncated: "Solo se muestra el principio de este archivo grande.",
  fileLoading: "Abriendo…",
  readOnlyView: "Solo lectura",
  filesLabel: "Archivos del complemento",

  dbLead:
    "Este complemento guarda su información en tablas. Cada caja es una tabla; las líneas muestran cómo se conectan.",
  dbPk: "Clave",
  dbFk: "Enlace a {table}",
  dbFkLegend: "Enlace a otra tabla",
  dbTable: "Tabla {name}",
  dbColumns: "Columnas de {name}",
  dbColumn: "Columna",
  dbType: "Tipo",
  dbNotes: "Notas",
  dbRequired: "Obligatoria",
  dbListView: "Ver como lista",
  dbDiagramView: "Ver como diagrama",
  dbDiagram: "Diagrama de las tablas del complemento",

  actionsLabel: "Acciones del complemento",
  build: "Preparar y comprobar",
  building: "Comprobando…",
  install: "Instalar y activar",
  update: "Actualizar",
  modify: "Pedir cambios",
  download: "Descargar",
  share: "Compartir",
  delete: "Eliminar",
  buildOk: "El complemento superó todas las comprobaciones y está listo para instalar.",
  buildFailedTests: "Fallaron {failed} de {total} comprobaciones. Pídele a Alisio que las corrija.",
  buildFailedInvalid: "El complemento tiene problemas que hay que corregir antes de instalarlo:",
  buildFixWithAlisio: "Pedir a Alisio que lo corrija",
  fixPrompt:
    "La preparación encontró estos problemas. Corrígelos, vuelve a hacer las comprobaciones y empaqueta el complemento:\n{list}",
  busy: "Este complemento está ocupado con otra tarea. Espera un momento e inténtalo de nuevo.",
  notBuilt: "Primero prepara el complemento.",
  notFound: "Este complemento ya no existe.",

  modifyTitle: "Pedir cambios",
  modifyLabel: "¿Qué debe cambiar?",
  modifyPlaceholder: "Por ejemplo: añade también la media de la clase al final de cada boletín.",
  modifySend: "Enviar cambios",
  cancel: "Cancelar",

  installTitle: "¿Instalar «{name}»?",
  installBody:
    "Instalar añade este complemento a Alisio para que puedas usarlo en tus chats. Se ejecuta en este equipo con tus permisos, como cualquier programa que instalas.",
  installBody2: "Puedes desactivarlo o quitarlo más tarde en Ajustes → Complementos.",
  installConfirm: "Instalar y activar",
  updateTitle: "¿Actualizar «{name}»?",
  updateBody:
    "Alisio sustituye la versión instalada por la nueva. Los datos del complemento se conservan.",
  updateConfirm: "Actualizar",
  installing: "Instalando…",
  installDone: "«{name}» está instalado y activado.",
  installDoneRestart: "«{name}» está instalado. Reinicia Alisio para empezar a usarlo.",
  installEnableFailed: "«{name}» está instalado pero no se pudo activar: {message}",
  installFailed: "No se pudo instalar el complemento: {message}",
  installNeedsBuild:
    "Primero compílalo y compruébalo: solo se puede instalar un complemento que pasó todas las comprobaciones.",
  installActivationFailed: "«{name}» no pudo iniciarse, así que Alisio deshizo la instalación.",
  activationTitle: "Instalado, pero no pudo iniciarse",
  activationBody:
    "El complemento está instalado, pero Alisio no pudo iniciarlo, así que sus herramientas no están disponibles. Alisio puede leer el motivo y corregirlo.",
  activationRolledBackTitle: "No pudo iniciarse, así que Alisio deshizo la instalación",
  activationRolledBackBody:
    "Tu Alisio no cambió: la versión anterior, si la había, sigue instalada. Alisio puede leer el motivo y corregirlo.",
  activationReason: "Ver el motivo",
  activationFix: "Pedir a Alisio que lo corrija",
  activationFixPrompt:
    "El complemento se instaló pero Alisio no pudo iniciarlo. Alisio dijo: {message}\nCorrige la causa, vuelve a ejecutar las comprobaciones y compila el complemento.",
  lastBuildFailedTitle:
    "La última comprobación encontró problemas que hay que corregir antes de instalar.",
  gaveUpTitle: "Alisio no pudo terminar este complemento",
  gaveUpBody:
    "Lo intentó varias veces y algunas comprobaciones siguen fallando. Inténtalo de nuevo y Alisio empezará desde estos problemas.",
  retryPrompt:
    "Inténtalo de nuevo: las últimas compilaciones fallaron con estos problemas. Corrígelos, ejecuta las comprobaciones y compila el complemento:\n{list}",

  downloadHint:
    "La descarga es un archivo .tgz. Cualquiera puede instalarlo en Alisio desde Ajustes → Complementos → Instalar desde archivo.",
  downloadStarted: "Descarga iniciada.",

  deleteTitle: "¿Eliminar «{name}»?",
  deleteBody:
    "Esto borra los archivos del complemento y su historial del creador. No se puede deshacer.",
  deleteUninstall: "Desinstalarlo también de Alisio",
  deleteUninstallHint:
    "Déjalo sin marcar para seguir usando el complemento instalado; solo dejará de aparecer aquí.",
  deleteConfirm: "Eliminar",
  deleted: "«{name}» se eliminó.",
  deletedRestart: "«{name}» se eliminó. Reinicia Alisio para terminar de quitarlo.",

  shareTitle: "Comparte tu complemento",
  shareLead: "¿Hiciste algo útil? Otras personas con Alisio también pueden usarlo.",
  sharePrivateTitle: "Compartir en privado",
  sharePrivate1: "Descarga el archivo del complemento (.tgz).",
  sharePrivate2: "Envíalo por correo, chat o una memoria USB.",
  sharePrivate3: "La otra persona abre Ajustes → Complementos → Instalar desde archivo y lo elige.",
  shareNpmTitle: "Compartir con todos en npm",
  shareNpmLead:
    "npm es una biblioteca pública y gratuita de complementos. Publicar allí permite que cualquiera instale tu complemento por su nombre.",
  shareNpm1: "Crea una cuenta gratuita en npmjs.com.",
  shareNpm2: "Abre una terminal e inicia sesión:",
  shareNpm3: "Ve a la carpeta del complemento:",
  shareNpm4: "Publícalo:",
  shareNpm5: "Para publicar una actualización, sube la versión y publica de nuevo:",
  shareFolder: "Carpeta del complemento",
  shareCatalogTitle: "Que aparezca en el catálogo de Alisio",
  shareCatalog:
    "¿Quieres que todos lo encuentren en Ajustes → Complementos → Catálogo? Envía el enlace de npm de tu complemento al desarrollador de Alisio:",
  shareEncourage:
    "Compartir un complemento que te ahorra tiempo también puede ahorrárselo a mucha gente.",
  copy: "Copiar",
  copied: "Copiado",
  close: "Cerrar",
};

/** Friendly text of each stable build finding code; unknown codes fall back to `genericIssue`. */
const issuesEn = {
  sdk_incompatible: "It was made for a different version of Alisio.",
  api_member_unknown: "It uses an Alisio feature that this version does not have.",
  api_version_invalid: "It declares an Alisio plugin version that is not supported.",
  svg_unsafe: "Its icon or cover image contains content that is not allowed.",
  asset_format: "Its icon or cover must be an SVG, PNG, WebP or JPEG image.",
  asset_missing: "Its icon or cover image is missing.",
  asset_outside: "Its icon or cover must be a file inside the plugin.",
  asset_not_packed: "Its icon or cover would be left out of the package.",
  asset_too_large: "Its icon or cover image is too large.",
  icon_missing: "It has no icon yet.",
  cover_missing: "It has no cover image yet.",
  too_many_files: "It has too many files.",
  project_too_large: "It is larger than 5 MB.",
  file_too_large: "One of its files is larger than 1 MB.",
  symlink_forbidden: "It contains a shortcut (symbolic link), which is not allowed.",
  package_json_invalid: "Its settings file (package.json) is not valid.",
  package_json_missing: "Its settings file (package.json) is missing.",
  name_invalid: "Its package name is not valid.",
  name_reserved: "Its name uses a scope reserved for official plugins.",
  version_invalid: "Its version number is not valid (it must look like 1.2.3).",
  version_mismatch: "Its version numbers do not match.",
  type_not_module: "Its settings file must declare a modern JavaScript module.",
  keyword_missing: "It is missing the keyword that marks it as an Alisio plugin.",
  description_missing: "It needs a one-sentence description.",
  dependencies_forbidden: "It depends on other packages, which is not allowed.",
  peer_sdk_missing: "It does not declare which Alisio version it works with.",
  peer_extra: "It declares extra requirements that are not allowed.",
  engine_unsupported: "It asks for a program version Alisio does not provide.",
  engine_unknown: "It mentions a program requirement that Alisio ignores.",
  lifecycle_scripts_forbidden: "It has install scripts, which are not allowed.",
  entry_missing: "Its main file is missing.",
  entry_outside: "Its main file must be inside the plugin.",
  entry_not_packed: "Its main file would be left out of the package.",
  tests_missing: "It has no automatic checks yet.",
  empty_file: "One of its files is empty.",
  template_example: "It still contains example code from the starting template.",
  forbidden_import: "It tries to use files from outside the plugin.",
  unused_file: "One of its files is not used.",
  registers_nothing: "It does not add anything to Alisio yet.",
  setup_missing: "It is missing its setup function.",
  setup_probe_failed: "It failed when Alisio tried to load it.",
  load_failed: "It could not be loaded.",
  plugin_id_invalid: "Its plugin id is not valid.",
  activation_failed: "Alisio could not start it.",
  syntax_error: "One of its files is not valid JavaScript.",
  typescript_source: "It contains TypeScript files; plugins ship plain JavaScript.",
  import_not_packed: "It uses a file that would be left out of the package.",
  tool_smoke_failed: "One of its tools failed when Alisio tried it.",
  dispose_failed: "It fails when Alisio closes it.",
  reactivate_failed: "It cannot be started a second time.",
  tool_untested: "One of its tools has no automatic check.",
  tests_too_few: "It needs at least one automatic check per tool.",
  app_missing:
    "You asked for its own screen in the Apps menu, but it does not have one yet. Press Try again so Alisio adds it.",
  app_html_failed: "Its screen in the Apps menu does not open. Press Try again so Alisio fixes it.",
  app_html_too_large:
    "Its screen in the Apps menu is too large to open. Press Try again so Alisio makes it smaller.",
  app_script_nonce_missing:
    "Part of its screen would not work, because Alisio blocks it for safety. Press Try again so Alisio fixes it.",
  app_external_resource:
    "Its screen tries to load files from outside the plugin, which Alisio does not allow. Press Try again so Alisio fixes it.",
  app_inline_handler:
    "Some buttons on its screen would do nothing, because Alisio blocks them for safety. Press Try again so Alisio fixes it.",
  app_action_failed:
    "Its screen failed when Alisio tried one of its buttons. Press Try again so Alisio fixes it.",
  app_action_untested:
    "Something its screen does has no automatic check. Press Try again so Alisio adds one.",
  app_dispose_failed:
    "Its screen stays open after Alisio closes the plugin. Press Try again so Alisio fixes it.",
  gate_unavailable:
    "Alisio could not run its safety checks on this computer, so it cannot install the plugin yet.",
  genericIssue: "There is a problem that needs fixing.",
};

const issuesEs: typeof issuesEn = {
  sdk_incompatible: "Se hizo para otra versión de Alisio.",
  api_member_unknown: "Usa una función de Alisio que esta versión no tiene.",
  api_version_invalid: "Declara una versión de complemento de Alisio que no es compatible.",
  svg_unsafe: "Su icono o portada contiene contenido no permitido.",
  asset_format: "Su icono o portada debe ser una imagen SVG, PNG, WebP o JPEG.",
  asset_missing: "Falta su icono o su portada.",
  asset_outside: "Su icono o portada debe ser un archivo dentro del complemento.",
  asset_not_packed: "Su icono o portada quedaría fuera del paquete.",
  asset_too_large: "Su icono o portada es demasiado grande.",
  icon_missing: "Aún no tiene icono.",
  cover_missing: "Aún no tiene portada.",
  too_many_files: "Tiene demasiados archivos.",
  project_too_large: "Ocupa más de 5 MB.",
  file_too_large: "Uno de sus archivos ocupa más de 1 MB.",
  symlink_forbidden: "Contiene un acceso directo (enlace simbólico), que no está permitido.",
  package_json_invalid: "Su archivo de configuración (package.json) no es válido.",
  package_json_missing: "Falta su archivo de configuración (package.json).",
  name_invalid: "Su nombre de paquete no es válido.",
  name_reserved: "Su nombre usa un ámbito reservado a los complementos oficiales.",
  version_invalid: "Su número de versión no es válido (debe ser como 1.2.3).",
  version_mismatch: "Sus números de versión no coinciden.",
  type_not_module: "Su archivo de configuración debe declarar un módulo JavaScript moderno.",
  keyword_missing: "Le falta la palabra clave que lo marca como complemento de Alisio.",
  description_missing: "Necesita una descripción de una frase.",
  dependencies_forbidden: "Depende de otros paquetes, y eso no está permitido.",
  peer_sdk_missing: "No declara con qué versión de Alisio funciona.",
  peer_extra: "Declara requisitos adicionales que no están permitidos.",
  engine_unsupported: "Pide una versión de programa que Alisio no ofrece.",
  engine_unknown: "Menciona un requisito de programa que Alisio ignora.",
  lifecycle_scripts_forbidden: "Tiene scripts de instalación, que no están permitidos.",
  entry_missing: "Falta su archivo principal.",
  entry_outside: "Su archivo principal debe estar dentro del complemento.",
  entry_not_packed: "Su archivo principal quedaría fuera del paquete.",
  tests_missing: "Aún no tiene comprobaciones automáticas.",
  empty_file: "Uno de sus archivos está vacío.",
  template_example: "Aún contiene código de ejemplo de la plantilla inicial.",
  forbidden_import: "Intenta usar archivos de fuera del complemento.",
  unused_file: "Uno de sus archivos no se usa.",
  registers_nothing: "Aún no añade nada a Alisio.",
  setup_missing: "Le falta su función de configuración.",
  setup_probe_failed: "Falló cuando Alisio intentó cargarlo.",
  load_failed: "No se pudo cargar.",
  plugin_id_invalid: "Su identificador de complemento no es válido.",
  activation_failed: "Alisio no pudo iniciarlo.",
  syntax_error: "Uno de sus archivos no es JavaScript válido.",
  typescript_source: "Contiene archivos TypeScript; los complementos se entregan en JavaScript.",
  import_not_packed: "Usa un archivo que quedaría fuera del paquete.",
  tool_smoke_failed: "Una de sus herramientas falló cuando Alisio la probó.",
  dispose_failed: "Falla cuando Alisio lo cierra.",
  reactivate_failed: "No se puede iniciar una segunda vez.",
  tool_untested: "Una de sus herramientas no tiene comprobación automática.",
  tests_too_few: "Necesita al menos una comprobación automática por herramienta.",
  app_missing:
    "Pediste una pantalla propia en el menú Aplicaciones, pero aún no la tiene. Pulsa Intentar de nuevo para que Alisio la añada.",
  app_html_failed:
    "Su pantalla del menú Aplicaciones no se abre. Pulsa Intentar de nuevo para que Alisio lo corrija.",
  app_html_too_large:
    "Su pantalla del menú Aplicaciones es demasiado grande para abrirse. Pulsa Intentar de nuevo para que Alisio la reduzca.",
  app_script_nonce_missing:
    "Una parte de su pantalla no funcionaría, porque Alisio la bloquea por seguridad. Pulsa Intentar de nuevo para que Alisio lo corrija.",
  app_external_resource:
    "Su pantalla intenta cargar archivos de fuera del complemento, y Alisio no lo permite. Pulsa Intentar de nuevo para que Alisio lo corrija.",
  app_inline_handler:
    "Algunos botones de su pantalla no harían nada, porque Alisio los bloquea por seguridad. Pulsa Intentar de nuevo para que Alisio lo corrija.",
  app_action_failed:
    "Su pantalla falló cuando Alisio probó uno de sus botones. Pulsa Intentar de nuevo para que Alisio lo corrija.",
  app_action_untested:
    "Algo que hace su pantalla no tiene comprobación automática. Pulsa Intentar de nuevo para que Alisio la añada.",
  app_dispose_failed:
    "Su pantalla sigue abierta después de que Alisio cierra el complemento. Pulsa Intentar de nuevo para que Alisio lo corrija.",
  gate_unavailable:
    "Alisio no pudo ejecutar sus comprobaciones de seguridad en este equipo, así que aún no puede instalar el complemento.",
  genericIssue: "Hay un problema que hay que corregir.",
};

export const creatorStrings = { en, es, issuesEn, issuesEs };
export type CrKey = keyof typeof en;
export type IssueKey = keyof typeof issuesEn;

/** Translates `key` in the current locale; reading the locale signal subscribes the component. */
export const cr = (key: CrKey, vars?: Record<string, string | number>): string =>
  format(creatorStrings[locale.value]?.[key] ?? en[key], vars);

/** Localized text of a build finding; unknown codes get the generic sentence. */
export function issueText(code: string): string {
  const table = locale.value === "es" ? issuesEs : issuesEn;
  return (
    (table as Record<string, string>)[code] ?? (table as Record<string, string>).genericIssue ?? ""
  );
}
