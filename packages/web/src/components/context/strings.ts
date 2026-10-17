/**
 * Texts of the Context panel. They live with the panel (not in `i18n/en.ts`): this module is part
 * of the panel's lazy chunk and the always-loaded dictionary has a size budget. Same locale signal
 * and `{name}` placeholders as `t()`; English and Spanish must keep the same keys.
 */
import type { ContextCriticality, ContextElisionReason, ContextSegmentKind } from "@alisio/sdk";
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  label: "Context",
  mode: "Mode: {mode} · policy v{policy}",
  "mode.off": "off",
  "mode.shadow": "shadow (measures only)",
  "mode.on": "on (elides)",
  off: "The Context Governor is off, so nothing is measured for this session. Set context.governor to shadow (measure only) or on (also elide) to see what the next request carries.",
  history: "{messages} messages · about {before} tokens, about {after} after the policy",
  elided: "{n} elided · about {saved} tokens saved",
  elidedShadow: "{n} would be elided · about {saved} tokens saved",
  none: "Nothing is elided.",
  used: "{percent}% of the tool results were acted on later (path heuristic)",
  invariants: "Invariants carried after a compaction: {n}",
  "invariantKind.instruction": "instructions",
  "invariantKind.goal": "goal",
  "invariantKind.plan": "plan",
  "invariantKind.criterion": "criteria",
  "invariantKind.grant": "grants",
  invariantsOmitted: "{n} did not fit context.invariants.maxChars",
  noInvariants: "none yet, they appear after the first compaction",
  segments: "Segments",
  showAll: "Show every segment",
  hidden: "{n} ordinary or recent segments are hidden.",
  omitted: "{n} more segments are left out of the report.",
  "kind.system": "system",
  "kind.instructions": "instructions",
  "kind.user": "user",
  "kind.assistant": "assistant",
  "kind.tool_call": "tool call",
  "kind.tool_result": "tool result",
  "kind.checkpoint": "checkpoint",
  "kind.invariant": "invariant",
  "kind.memory": "memory",
  "kind.other": "other",
  "criticality.pinned": "pinned",
  "criticality.high": "high",
  "criticality.normal": "normal",
  "criticality.low": "low",
  "reason.superseded_read": "superseded read",
  "reason.stale_bg_output": "stale background output",
  "reason.duplicate_search": "duplicate search",
  replacedBy: "replaced by {callId}",
  tokens: "{n} tokens",
  usedLater: "acted on later",
  notUsed: "not acted on later",
  refresh: "Refresh",
  loading: "Loading the report…",
  failed: "The context report could not be loaded.",
  disclaimer:
    "Token figures are estimates. Used is a heuristic: it means the agent acted on the same path later, not that this content was needed.",
  open: "Open the Context panel",
} as const;

const es: Record<keyof typeof en, string> = {
  label: "Contexto",
  mode: "Modo: {mode} · política v{policy}",
  "mode.off": "desactivado",
  "mode.shadow": "shadow (solo mide)",
  "mode.on": "on (elide)",
  off: "El Context Governor está desactivado, así que no se mide nada de esta sesión. Define context.governor como shadow (solo mide) u on (además elide) para ver qué lleva la siguiente petición.",
  history: "{messages} mensajes · unos {before} tokens, unos {after} tras la política",
  elided: "{n} elididos · unos {saved} tokens ahorrados",
  elidedShadow: "{n} se elidirían · unos {saved} tokens ahorrados",
  none: "No se elide nada.",
  used: "El {percent}% de los resultados de herramientas se usó después (heurística por ruta)",
  invariants: "Invariantes que se conservan tras compactar: {n}",
  "invariantKind.instruction": "instrucciones",
  "invariantKind.goal": "objetivo",
  "invariantKind.plan": "plan",
  "invariantKind.criterion": "criterios",
  "invariantKind.grant": "permisos",
  invariantsOmitted: "{n} no caben en context.invariants.maxChars",
  noInvariants: "ninguno todavía, aparecen tras la primera compactación",
  segments: "Segmentos",
  showAll: "Mostrar todos los segmentos",
  hidden: "{n} segmentos ordinarios o recientes están ocultos.",
  omitted: "{n} segmentos más quedan fuera del informe.",
  "kind.system": "sistema",
  "kind.instructions": "instrucciones",
  "kind.user": "usuario",
  "kind.assistant": "asistente",
  "kind.tool_call": "llamada a herramienta",
  "kind.tool_result": "resultado de herramienta",
  "kind.checkpoint": "punto de control",
  "kind.invariant": "invariante",
  "kind.memory": "memoria",
  "kind.other": "otro",
  "criticality.pinned": "fijado",
  "criticality.high": "alta",
  "criticality.normal": "normal",
  "criticality.low": "baja",
  "reason.superseded_read": "lectura superada",
  "reason.stale_bg_output": "salida de fondo antigua",
  "reason.duplicate_search": "búsqueda duplicada",
  replacedBy: "sustituido por {callId}",
  tokens: "{n} tokens",
  usedLater: "usado después",
  notUsed: "no usado después",
  refresh: "Actualizar",
  loading: "Cargando el informe…",
  failed: "No se pudo cargar el informe de contexto.",
  disclaimer:
    "Las cifras de tokens son estimaciones. «Usado» es una heurística: significa que el agente actuó después sobre la misma ruta, no que ese contenido hiciera falta.",
  open: "Abrir el panel Contexto",
};

/** Both dictionaries (the tests check that they keep the same keys). */
export const contextStrings = { en, es };

export type ContextStringKey = keyof typeof en;

/** The text for `key` in the current locale (English if the Spanish key is missing). */
export const ck = (key: ContextStringKey, params?: Record<string, string | number>): string =>
  format((locale.value === "es" ? es : en)[key] ?? en[key], params);

/** A label for an enum value, or the raw value when this build does not know it yet. */
const label = (prefix: string, value: string): string =>
  `${prefix}.${value}` in en ? ck(`${prefix}.${value}` as ContextStringKey) : value;

export const invariantKindLabel = (kind: string): string => label("invariantKind", kind);
export const kindLabel = (kind: ContextSegmentKind): string => label("kind", kind);
export const criticalityLabel = (c: ContextCriticality): string => label("criticality", c);
export const reasonLabel = (r: ContextElisionReason): string => label("reason", r);
