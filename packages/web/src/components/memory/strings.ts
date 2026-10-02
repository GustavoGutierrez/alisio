/**
 * Texts of the Memory tab. They live with the tab (not in `i18n/en.ts`) so the always-loaded
 * dictionaries stay small: this module is part of the tab's lazy chunk. Same locale signal and
 * `{name}` placeholders as `t()`; English and Spanish must keep the same keys.
 */
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  title: "Memory of this chat",
  lead: "Read-only view of what the memory plugin holds for this chat. Nothing here can be edited.",
  refresh: "Refresh",
  empty: "No memory stored for this chat yet",
  savedTitle: "Saved in this chat",
  savedHint: "Memories saved while this chat was open. Pinned first, then newest.",
  summaryTitle: "Session summary",
  summaryEmpty: "No session summary has been stored for this chat yet.",
  contextTitle: "Context loaded",
  contextHint: "The memory context the plugin added when this chat started.",
  contextEmpty: "No memory context was loaded when this chat started.",
  filterType: "Type",
  allTypes: "All types",
  search: "Search saved memories",
  searchPlaceholder: "Search title, content or topic",
  noResults: "No saved memory matches this filter.",
  savedEmpty: "Nothing was saved while this chat was open.",
  count: "{shown} of {total}",
  loadMore: "Load more",
  loading: "Loading…",
  retry: "Retry",
  error: "Couldn't load this section.",
  loadMoreError: "Couldn't load more memories.",
  expand: "Show more",
  collapse: "Show less",
  details: "Details",
  hideDetails: "Hide details",
  pinned: "Pinned",
  updated: "Updated {time}",
  created: "Created {time}",
  loadedAt: "Loaded {time}",
  source: "Source: {source}",
  scopeProject: "Project",
  scopePersonal: "Personal",
  shortened: "Shortened for display.",
  "type.decision": "Decision",
  "type.bugfix": "Bug fix",
  "type.discovery": "Discovery",
  "type.pattern": "Pattern",
  "type.architecture": "Architecture",
  "type.config": "Configuration",
  "type.preference": "Preference",
  "type.learning": "Learning",
};
export type MemoryStringKey = keyof typeof en;

const es: Record<MemoryStringKey, string> = {
  title: "Memoria de este chat",
  lead: "Vista de solo lectura de lo que el plugin de memoria guarda para este chat. Nada de aquí se puede editar.",
  refresh: "Actualizar",
  empty: "Aún no hay memoria guardada para este chat",
  savedTitle: "Guardado en este chat",
  savedHint:
    "Memorias guardadas mientras este chat estaba abierto. Primero las fijadas, luego las más recientes.",
  summaryTitle: "Resumen de la sesión",
  summaryEmpty: "Todavía no se guardó un resumen de la sesión para este chat.",
  contextTitle: "Contexto cargado",
  contextHint: "El contexto de memoria que el plugin añadió cuando empezó este chat.",
  contextEmpty: "No se cargó contexto de memoria cuando empezó este chat.",
  filterType: "Tipo",
  allTypes: "Todos los tipos",
  search: "Buscar en las memorias guardadas",
  searchPlaceholder: "Buscar en título, contenido o tema",
  noResults: "Ninguna memoria guardada coincide con este filtro.",
  savedEmpty: "No se guardó nada mientras este chat estaba abierto.",
  count: "{shown} de {total}",
  loadMore: "Cargar más",
  loading: "Cargando…",
  retry: "Reintentar",
  error: "No se pudo cargar esta sección.",
  loadMoreError: "No se pudieron cargar más memorias.",
  expand: "Ver más",
  collapse: "Ver menos",
  details: "Detalles",
  hideDetails: "Ocultar detalles",
  pinned: "Fijada",
  updated: "Actualizada {time}",
  created: "Creada {time}",
  loadedAt: "Cargado {time}",
  source: "Origen: {source}",
  scopeProject: "Proyecto",
  scopePersonal: "Personal",
  shortened: "Acortado para mostrarlo.",
  "type.decision": "Decisión",
  "type.bugfix": "Corrección",
  "type.discovery": "Descubrimiento",
  "type.pattern": "Patrón",
  "type.architecture": "Arquitectura",
  "type.config": "Configuración",
  "type.preference": "Preferencia",
  "type.learning": "Aprendizaje",
};

export const memoryStrings = { en, es };

/** Translates a Memory tab string in the current locale (reading the signal subscribes). */
export const tm = (key: MemoryStringKey, params?: Record<string, string | number>): string =>
  format(memoryStrings[locale.value][key] ?? en[key], params);
