/**
 * Texts of the Tasks tab. They live with the tab (not in `i18n/en.ts`) so the always-loaded
 * dictionary stays small: this module is part of the tab's lazy chunk. Same locale signal and
 * `{name}` placeholders as `t()`; English and Spanish must keep the same keys.
 */
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  title: "Background tasks",
  lead: "Commands the agent started with bg_run, and your subagents. They end when Alisio exits.",
  empty: "No background tasks in this session yet.",
  loading: "Loading…",
  loadFailed: "Couldn't load the tasks.",
  retry: "Retry",
  back: "Back to tasks",
  stop: "Stop",
  stopping: "Stopping…",
  stopFailed: "Couldn't stop the task: {error}",
  "status.queued": "Queued",
  "status.running": "Running",
  "status.stopping": "Stopping",
  "status.succeeded": "Succeeded",
  "status.failed": "Failed",
  "status.cancelled": "Stopped",
  "status.lost": "Lost",
  "kind.shell": "Command",
  "kind.subagent": "Subagent",
  command: "Command",
  directory: "Directory",
  time: "Duration",
  exit: "Exit code {code}",
  timeout: "Stopped by the time limit",
  stoppedBy: "Stopped by {who}",
  "who.user": "you",
  "who.model": "the agent",
  "who.timeout": "the time limit",
  "who.shutdown": "Alisio shutting down",
  lostHint: "Alisio was closed while this task ran: it did not survive the restart.",
  subagentHint: "Subagents are managed from the agents panel; this view only shows their status.",
  noOutput: "No output yet.",
  outputCut: "The stored log was cut at its size limit.",
  outputTrimmed: "Earlier output is not shown here.",
  finished: "Task “{label}” finished: {status}",
  bytes: "{size} KB",
};
export type TaskStringKey = keyof typeof en;

const es: Record<TaskStringKey, string> = {
  title: "Tareas en segundo plano",
  lead: "Comandos que el agente inició con bg_run, y tus subagentes. Terminan cuando Alisio se cierra.",
  empty: "Todavía no hay tareas en segundo plano en esta sesión.",
  loading: "Cargando…",
  loadFailed: "No se pudieron cargar las tareas.",
  retry: "Reintentar",
  back: "Volver a las tareas",
  stop: "Detener",
  stopping: "Deteniendo…",
  stopFailed: "No se pudo detener la tarea: {error}",
  "status.queued": "En cola",
  "status.running": "En ejecución",
  "status.stopping": "Deteniéndose",
  "status.succeeded": "Completada",
  "status.failed": "Fallida",
  "status.cancelled": "Detenida",
  "status.lost": "Perdida",
  "kind.shell": "Comando",
  "kind.subagent": "Subagente",
  command: "Comando",
  directory: "Directorio",
  time: "Duración",
  exit: "Código de salida {code}",
  timeout: "Detenida por el límite de tiempo",
  stoppedBy: "Detenida por {who}",
  "who.user": "ti",
  "who.model": "el agente",
  "who.timeout": "el límite de tiempo",
  "who.shutdown": "el cierre de Alisio",
  lostHint: "Alisio se cerró mientras esta tarea corría: no sobrevivió al reinicio.",
  subagentHint:
    "Los subagentes se gestionan desde el panel de agentes; esta vista solo muestra su estado.",
  noOutput: "Aún no hay salida.",
  outputCut: "El registro guardado se cortó en su límite de tamaño.",
  outputTrimmed: "La salida anterior no se muestra aquí.",
  finished: "La tarea «{label}» terminó: {status}",
  bytes: "{size} KB",
};

export const taskStrings = { en, es };

/** Translates a Tasks tab string in the current locale (reading the signal subscribes). */
export const tk = (key: TaskStringKey, params?: Record<string, string | number>): string =>
  format(taskStrings[locale.value][key] ?? en[key], params);
