/**
 * The detail card of a catalog entry (specs/030 §12.1 "Ficha de MCP"): what it gives you in plain
 * words, who provides it, where it runs, what you need and what it will ask for, whether Alisio can
 * install it, and the install action. Catalog text is untrusted publisher data: it is rendered as
 * text, never as HTML, and links open with `noopener noreferrer`. Lazy chunk.
 */
import type { McpCatalogDetail, McpCatalogItem } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../../store/app.ts";
import { ms } from "../mcp-install/strings.ts";
import { mgs } from "../mcp-manage/strings.ts";
import styles from "../settings.module.css";
import { type DetailView as DetailModel, detailViewOf } from "./detail-model.ts";
import css from "./explore.module.css";

export interface DetailViewProps {
  view: DetailModel;
  /** `server`: the page is served by a computer that may not be the browser's (web, headless). */
  hostWording?: "server";
  installLabel: string;
  onInstall: () => void;
  onClose: () => void;
  /** Disables the install action (no workspace). */
  disabled?: boolean;
}

function Row(props: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class={css.detailRow}>
      <dt class={css.detailTerm}>{props.label}</dt>
      <dd class={css.detailText}>{props.children}</dd>
    </div>
  );
}

export function DetailView(props: DetailViewProps) {
  const { view } = props;
  const where =
    view.execution === "remote" || view.origin
      ? mgs("detail.whereRemote", { origin: view.origin ?? "—" })
      : props.hostWording === "server"
        ? mgs("detail.whereLocalServer")
        : mgs("detail.whereLocal");
  return (
    <section class={css.detail} aria-label={mgs("detail.title", { name: view.title })}>
      <h5 class={css.detailTitle} tabIndex={-1}>
        {mgs("detail.title", { name: view.title })}
      </h5>
      {view.description ? <p class={css.desc}>{view.description}</p> : null}
      <dl class={css.detailList}>
        <Row label={mgs("detail.provider")}>
          {view.provider.kind === "github"
            ? mgs("detail.providerGithub", { name: view.provider.name })
            : view.provider.name}
          {" · "}
          {mgs("detail.version", { version: view.version })}
        </Row>
        <Row label={mgs("detail.where")}>{where}</Row>
        <Row label={mgs("detail.needs")}>
          {view.runtime === "node" ? mgs("detail.needsNode") : mgs("detail.needsNothing")}
        </Row>
        <Row label={mgs("detail.asks")}>
          {view.required.length ? (
            <ul class={css.detailItems}>
              {view.required.map((item) => (
                <li key={item.name}>
                  {item.secret ? mgs("detail.secretField", { name: item.name }) : item.name}
                </li>
              ))}
            </ul>
          ) : (
            mgs("detail.asksNothing")
          )}
          {view.optionalCount ? (
            <span class={css.detailMuted}> {mgs("detail.more", { n: view.optionalCount })}</span>
          ) : null}
        </Row>
        <Row label={mgs("detail.compat")}>
          {view.installable
            ? mgs("detail.compatReady")
            : view.blockedKey
              ? ms(view.blockedKey)
              : ""}
        </Row>
        {view.links.length ? (
          <Row label={mgs("detail.links")}>
            <ul class={css.detailItems}>
              {view.links.map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.kind === "website" ? mgs("detail.website") : mgs("detail.repository")}
                  </a>
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
      </dl>
      <p class={css.detailMuted}>{mgs("detail.trust")}</p>
      <div class={css.detailActions}>
        {view.installable ? (
          <button
            type="button"
            class={styles.primary}
            disabled={props.disabled}
            onClick={props.onInstall}
          >
            {props.installLabel}
          </button>
        ) : null}
        <button type="button" class={styles.secondary} onClick={props.onClose}>
          {mgs("detail.close")}
        </button>
      </div>
    </section>
  );
}

export interface DetailCardProps {
  item: McpCatalogItem;
  installLabel: string;
  disabled?: boolean;
  onInstall: () => void;
  onClose: () => void;
}

/** Loads the card from the local index (never from the publisher) and shows it. */
export function DetailCard(props: DetailCardProps) {
  const { item } = props;
  const [detail, setDetail] = useState<
    (McpCatalogDetail & { localBrowser?: boolean }) | undefined
  >();
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFailed(false);
    const query = new URLSearchParams({
      source: item.sourceId,
      name: item.name,
      version: item.version,
    });
    void api
      .request<McpCatalogDetail & { localBrowser?: boolean }>(
        "GET",
        `/api/mcp/catalog/detail?${query}`,
      )
      .then((loaded) => {
        setDetail(loaded);
        queueMicrotask(() => root.current?.querySelector<HTMLElement>("h5")?.focus());
      })
      .catch(() => setFailed(true));
  }, [item.sourceId, item.name, item.version, nonce]);
  return (
    <div ref={root} aria-live="polite">
      {failed ? (
        <p class={css.reason} role="alert">
          {mgs("detail.failed")}{" "}
          <button type="button" class={styles.secondary} onClick={() => setNonce((n) => n + 1)}>
            {mgs("detail.retry")}
          </button>
        </p>
      ) : !detail ? (
        <p class={css.detailMuted}>{mgs("detail.loading")}</p>
      ) : (
        <DetailView
          view={detailViewOf(detail)}
          {...(detail.localBrowser ? {} : { hostWording: "server" as const })}
          installLabel={props.installLabel}
          {...(props.disabled ? { disabled: true } : {})}
          onInstall={props.onInstall}
          onClose={props.onClose}
        />
      )}
    </div>
  );
}
