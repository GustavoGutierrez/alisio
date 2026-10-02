/**
 * Texts of the plan viewer and of the plan review's diagram line. They live with the viewer (not
 * in `i18n/en.ts`): this module is part of the viewer's lazy chunk and the always-loaded
 * dictionary has a size budget. Same locale signal and `{name}` placeholders as `t()`; English and
 * Spanish must keep the same keys.
 */
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";

const en = {
  label: "Plan viewer",
  loading: "Loading the plan…",
  loadFailed: "The plan could not be loaded.",
  retry: "Try again",
  revision: "Revision {n}",
  nav: "Plan sections",
  "part.summary": "Summary",
  "part.goals": "Main goals",
  "part.stages": "Implementation stages",
  "part.diagrams": "Diagrams",
  "part.components": "Components and relationships",
  "part.considerations": "Decisions and considerations",
  "part.plan": "Full plan",
  "kind.decision": "Decision",
  "kind.risk": "Risk",
  "kind.verification": "Verification",
  stage: "Stage {n}",
  planSection: "Plan section: {name}",
  goToSection: "Go to the plan section “{name}”",
  diagramsFor: "Diagrams for this section",
  goToDiagram: "Go to the diagram “{name}”",
  badgeNew: "New in revision {n}",
  badgeUpdated: "Updated in revision {n}",
  removed: "Removed in revision {n}: {names}",
  diagramFailed: "This diagram could not be read: {error}",
  noManifest:
    "This plan folder has no usable plan.json, so the viewer shows the plan text and the diagram files it found.",
  type_overview: "Overview",
  type_flow: "Flow",
  type_components: "Components",
  type_architecture: "Architecture",
  type_sequence: "Sequence",
  type_data: "Data",
  type_state: "States",
  type_other: "Diagram",
  nodiagrams: "This plan has no diagrams.",
  empty: "The plan has no text.",
  // The plan review panel
  diagramCount: "{n} diagrams",
  diagramCountOne: "1 diagram",
  openViewer: "Open plan viewer",
};

const es: typeof en = {
  label: "Visor del plan",
  loading: "Cargando el plan…",
  loadFailed: "No se pudo cargar el plan.",
  retry: "Reintentar",
  revision: "Revisión {n}",
  nav: "Secciones del plan",
  "part.summary": "Resumen",
  "part.goals": "Objetivos principales",
  "part.stages": "Etapas de implementación",
  "part.diagrams": "Diagramas",
  "part.components": "Componentes y relaciones",
  "part.considerations": "Decisiones y consideraciones",
  "part.plan": "Plan completo",
  "kind.decision": "Decisión",
  "kind.risk": "Riesgo",
  "kind.verification": "Verificación",
  stage: "Etapa {n}",
  planSection: "Sección del plan: {name}",
  goToSection: "Ir a la sección del plan «{name}»",
  diagramsFor: "Diagramas de esta sección",
  goToDiagram: "Ir al diagrama «{name}»",
  badgeNew: "Nuevo en la revisión {n}",
  badgeUpdated: "Actualizado en la revisión {n}",
  removed: "Quitados en la revisión {n}: {names}",
  diagramFailed: "No se pudo leer este diagrama: {error}",
  noManifest:
    "Esta carpeta del plan no tiene un plan.json utilizable, así que el visor muestra el texto del plan y los archivos de diagrama que encontró.",
  type_overview: "Visión general",
  type_flow: "Flujo",
  type_components: "Componentes",
  type_architecture: "Arquitectura",
  type_sequence: "Secuencia",
  type_data: "Datos",
  type_state: "Estados",
  type_other: "Diagrama",
  nodiagrams: "Este plan no tiene diagramas.",
  empty: "El plan no tiene texto.",
  diagramCount: "{n} diagramas",
  diagramCountOne: "1 diagrama",
  openViewer: "Abrir el visor del plan",
};

/** Both dictionaries (the tests check that they keep the same keys). */
export const planStrings = { en, es };
export type PlanStringKey = keyof typeof en;

/** The text for `key` in the current locale (English if the Spanish key is missing). */
export const pk = (key: PlanStringKey, params?: Record<string, string | number>): string =>
  format((locale.value === "es" ? es : en)[key] ?? en[key], params);

/** "N diagrams" for the plan review line (singular for one). */
export const diagramCountText = (count: number): string =>
  count === 1 ? pk("diagramCountOne") : pk("diagramCount", { n: count });
