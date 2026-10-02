/**
 * Texts of the goal bar. They live with the bar (not in `i18n/en.ts`): this module is part of the
 * bar's lazy chunk and the always-loaded dictionary has a size budget. Same locale signal and
 * `{name}` placeholders as `t()`; English and Spanish must keep the same keys.
 */
import type { GoalReason, GoalStatus, GoalWaiting } from "@alisio/sdk";
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  label: "Session goal",
  "status.active": "Active",
  "status.paused": "Paused",
  "status.blocked": "Blocked",
  "status.budget_limited": "Budget reached",
  "status.complete": "Complete",
  "waiting.approval": "Waiting for permission",
  "waiting.question": "Waiting for your answer",
  "waiting.user_input": "Waiting for you to send what you typed",
  "waiting.plan_mode": "Waiting: plan mode is on (switch to the build agent)",
  "waiting.background_tasks": "Waiting for background tasks",
  "reason.created": "Started",
  "reason.resumed": "Resumed",
  "reason.edited": "Objective edited",
  "reason.user_paused": "Paused by you",
  "reason.user_interrupt": "You interrupted the turn",
  "reason.model_complete": "The agent reports the goal complete",
  "reason.model_blocked": "The agent reports it cannot continue",
  "reason.policy_denied": "A permission was denied",
  "reason.run_error": "A turn failed",
  "reason.token_budget": "The token budget was reached",
  "reason.max_turns": "The turn limit was reached",
  "reason.max_wall": "The time limit was reached",
  "reason.no_progress": "No progress",
  "reason.restart": "Alisio restarted while the goal was running",
  "detail.repeated_reply": "the same reply repeated",
  "detail.no_tool_turns": "several turns without tool calls",
  pause: "Pause",
  resume: "Resume",
  edit: "Edit",
  clear: "Clear",
  clearConfirm: "Clear this goal? The agent stops working on it.",
  save: "Save",
  cancel: "Cancel",
  objective: "Objective",
  budget: "Token budget",
  budgetHint: "e.g. 50k or 1.5M; leave empty or write clear for none",
  budgetLabel: "{used} of {budget} tokens",
  noBudget: "{used} tokens · no budget",
  budgetBar: "Token budget used",
  turns: "Turn {used}/{max}",
  time: "{time} in runs",
  report: "Agent's report",
  evidence: "Evidence",
  failed: "Couldn't update the goal: {error}",
  changed: "The goal changed in another window. It was reloaded.",
  replace: "This session already has a goal. Replace it with the new one?",
  more: "Show details",
  less: "Hide details",
  noLimit: "No token budget: only the turn and time limits stop this goal.",
};
export type GoalStringKey = keyof typeof en;

const es: Record<GoalStringKey, string> = {
  label: "Objetivo de la sesión",
  "status.active": "Activo",
  "status.paused": "En pausa",
  "status.blocked": "Bloqueado",
  "status.budget_limited": "Presupuesto agotado",
  "status.complete": "Completado",
  "waiting.approval": "Esperando un permiso",
  "waiting.question": "Esperando tu respuesta",
  "waiting.user_input": "Esperando que envíes lo que escribiste",
  "waiting.plan_mode": "En espera: el modo plan está activo (cambia al agente build)",
  "waiting.background_tasks": "Esperando tareas en segundo plano",
  "reason.created": "Iniciado",
  "reason.resumed": "Reanudado",
  "reason.edited": "Objetivo editado",
  "reason.user_paused": "Pausado por ti",
  "reason.user_interrupt": "Interrumpiste el turno",
  "reason.model_complete": "El agente informa que el objetivo está completo",
  "reason.model_blocked": "El agente informa que no puede continuar",
  "reason.policy_denied": "Se denegó un permiso",
  "reason.run_error": "Un turno falló",
  "reason.token_budget": "Se alcanzó el presupuesto de tokens",
  "reason.max_turns": "Se alcanzó el límite de turnos",
  "reason.max_wall": "Se alcanzó el límite de tiempo",
  "reason.no_progress": "Sin avance",
  "reason.restart": "Alisio se reinició mientras el objetivo estaba en marcha",
  "detail.repeated_reply": "se repitió la misma respuesta",
  "detail.no_tool_turns": "varios turnos sin llamar a herramientas",
  pause: "Pausar",
  resume: "Reanudar",
  edit: "Editar",
  clear: "Borrar",
  clearConfirm: "¿Borrar este objetivo? El agente deja de trabajar en él.",
  save: "Guardar",
  cancel: "Cancelar",
  objective: "Objetivo",
  budget: "Presupuesto de tokens",
  budgetHint: "p. ej. 50k o 1.5M; déjalo vacío o escribe clear para quitarlo",
  budgetLabel: "{used} de {budget} tokens",
  noBudget: "{used} tokens · sin presupuesto",
  budgetBar: "Presupuesto de tokens usado",
  turns: "Turno {used}/{max}",
  time: "{time} en ejecuciones",
  report: "Informe del agente",
  evidence: "Evidencia",
  failed: "No se pudo actualizar el objetivo: {error}",
  changed: "El objetivo cambió en otra ventana. Se recargó.",
  replace: "Esta sesión ya tiene un objetivo. ¿Reemplazarlo por el nuevo?",
  more: "Ver detalles",
  less: "Ocultar detalles",
  noLimit:
    "Sin presupuesto de tokens: solo los límites de turnos y de tiempo detienen este objetivo.",
};

/** Both dictionaries (the tests check that they keep the same keys). */
export const goalStrings = { en, es };

/** The text for `key` in the current locale (English if the Spanish key is missing). */
export const gk = (key: GoalStringKey, params?: Record<string, string | number>): string =>
  format((locale.value === "es" ? es : en)[key] ?? en[key], params);

export const statusText = (status: GoalStatus): string => gk(`status.${status}`);
export const waitingText = (waiting: GoalWaiting): string => gk(`waiting.${waiting}`);
/** The reason of a state as one sentence (with the breaker or error detail when there is one). */
export function reasonText(reason: GoalReason | undefined, detail: string | undefined): string {
  if (!reason) return "";
  const base = gk(`reason.${reason}`);
  if (!detail) return base;
  const known = `detail.${detail}` as GoalStringKey;
  return `${base}: ${known in en ? gk(known) : detail}`;
}
