/**
 * The detail panel of a catalog plugin, shown inside the Plugin catalog tab: icon, name, author,
 * the primary action (Install / Update / Reinstall / Downgrade), the large cover, the full
 * description, an "Information" definition list with only the fields the catalog provides, safe
 * external links and the not-sandboxed note. Back (and Escape) return to the list as it was left.
 */
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../icons.tsx";
import {
  type CatalogPluginView,
  detailInfo,
  type InfoFieldId,
  type InstallTarget,
  rowAction,
  truncateDescription,
} from "./catalog-model.ts";
import {
  ActionIcon,
  actionText,
  Cover,
  ExternalLink,
  Glyph,
  PluginIcon,
} from "./catalog-parts.tsx";
import { cs } from "./catalog-strings.ts";
import { working } from "./plugin-ops.ts";
import styles from "./settings.module.css";
import { Pill } from "./shared.tsx";

/** The header has more room than a row: a longer one-line summary. */
const HEADER_SUMMARY_LIMIT = 90;

const FIELD_LABEL = {
  version: "detail.field.version",
  installed: "detail.field.installed",
  author: "detail.field.author",
  license: "detail.field.license",
  categories: "detail.field.categories",
  tags: "detail.field.tags",
  sdk: "detail.field.sdk",
  package: "detail.field.package",
  published: "detail.field.published",
} as const satisfies Record<InfoFieldId, Parameters<typeof cs>[0]>;

export function CatalogDetail(props: {
  plugin: CatalogPluginView;
  sdkVersion?: string;
  onBack: () => void;
  onAsk: (target: InstallTarget) => void;
  onUninstall: (plugin: CatalogPluginView) => void;
}) {
  const { plugin } = props;
  const root = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
    // The list may have been scrolled: show the detail from its top.
    root.current?.scrollIntoView?.({ block: "start" });
  }, [plugin.slug]);

  const action = rowAction(plugin, working.value);
  const text = actionText(plugin, action, props.sdkVersion);
  const info = detailInfo(plugin);
  const reasonId = `detail-reason-${plugin.slug}`;
  const uninstalling = working.value === plugin.package;
  const primary = action.kind === "downgrade" ? styles.ghostButton : styles.primaryButton;
  // Header: npm plus the website (the repository stands in when there is no separate homepage).
  const headerLinks = info.links.filter((link) => link.id !== "repository" || !plugin.homepage);

  return (
    <section
      ref={root}
      class={styles.detail}
      aria-label={cs("detail.label", { name: plugin.name })}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onBack();
        }
      }}
    >
      <button type="button" ref={back} class={styles.backLink} onClick={props.onBack}>
        <Glyph name="arrowLeft" size={15} />
        {cs("detail.back")}
      </button>

      <header class={styles.detailHead}>
        <PluginIcon icon={plugin.icon} size="hero" />
        <div class={styles.detailTitle}>
          <h4 class={styles.detailName}>{plugin.name}</h4>
          <p class={styles.detailSummary}>
            {plugin.author ? `${cs("card.by", { author: plugin.author })} · ` : ""}
            {truncateDescription(plugin.description, HEADER_SUMMARY_LIMIT)}
          </p>
          {plugin.installedVersion ? (
            <span class={styles.detailBadges}>
              <Pill tone="ok">
                {cs("row.installedBadge", { version: plugin.installedVersion })}
              </Pill>
              {plugin.updateAvailable ? <Pill tone="warn">{cs("update.button")}</Pill> : null}
            </span>
          ) : null}
        </div>
        <div class={styles.detailActions}>
          <button
            type="button"
            class={primary}
            disabled={action.disabled}
            title={text.reason ?? text.label}
            aria-label={text.aria}
            aria-describedby={text.reason ? reasonId : undefined}
            aria-busy={action.kind === "installing" || undefined}
            onClick={() => action.mode && props.onAsk(target(plugin, action.mode))}
          >
            <ActionIcon kind={action.kind} size={16} />
            {text.label}
          </button>
          {plugin.installedVersion ? (
            <button
              type="button"
              class={styles.dangerGhost}
              disabled={working.value !== undefined}
              title={working.value !== undefined ? cs("action.busy") : undefined}
              aria-label={cs("uninstall.buttonNamed", { name: plugin.name })}
              onClick={() => props.onUninstall(plugin)}
            >
              {uninstalling ? (
                <span class={styles.spinner} aria-hidden="true" />
              ) : (
                <Glyph name="trash" size={15} />
              )}
              {uninstalling ? cs("uninstall.working") : cs("uninstall.button")}
            </button>
          ) : null}
          {headerLinks.map((link) => (
            <ExternalLink key={link.id} href={link.href} button>
              {cs(`card.${link.id}`)}
            </ExternalLink>
          ))}
        </div>
      </header>
      {text.reason ? (
        <p id={reasonId} class={styles.diagnostic}>
          {text.reason}
        </p>
      ) : null}

      <div class={styles.detailCover}>
        <Cover plugin={plugin} alt={cs("card.cover", { name: plugin.name })} />
      </div>

      <h5 class={styles.detailHeading}>{cs("detail.about")}</h5>
      <p class={styles.detailText}>{plugin.description}</p>

      <h5 class={styles.detailHeading}>{cs("detail.information")}</h5>
      <dl class={styles.infoList}>
        {info.fields.map((field) => (
          <div key={field.id} class={styles.infoRow}>
            <dt>{cs(FIELD_LABEL[field.id])}</dt>
            <dd>
              {field.id === "package" ? <code>{field.value}</code> : field.value}
              {field.id === "sdk" ? (
                plugin.compatible ? (
                  <span class={styles.infoNote}>
                    <Icon name="check" size={13} />
                    {cs("detail.compatible", { sdk: props.sdkVersion ?? "?" })}
                  </span>
                ) : (
                  <span class={styles.infoNote} data-tone="danger">
                    {cs("action.incompatibleReason", {
                      range: plugin.sdk ?? "?",
                      sdk: props.sdkVersion ?? "?",
                    })}
                  </span>
                )
              ) : null}
            </dd>
          </div>
        ))}
        {info.links.length ? (
          <div class={styles.infoRow}>
            <dt>{cs("detail.links")}</dt>
            <dd class={styles.links}>
              {info.links.map((link) => (
                <ExternalLink key={link.id} href={link.href}>
                  {cs(`card.${link.id}`)}
                </ExternalLink>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>

      <aside class={styles.securityNote}>
        <Icon name="shield" size={18} />
        <div>
          <strong>{cs("detail.notSandboxed.title")}</strong>
          <p>{cs("detail.notSandboxed")}</p>
        </div>
      </aside>
    </section>
  );
}

const target = (plugin: CatalogPluginView, mode: InstallTarget["mode"]): InstallTarget => ({
  package: plugin.package,
  name: plugin.name,
  version: plugin.version,
  ...(plugin.icon ? { icon: plugin.icon } : {}),
  ...(plugin.installedVersion ? { installedVersion: plugin.installedVersion } : {}),
  mode,
});
