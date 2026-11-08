/**
 * Texts of the Skill Builder window. They live with the window (a lazy chunk), not in
 * `i18n/en.ts`: the always-loaded dictionary has a size budget. Same locale signal and `{name}`
 * placeholders as `t()`; English and Spanish keep the same keys (checked by a test).
 */
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  title: "Skill Builder",
  close: "Close",
  maximize: "Maximize",
  restore: "Restore size",
  stepsLabel: "Progress",
  stepDescribe: "Describe",
  stepGenerate: "Generate",
  stepReview: "Review and save",

  // Describe
  lead: "Describe what the skill should do. Alisio drafts it in the open Agent Skills format, and you review and edit it before anything is saved.",
  ideaLabel: "What should the skill do?",
  ideaPlaceholder:
    "For example: turn a folder of receipts into a monthly expenses spreadsheet and flag duplicates.",
  ideaRequired: "Describe what the skill should do first.",
  ideaTooLong: "The description can have at most {max} characters.",
  moreOptions: "More options",
  whenLabel: "When should it be used?",
  whenHint: "Optional. Phrases or situations that should trigger the skill.",
  whenPlaceholder: "For example: “summarize my budget”, “build the monthly report”",
  saveTo: "Save to",
  scopeProject: "This project",
  scopeGlobal: "Global",
  scopeProjectHint: "Only in this project: {path}",
  scopeGlobalHint: "Available in every project: {path}",
  scopeNoProject: "Open a project to save skills inside it.",
  untrustedNote:
    "This project is not trusted, so project skills cannot be saved or loaded here. Save globally, or trust the project from its menu in the sidebar.",
  saveGlobally: "Save globally instead",
  includeLabel: "Include",
  includeHint: "Extra files the skill can ship with.",
  includeScripts: "Scripts",
  includeTemplates: "Templates and assets",
  includeReferences: "Reference documents",
  includeAuto: "Let the model decide",
  includeYes: "Yes",
  includeNo: "No",
  generateWith: "Generate with {model}",
  generate: "Generate",
  noModel: "No model is configured yet. Add a provider to let Alisio write the skill.",
  openModels: "Open Settings → Models",
  modelsLoading: "Checking the active model…",
  generateFailed: "The draft could not be generated: {message}",
  tryAgain: "Try again",

  // Generating
  generatingTitle: "Writing your skill",
  generatingLead: "This can take up to a minute. You can cancel at any time.",
  stageAnalyze: "Analyzing the idea",
  stageWrite: "Writing SKILL.md",
  stageFiles: "Preparing files",
  stageValidate: "Validating",
  stageActive: "In progress",
  stageDone: "Done",
  stagePending: "Waiting",
  stagesNote:
    "The model answers in one piece, so the first three steps are estimates. Validation runs on the real answer.",
  elapsed: "Elapsed {time}",
  cancel: "Cancel",
  cancelled: "Generation cancelled. Your description is kept.",

  // Review
  reviewTitle: "Review the draft",
  draftBy: "Drafted by {model}. Nothing is saved until you press Save.",
  nameLabel: "Name",
  nameHint: "Lowercase letters, digits and hyphens. It is also the folder name.",
  savesAs: "Saves to {path}",
  descriptionLabel: "Description",
  descriptionHint:
    "What the skill does and when to use it. Alisio reads this to decide when to load the skill.",
  descriptionCount: "{count} / {max}",
  bodyLabel: "SKILL.md instructions",
  bodyEdit: "Edit",
  bodyPreview: "Preview",
  bodyLines: "{count} lines",
  advanced: "Advanced",
  licenseLabel: "License",
  compatibilityLabel: "Compatibility",
  compatibilityHint:
    "Optional. Environment requirements, for example a program that must be installed.",
  filesTitle: "Extra files",
  filesNone: "This skill has no extra files.",
  filesNote: "Files are saved as plain text. Alisio never runs scripts when saving.",
  fileEdit: "View or edit",
  fileHide: "Hide",
  fileRemove: "Remove",
  fileRemoveNamed: "Remove {name}",
  fileEditNamed: "View or edit {name}",
  fileLines: "{lines} lines · {size}",
  fileContentLabel: "Contents of {name}",
  validationTitle: "Checks",
  errorsTitle: "Errors",
  errorsLead: "Fix these to save.",
  suggestionsTitle: "Suggestions",
  suggestionsLead: "You can save without these, but they make the skill work better.",
  allGood: "No problems found.",
  summaryOk: "Errors: 0. Suggestions: {warnings}.",
  summaryErrors: "Errors: {errors}. Suggestions: {warnings}.",
  regenerateTitle: "Ask for changes",
  feedbackLabel: "What should change?",
  feedbackPlaceholder: "For example: make it shorter, add a validation script",
  regenerate: "Regenerate",
  regenerateNote: "Regenerating replaces your edits with a new draft.",
  restorePrevious: "Restore previous version",
  back: "Back to description",
  save: "Save skill",
  saving: "Saving…",

  // Save problems
  overwriteTitle: "Replace the existing skill?",
  overwriteBody:
    "A skill named {name} already exists in this location. Replacing it deletes its current files.",
  overwriteConfirm: "Replace it",
  keepEditing: "Keep editing",
  untrustedSave:
    "This project is not trusted, so a project skill cannot be saved. Save it globally or trust the project first.",
  trustProject: "Trust this project",
  trustConfirm:
    "Trusted projects load their configuration, plugins, agents, skills and prompts. Trust this project?",
  readOnly: "Alisio is running read-only, so skills cannot be saved.",
  saveFailed: "The skill could not be saved: {message}",

  // Saved
  savedTitle: "Skill saved",
  savedAt: "Saved to {path}",
  savedActive: "It is active now. Ask Alisio for what it covers, or mention the skill by name.",
  savedPending: "{reason} It becomes active after a reload.",
  reloadNow: "Reload now",
  reloading: "Reloading…",
  reloaded: "Reloaded. The skill is active.",
  reloadFailed: "Reload failed: {message}",
  viewSkills: "View in Settings → Skills",
  createAnother: "Create another",
  done: "Done",
  unsavedLeave: "Discard the draft and your edits?",

  // Settings → Skills entry
  newSkill: "New skill",
} as const;

const es: Record<keyof typeof en, string> = {
  title: "Creador de skills",
  close: "Cerrar",
  maximize: "Maximizar",
  restore: "Restaurar tamaño",
  stepsLabel: "Progreso",
  stepDescribe: "Describir",
  stepGenerate: "Generar",
  stepReview: "Revisar y guardar",

  lead: "Describe qué debe hacer la skill. Alisio la redacta en el formato abierto Agent Skills y tú la revisas y editas antes de guardar nada.",
  ideaLabel: "¿Qué debe hacer la skill?",
  ideaPlaceholder:
    "Por ejemplo: convertir una carpeta de recibos en una hoja de cálculo de gastos mensuales y marcar los duplicados.",
  ideaRequired: "Primero describe qué debe hacer la skill.",
  ideaTooLong: "La descripción puede tener como máximo {max} caracteres.",
  moreOptions: "Más opciones",
  whenLabel: "¿Cuándo debe usarse?",
  whenHint: "Opcional. Frases o situaciones que deben activar la skill.",
  whenPlaceholder: "Por ejemplo: «resume mi presupuesto», «arma el informe mensual»",
  saveTo: "Guardar en",
  scopeProject: "Este proyecto",
  scopeGlobal: "Global",
  scopeProjectHint: "Solo en este proyecto: {path}",
  scopeGlobalHint: "Disponible en todos los proyectos: {path}",
  scopeNoProject: "Abre un proyecto para guardar skills dentro de él.",
  untrustedNote:
    "Este proyecto no es de confianza, así que aquí no se pueden guardar ni cargar skills de proyecto. Guarda la skill de forma global o confía en el proyecto desde su menú en la barra lateral.",
  saveGlobally: "Guardar de forma global",
  includeLabel: "Incluir",
  includeHint: "Archivos extra con los que puede venir la skill.",
  includeScripts: "Scripts",
  includeTemplates: "Plantillas y recursos",
  includeReferences: "Documentos de referencia",
  includeAuto: "Que decida el modelo",
  includeYes: "Sí",
  includeNo: "No",
  generateWith: "Generar con {model}",
  generate: "Generar",
  noModel:
    "Aún no hay un modelo configurado. Agrega un proveedor para que Alisio redacte la skill.",
  openModels: "Abrir Ajustes → Modelos",
  modelsLoading: "Comprobando el modelo activo…",
  generateFailed: "No se pudo generar el borrador: {message}",
  tryAgain: "Reintentar",

  generatingTitle: "Redactando tu skill",
  generatingLead: "Puede tardar hasta un minuto. Puedes cancelar en cualquier momento.",
  stageAnalyze: "Analizando la idea",
  stageWrite: "Escribiendo SKILL.md",
  stageFiles: "Preparando archivos",
  stageValidate: "Validando",
  stageActive: "En curso",
  stageDone: "Listo",
  stagePending: "En espera",
  stagesNote:
    "El modelo responde de una sola vez, así que los tres primeros pasos son estimaciones. La validación se hace sobre la respuesta real.",
  elapsed: "Transcurrido {time}",
  cancel: "Cancelar",
  cancelled: "Generación cancelada. Se conserva tu descripción.",

  reviewTitle: "Revisa el borrador",
  draftBy: "Redactado por {model}. No se guarda nada hasta que pulses Guardar.",
  nameLabel: "Nombre",
  nameHint: "Letras minúsculas, dígitos y guiones. También es el nombre de la carpeta.",
  savesAs: "Se guarda en {path}",
  descriptionLabel: "Descripción",
  descriptionHint:
    "Qué hace la skill y cuándo usarla. Alisio la lee para decidir cuándo cargar la skill.",
  descriptionCount: "{count} / {max}",
  bodyLabel: "Instrucciones de SKILL.md",
  bodyEdit: "Editar",
  bodyPreview: "Vista previa",
  bodyLines: "{count} líneas",
  advanced: "Avanzado",
  licenseLabel: "Licencia",
  compatibilityLabel: "Compatibilidad",
  compatibilityHint:
    "Opcional. Requisitos del entorno, por ejemplo un programa que debe estar instalado.",
  filesTitle: "Archivos extra",
  filesNone: "Esta skill no tiene archivos extra.",
  filesNote: "Los archivos se guardan como texto plano. Alisio nunca ejecuta scripts al guardar.",
  fileEdit: "Ver o editar",
  fileHide: "Ocultar",
  fileRemove: "Quitar",
  fileRemoveNamed: "Quitar {name}",
  fileEditNamed: "Ver o editar {name}",
  fileLines: "{lines} líneas · {size}",
  fileContentLabel: "Contenido de {name}",
  validationTitle: "Comprobaciones",
  errorsTitle: "Errores",
  errorsLead: "Corrígelos para poder guardar.",
  suggestionsTitle: "Sugerencias",
  suggestionsLead: "Puedes guardar sin ellas, pero mejoran el funcionamiento de la skill.",
  allGood: "No se encontraron problemas.",
  summaryOk: "Errores: 0. Sugerencias: {warnings}.",
  summaryErrors: "Errores: {errors}. Sugerencias: {warnings}.",
  regenerateTitle: "Pedir cambios",
  feedbackLabel: "¿Qué debe cambiar?",
  feedbackPlaceholder: "Por ejemplo: hazla más corta, agrega un script de validación",
  regenerate: "Regenerar",
  regenerateNote: "Regenerar reemplaza tus ediciones por un borrador nuevo.",
  restorePrevious: "Restaurar la versión anterior",
  back: "Volver a la descripción",
  save: "Guardar skill",
  saving: "Guardando…",

  overwriteTitle: "¿Reemplazar la skill existente?",
  overwriteBody:
    "Ya existe una skill llamada {name} en esta ubicación. Al reemplazarla se eliminan sus archivos actuales.",
  overwriteConfirm: "Reemplazarla",
  keepEditing: "Seguir editando",
  untrustedSave:
    "Este proyecto no es de confianza, así que no se puede guardar una skill de proyecto. Guárdala de forma global o confía primero en el proyecto.",
  trustProject: "Confiar en este proyecto",
  trustConfirm:
    "Los proyectos de confianza cargan su configuración, complementos, agentes, skills y prompts. ¿Confiar en este proyecto?",
  readOnly: "Alisio se ejecuta en modo solo lectura, así que no se pueden guardar skills.",
  saveFailed: "No se pudo guardar la skill: {message}",

  savedTitle: "Skill guardada",
  savedAt: "Guardada en {path}",
  savedActive: "Ya está activa. Pídele a Alisio lo que cubre, o menciona la skill por su nombre.",
  savedPending: "{reason} Se activará después de recargar.",
  reloadNow: "Recargar ahora",
  reloading: "Recargando…",
  reloaded: "Recargado. La skill está activa.",
  reloadFailed: "Falló la recarga: {message}",
  viewSkills: "Ver en Ajustes → Skills",
  createAnother: "Crear otra",
  done: "Listo",
  unsavedLeave: "¿Descartar el borrador y tus ediciones?",

  newSkill: "Nueva skill",
};

/** Validation findings by code (the SDK messages are English only). `{path}` is the file or link. */
const issuesEn = {
  "name-required": "The name is required.",
  "name-length": "The name can have at most 64 characters.",
  "name-format": "Use lowercase letters, digits and single hyphens, for example pdf-merger.",
  "name-reserved": "The name cannot contain “anthropic” or “claude”.",
  "name-vague": "Prefer a specific name; words like helper, utils or data are vague.",
  "name-collision": "A skill with this name already exists; one of them will shadow the other.",
  "description-required": "The description is required.",
  "description-length": "The description can have at most 1024 characters.",
  "description-xml": "The description cannot contain < or >.",
  "description-when": "Say when to use the skill, for example “Use when the user asks to …”.",
  "description-person":
    "Write the description in the third person; it is added to the system prompt.",
  "compatibility-length": "Compatibility must be text of at most 500 characters.",
  "license-length": "The license can have at most 200 characters.",
  "metadata-type": "Metadata must be short text values.",
  "body-required": "The SKILL.md instructions are empty.",
  "skill-size": "SKILL.md is too large (limit 64 KB). Move detail into reference files.",
  "body-long":
    "The instructions are long. Keep SKILL.md under 500 lines and move detail into reference files.",
  "time-sensitive": "Avoid wording tied to dates; it goes stale.",
  "backslash-path": "Use forward slashes in file paths, even for Windows.",
  "files-count": "A skill can have at most 20 extra files.",
  "file-path":
    "{path} is not an allowed path. Use scripts/, references/ or assets/ with simple names.",
  "file-duplicate": "{path} appears twice.",
  "file-size": "{path} is larger than 256 KB.",
  "file-binary": "{path} is not a text file.",
  "total-size": "The skill is larger than 1 MB in total.",
  "reference-toc": "{path} is long; add a table of contents.",
  "script-undocumented": "{path} has no documented usage or dependencies.",
  "reference-missing": "The instructions point to {path}, which is not one of the files.",
} as const;
const issuesEs: Record<keyof typeof issuesEn, string> = {
  "name-required": "El nombre es obligatorio.",
  "name-length": "El nombre puede tener como máximo 64 caracteres.",
  "name-format": "Usa letras minúsculas, dígitos y guiones simples, por ejemplo pdf-merger.",
  "name-reserved": "El nombre no puede contener «anthropic» ni «claude».",
  "name-vague": "Prefiere un nombre específico; palabras como helper, utils o data son vagas.",
  "name-collision": "Ya existe una skill con este nombre; una de las dos ocultará a la otra.",
  "description-required": "La descripción es obligatoria.",
  "description-length": "La descripción puede tener como máximo 1024 caracteres.",
  "description-xml": "La descripción no puede contener < ni >.",
  "description-when": "Indica cuándo usar la skill, por ejemplo «Úsala cuando el usuario pida …».",
  "description-person":
    "Escribe la descripción en tercera persona; se añade al prompt del sistema.",
  "compatibility-length": "La compatibilidad debe ser texto de máximo 500 caracteres.",
  "license-length": "La licencia puede tener como máximo 200 caracteres.",
  "metadata-type": "Los metadatos deben ser valores de texto cortos.",
  "body-required": "Las instrucciones de SKILL.md están vacías.",
  "skill-size":
    "SKILL.md es demasiado grande (límite 64 KB). Mueve el detalle a archivos de referencia.",
  "body-long":
    "Las instrucciones son largas. Mantén SKILL.md por debajo de 500 líneas y mueve el detalle a archivos de referencia.",
  "time-sensitive": "Evita redacciones atadas a fechas; quedan obsoletas.",
  "backslash-path": "Usa barras normales (/) en las rutas de archivo, también en Windows.",
  "files-count": "Una skill puede tener como máximo 20 archivos extra.",
  "file-path":
    "{path} no es una ruta permitida. Usa scripts/, references/ o assets/ con nombres simples.",
  "file-duplicate": "{path} aparece dos veces.",
  "file-size": "{path} pesa más de 256 KB.",
  "file-binary": "{path} no es un archivo de texto.",
  "total-size": "La skill pesa más de 1 MB en total.",
  "reference-toc": "{path} es largo; agrega una tabla de contenido.",
  "script-undocumented": "{path} no documenta su uso ni sus dependencias.",
  "reference-missing": "Las instrucciones apuntan a {path}, que no es uno de los archivos.",
};

export const skillBuilderStrings = { en, es, issuesEn, issuesEs };
export type SbKey = keyof typeof en;

/** Translates `key` in the current locale; reading the locale signal subscribes the component. */
export const sb = (key: SbKey, vars?: Record<string, string | number>): string =>
  format(skillBuilderStrings[locale.value]?.[key] ?? en[key], vars);

/** Localized text of a validation finding; unknown codes fall back to the SDK message. */
export function issueText(issue: { code: string; message: string; path?: string }): string {
  const table = locale.value === "es" ? issuesEs : issuesEn;
  const text = (table as Record<string, string>)[issue.code];
  return text ? format(text, { path: issue.path ?? "" }) : issue.message;
}
