/**
 * Texts of the Proof card and panel. They live with the card (not in `i18n/en.ts`): this module is
 * part of the card's lazy chunk and the always-loaded dictionary has a size budget. Same locale
 * signal and `{name}` placeholders as `t()`; English and Spanish must keep the same keys.
 */
import type { ProofStatus } from "@alisio/sdk";
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  label: "Acceptance criteria",
  summary: "{verified} of {total} verified",
  unmet: "{n} required not verified",
  "status.verified": "Verified",
  "status.failed": "Failed",
  "status.not_checked": "Not checked",
  "status.manual_review": "Manual review",
  "status.not_applicable": "Not applicable",
  stale: "stale: edited after the evidence",
  required: "Required",
  optional: "Optional",
  evidence: "Evidence: {callId} · exit {code}",
  noEvidence: "No evidence yet",
  naReason: "Not applicable: {reason}",
  divergence: "Claimed without evidence: “{claim}” ({status})",
  empty: "No criteria yet. Add one: Alisio marks it verified only when a command it ran proves it.",
  add: "Add criterion",
  text: "Criterion",
  command: "Command that verifies it (optional)",
  commandHint: "Verified when the agent runs exactly this command and it succeeds.",
  requiredLabel: "Required",
  edit: "Edit",
  save: "Save",
  cancel: "Cancel",
  notApplicable: "Not applicable",
  reason: "Reason",
  override: "Complete the goal anyway",
  overrideHint:
    "Required criteria are not verified. Only you can complete the goal over them; the reason is kept.",
  overrideConfirm: "Complete the goal",
  "export.md": "Export Markdown",
  "export.json": "Export JSON",
  disclaimer: "Proof records operational evidence; it does not prove that the code is correct.",
  failed: "Could not update the criteria: {error}",
  open: "Open the Proof panel",
  panel: "Proof",
} as const;

const es: Record<keyof typeof en, string> = {
  label: "Criterios de aceptación",
  summary: "{verified} de {total} verificados",
  unmet: "{n} requeridos sin verificar",
  "status.verified": "Verificado",
  "status.failed": "Falló",
  "status.not_checked": "Sin comprobar",
  "status.manual_review": "Revisión manual",
  "status.not_applicable": "No aplica",
  stale: "caducada: se editó después de la evidencia",
  required: "Requerido",
  optional: "Opcional",
  evidence: "Evidencia: {callId} · salida {code}",
  noEvidence: "Aún sin evidencia",
  naReason: "No aplica: {reason}",
  divergence: "Afirmado sin evidencia: «{claim}» ({status})",
  empty:
    "Aún no hay criterios. Añade uno: Alisio lo marca verificado solo cuando un comando que ejecutó lo demuestra.",
  add: "Añadir criterio",
  text: "Criterio",
  command: "Comando que lo verifica (opcional)",
  commandHint: "Se verifica cuando el agente ejecuta exactamente este comando y termina bien.",
  requiredLabel: "Requerido",
  edit: "Editar",
  save: "Guardar",
  cancel: "Cancelar",
  notApplicable: "No aplica",
  reason: "Motivo",
  override: "Completar el objetivo de todos modos",
  overrideHint:
    "Hay criterios requeridos sin verificar. Solo tú puedes completar el objetivo sobre ellos; el motivo queda registrado.",
  overrideConfirm: "Completar el objetivo",
  "export.md": "Exportar Markdown",
  "export.json": "Exportar JSON",
  disclaimer: "Proof registra evidencia operativa; no demuestra que el código sea correcto.",
  failed: "No se pudieron actualizar los criterios: {error}",
  open: "Abrir el panel Proof",
  panel: "Proof",
};

/** Both dictionaries (the tests check that they keep the same keys). */
export const proofStrings = { en, es };

export type ProofStringKey = keyof typeof en;

/** The text for `key` in the current locale (English if the Spanish key is missing). */
export const pk = (key: ProofStringKey, params?: Record<string, string | number>): string =>
  format((locale.value === "es" ? es : en)[key] ?? en[key], params);

export const statusLabel = (status: ProofStatus): string => pk(`status.${status}`);
