/**
 * Small pieces shared by the compact catalog rows and the detail view: the plugin icon with its
 * letter fallback, the cover, safe external links and the action button labels. Everything here is
 * part of the lazy settings chunk (the initial bundle has a size budget): even the three glyphs
 * the shared icon set lacks are drawn locally.
 */
import { useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import {
  type CatalogPluginView,
  DEFAULT_PLUGIN_ICON,
  iconState,
  type RowAction,
  type RowActionKind,
} from "./catalog-model.ts";
import { cs } from "./catalog-strings.ts";
import styles from "./settings.module.css";

const GLYPHS = {
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
} as const;

export function Glyph(props: { name: keyof typeof GLYPHS; size?: number }) {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={GLYPHS[props.name]} />
    </svg>
  );
}

/**
 * Rounded-square plugin icon, shared by the catalog rows and detail, the installed cards and the
 * confirmation dialogs. The one default (`plugin-default.svg`: no icon, or it failed to load;
 * built-in, project and file plugins included) is a fixed-color image, the same in both themes.
 * The tile is decorative (empty alt): the plugin name is always next to it.
 */
export function PluginIcon(props: { icon?: string | undefined; size?: "small" | "row" | "hero" }) {
  const [failed, setFailed] = useState(false);
  const [defaultFailed, setDefaultFailed] = useState(false);
  const own = iconState(props.icon, failed) === "image";
  const src = own ? props.icon : DEFAULT_PLUGIN_ICON;
  return (
    <span class={styles.pluginIcon} data-size={props.size ?? "row"} aria-hidden="true">
      {own || !defaultFailed ? (
        <img
          src={src}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          decoding="async"
          // The default failing too leaves an empty tile instead of looping.
          onError={() => (own ? setFailed(true) : setDefaultFailed(true))}
        />
      ) : null}
    </span>
  );
}

export function Cover(props: { plugin: CatalogPluginView; alt?: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    props.plugin.cover ? "loading" : "failed",
  );
  return (
    <div class={styles.cover} data-state={state}>
      {props.plugin.cover && state !== "failed" ? (
        <img
          src={props.plugin.cover}
          alt={props.alt ?? ""}
          width={640}
          height={360}
          loading="lazy"
          decoding="async"
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      ) : null}
      {state === "failed" ? (
        <span class={styles.coverFallback} aria-hidden="true">
          {props.plugin.name.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
    </div>
  );
}

/** Opens in a new tab without leaking the opener or the referrer. */
export function ExternalLink(props: { href: string; children: string; button?: boolean }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      class={props.button ? styles.ghostButton : styles.link}
    >
      {props.children}
      <Glyph name="external" size={13} />
      <span class={styles.srOnly}> ({cs("card.external")})</span>
    </a>
  );
}

const ACTION_ICON = {
  install: "plus",
  update: "arrowUp",
  reinstall: "refresh",
  downgrade: "arrowDown",
  incompatible: "alert",
} as const;

/** Icon of an action; the spinner while its install runs. */
export function ActionIcon(props: { kind: RowActionKind; size?: number }) {
  return props.kind === "installing" ? (
    <span class={styles.spinner} aria-hidden="true" />
  ) : (
    <Icon name={ACTION_ICON[props.kind]} size={props.size ?? 17} />
  );
}

export interface ActionText {
  /** Short visible text (and the tooltip of an icon-only button). */
  label: string;
  /** Accessible name: says which plugin and, for updates, which versions. */
  aria: string;
  /** Tooltip explaining why the action is disabled. */
  reason?: string;
}

export function actionText(
  plugin: CatalogPluginView,
  action: RowAction,
  sdkVersion?: string,
): ActionText {
  const name = plugin.name;
  const from = plugin.installedVersion ?? "";
  const to = plugin.version;
  const reason =
    action.reason === "incompatible"
      ? cs("action.incompatibleReason", { range: plugin.sdk ?? "?", sdk: sdkVersion ?? "?" })
      : action.reason === "busy"
        ? cs("action.busy")
        : undefined;
  const text = (label: string, aria: string): ActionText => ({
    label,
    aria,
    ...(reason ? { reason } : {}),
  });
  switch (action.kind) {
    case "installing":
      return text(cs("action.installing"), cs("action.installingNamed", { name }));
    case "update":
      return text(cs("update.button"), cs("action.updateFromNamed", { name, from, to }));
    case "reinstall":
      return text(cs("action.reinstall"), cs("action.reinstallNamed", { name }));
    case "downgrade":
      return text(
        cs("action.downgrade", { from, to }),
        cs("action.downgradeNamed", { name, from, to }),
      );
    case "incompatible":
      return text(cs("action.incompatible"), `${name}: ${cs("action.incompatible")}`);
    default:
      return text(cs("action.install"), cs("action.installNamed", { name }));
  }
}
