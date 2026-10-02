/**
 * Labels of the settable keys (Settings → General). They live next to the Settings chunk, not in
 * the initial dictionaries: only that page shows them, and the initial bundle has a size budget.
 * `tests/web-i18n.test.ts` fails when a settable key of the server has no label in a language.
 */
import type { Locale } from "../../i18n/index.ts";

export const SETTING_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    "compaction.auto": "Compact the context automatically",
    "compaction.threshold": "Compaction threshold (fraction of the window)",
    "compaction.keepTurns": "Recent turns kept verbatim",
    "compaction.maxOutputTokens": "Summary length (tokens)",
    "context.claudeMdFallback": "Read CLAUDE.md when there is no AGENTS.md",
    "context.maxBytes": "Project instructions limit (bytes)",
    "limits.maxTurns": "Turns per run",
    "limits.maxOutputTokens": "Output tokens per turn",
    "limits.maxContextChars": "Context characters sent",
    "limits.timeoutMs": "Provider request timeout (ms)",
    "limits.firstTokenTimeoutMs": "First-token timeout (ms)",
    "limits.firstTokenRetries": "Retries when the model stays silent",
    "limits.truncationRecoveries": "Recoveries from truncated output",
    "pluginHooks.timeoutMs": "Plugin hook timeout (ms)",
    "websearch.provider": "Web search provider",
    "tui.paddingX": "Terminal horizontal padding",
    "tui.contentPaddingX": "Terminal content padding",
    "tui.skillSlashCommands": "Skills as slash commands (terminal)",
    "agents.active": "Active agent",
    "agents.effort": "Agent reasoning effort",
    "analysis.enabled": "Data analysis",
    "analysis.limits.timeoutMs": "Analysis run timeout (ms)",
    "analysis.retention.jobsDays": "Keep analysis jobs (days)",
    "analysis.retention.intermediateDays": "Keep intermediate files (days)",
    "analysis.retention.artifactsDays": "Keep artifacts (days)",
  },
  es: {
    "compaction.auto": "Compactar el contexto automáticamente",
    "compaction.threshold": "Umbral de compactación (fracción de la ventana)",
    "compaction.keepTurns": "Turnos recientes conservados literalmente",
    "compaction.maxOutputTokens": "Longitud del resumen (tokens)",
    "context.claudeMdFallback": "Leer CLAUDE.md si no hay AGENTS.md",
    "context.maxBytes": "Límite de instrucciones del proyecto (bytes)",
    "limits.maxTurns": "Turnos por run",
    "limits.maxOutputTokens": "Tokens de salida por turno",
    "limits.maxContextChars": "Caracteres de contexto enviados",
    "limits.timeoutMs": "Tiempo máximo de petición al proveedor (ms)",
    "limits.firstTokenTimeoutMs": "Tiempo máximo al primer token (ms)",
    "limits.firstTokenRetries": "Reintentos cuando el modelo no responde",
    "limits.truncationRecoveries": "Recuperaciones de salida truncada",
    "pluginHooks.timeoutMs": "Tiempo máximo de hooks de plugins (ms)",
    "websearch.provider": "Proveedor de búsqueda web",
    "tui.paddingX": "Margen horizontal del terminal",
    "tui.contentPaddingX": "Margen del contenido del terminal",
    "tui.skillSlashCommands": "Skills como comandos slash (terminal)",
    "agents.active": "Agente activo",
    "agents.effort": "Esfuerzo de razonamiento del agente",
    "analysis.enabled": "Análisis de datos",
    "analysis.limits.timeoutMs": "Tiempo máximo de una ejecución de análisis (ms)",
    "analysis.retention.jobsDays": "Conservar trabajos de análisis (días)",
    "analysis.retention.intermediateDays": "Conservar archivos intermedios (días)",
    "analysis.retention.artifactsDays": "Conservar artefactos (días)",
  },
};

/** The label of a settable key in `locale`; an unknown key shows its own name, never throws. */
export const settingLabel = (key: string, locale: Locale): string =>
  SETTING_LABELS[locale][key] ?? SETTING_LABELS.en[key] ?? key;
