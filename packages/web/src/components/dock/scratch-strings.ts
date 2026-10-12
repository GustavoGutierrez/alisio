/**
 * Texts of the Scratch tab. They live with the tab (not in `i18n/en.ts`) so the always-loaded
 * dictionary stays small: this module is part of the tab's lazy chunk. Same locale signal and
 * `{name}` placeholders as `t()`; English and Spanish must keep the same keys.
 */
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  title: "Scratchpad",
  lead: "Work files the agent's scripts saved in this session. They are temporary and are removed after a while without use.",
  loading: "Loading…",
  loadFailed: "Couldn't load the scratchpad.",
  retry: "Retry",
  unavailable:
    "The scratchpad is off for this session. Turn on JavaScript in Settings → Forja, and check forge.scratch.enabled.",
  empty: "No files yet. Scripts can save intermediate work here.",
  files: "Files",
  quota: "{used} of {total} used",
  truncated: "Showing the first {count} files; the quota counts all of them.",
  modified: "Modified {time}",
  download: "Download {name}",
  back: "Back to files",
  noPreview: "No preview for this file type. Download it to open it.",
  previewFailed: "Couldn't load the file.",
  cancel: "Cancel",
  emptyAction: "Empty",
  confirm: "Delete all files from the scratchpad? This cannot be undone.",
  confirmAction: "Empty the scratchpad",
  cleared: "Scratchpad emptied: {removed} files, {size} freed.",
  runsActive: "A script is still running. Wait for it to finish, then empty the scratchpad.",
  readOnly: "The scratchpad can't be emptied while the server is read-only.",
  failed: "Couldn't empty the scratchpad: {error}",
  working: "Emptying…",
};
export type ScratchStringKey = keyof typeof en;

const es: Record<ScratchStringKey, string> = {
  title: "Scratchpad",
  lead: "Archivos de trabajo que los scripts del agente guardaron en esta sesión. Son temporales y se eliminan tras un tiempo sin uso.",
  loading: "Cargando…",
  loadFailed: "No se pudo cargar el scratchpad.",
  retry: "Reintentar",
  unavailable:
    "El scratchpad está desactivado en esta sesión. Activa JavaScript en Ajustes → Forja y revisa forge.scratch.enabled.",
  empty: "Aún no hay archivos. Los scripts pueden guardar aquí su trabajo intermedio.",
  files: "Archivos",
  quota: "{used} de {total} usados",
  truncated: "Se muestran los primeros {count} archivos; la cuota cuenta todos.",
  modified: "Modificado {time}",
  download: "Descargar {name}",
  back: "Volver a los archivos",
  noPreview: "No hay vista previa para este tipo de archivo. Descárgalo para abrirlo.",
  previewFailed: "No se pudo cargar el archivo.",
  cancel: "Cancelar",
  emptyAction: "Vaciar",
  confirm: "¿Eliminar todos los archivos del scratchpad? No se puede deshacer.",
  confirmAction: "Vaciar el scratchpad",
  cleared: "Scratchpad vaciado: {removed} archivos, {size} liberados.",
  runsActive: "Un script sigue en ejecución. Espera a que termine y vacía el scratchpad.",
  readOnly: "El scratchpad no se puede vaciar mientras el servidor está en solo lectura.",
  failed: "No se pudo vaciar el scratchpad: {error}",
  working: "Vaciando…",
};

export const scratchStrings = { en, es };

/** Translates a Scratch tab string in the current locale (reading the signal subscribes). */
export const sk = (key: ScratchStringKey, params?: Record<string, string | number>): string =>
  format(scratchStrings[locale.value][key] ?? en[key], params);
