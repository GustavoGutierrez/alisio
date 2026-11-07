export type NavigationAction = "allow" | "external" | "deny";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * What to do with a navigation or window-open request: stay in the window only for the app's own
 * origin, hand web links to the system, refuse the rest (file:, javascript:, data:, garbage).
 */
export function classifyNavigation(target: string, appUrl: string): NavigationAction {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  if (url.origin !== "null" && url.origin === new URL(appUrl).origin) return "allow";
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? "external" : "deny";
}
