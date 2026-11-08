/**
 * Texts of the Project settings dialog. They live with the dialog (a lazy chunk), not in
 * `i18n/en.ts`: the always-loaded dictionary has a size budget. Same locale signal and `{name}`
 * placeholders as `t()`; EN and ES keep the same keys.
 */
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  title: "Project settings",
  close: "Close",
  nameLabel: "Name",
  nameHint: "Only the name shown in Alisio. The folder on disk is never renamed.",
  save: "Save",
  saving: "Saving…",
  saved: "Name saved.",
  tooLong: "The name can have at most 200 characters.",
  folder: "Folder",
  folderName: "Folder name",
  path: "Full path",
  copyPath: "Copy path",
  colorLabel: "Color",
  missing: "This folder no longer exists on disk. Its sessions stay readable.",
  pinned: "Pinned",
  pinnedHint: "Keep this project at the top of the list.",
  trusted: "Trusted project",
  trustedHint:
    "Trusted projects load their configuration, plugins, agents, skills and prompts. You are asked to confirm.",
  trustUntrusted: "Not trusted",
  trustGranted: "Trusted",
  archived: "Archived",
  archivedHint:
    "Archived projects are hidden from the list and cannot start new sessions; their sessions stay readable.",
} as const;

const es: Record<keyof typeof en, string> = {
  title: "Ajustes del proyecto",
  close: "Cerrar",
  nameLabel: "Nombre",
  nameHint: "Solo el nombre que se muestra en Alisio. La carpeta en el disco nunca se renombra.",
  save: "Guardar",
  saving: "Guardando…",
  saved: "Nombre guardado.",
  tooLong: "El nombre puede tener como máximo 200 caracteres.",
  folder: "Carpeta",
  folderName: "Nombre de la carpeta",
  path: "Ruta completa",
  copyPath: "Copiar ruta",
  colorLabel: "Color",
  missing: "Esta carpeta ya no existe en el disco. Sus sesiones siguen visibles.",
  pinned: "Fijado",
  pinnedHint: "Mantén este proyecto al inicio de la lista.",
  trusted: "Proyecto de confianza",
  trustedHint:
    "Los proyectos de confianza cargan su configuración, complementos, agentes, skills y prompts. Se te pide confirmar.",
  trustUntrusted: "Sin confianza",
  trustGranted: "De confianza",
  archived: "Archivado",
  archivedHint:
    "Los proyectos archivados se ocultan de la lista y no pueden crear sesiones nuevas; sus sesiones siguen visibles.",
};

export const projectStrings = { en, es };

export type ProjectStringKey = keyof typeof en;

/** Translates a dialog text in the active locale. */
export const ps = (key: ProjectStringKey, vars?: Record<string, string | number>): string =>
  format(projectStrings[locale.value === "es" ? "es" : "en"][key], vars);
