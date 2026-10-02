import type { PlanManifest } from "@alisio/sdk";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Markdown, MarkdownScope } from "../../markdown/view.tsx";
import MermaidView from "../../renderers/mermaid/view.tsx";
import { api } from "../../store/app.ts";
import { artifactImageUrl } from "../../util/panel.ts";
import {
  createPlanLoader,
  type DiagramLoad,
  diagramBadge,
  diagramDomId,
  diagramsBySection,
  groupDiagrams,
  loadPlanBundle,
  type PlanBundle,
  partDomId,
  sectionDomId,
  splitPlanSections,
} from "../../util/plan-view.ts";
import styles from "./plan.module.css";
import { type PlanStringKey, pk } from "./strings.ts";

type ManifestDiagram = PlanManifest["diagrams"][number];
type Loaded =
  | { status: "loading" }
  | { status: "ready"; bundle: PlanBundle }
  | { status: "error"; message: string };

/** Scrolls to a target and moves focus to it (targets carry `tabindex="-1"`). */
function goTo(domId: string): void {
  const element = document.getElementById(domId);
  if (!element) return;
  const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  element.focus({ preventScroll: true });
}

const typeLabel = (type: string) => pk(`type_${type}` as PlanStringKey);

function DiagramCard(props: {
  diagram: ManifestDiagram;
  load: DiagramLoad | undefined;
  manifest: PlanManifest | undefined;
  sectionTitle: string | undefined;
}) {
  const { diagram, load, manifest } = props;
  const badge = manifest ? diagramBadge(manifest, diagram) : undefined;
  const titleId = `${diagramDomId(diagram.id)}-title`;
  return (
    <article
      id={diagramDomId(diagram.id)}
      class={styles.card}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={diagram.explanation ? `${titleId}-text` : undefined}
    >
      <div class={styles.cardHead}>
        <h4 id={titleId} class={styles.cardTitle}>
          {diagram.title}
        </h4>
        <span class={styles.chip}>{typeLabel(diagram.type)}</span>
        {badge && manifest ? (
          <span class={styles.badge} data-kind={badge}>
            {pk(badge === "new" ? "badgeNew" : "badgeUpdated", { n: manifest.revision })}
          </span>
        ) : null}
      </div>
      {diagram.explanation ? (
        <p id={`${titleId}-text`} class={styles.explanation}>
          {diagram.explanation}
        </p>
      ) : null}
      <div class={styles.diagram}>
        {load?.source !== undefined ? (
          <MermaidView block={{ kind: "mermaid", source: load.source, title: diagram.id }} themed />
        ) : load?.error ? (
          <p class={styles.diagramError} role="note">
            {pk("diagramFailed", { error: load.error })}
          </p>
        ) : null}
      </div>
      {diagram.section && props.sectionTitle ? (
        <button
          type="button"
          class={styles.link}
          aria-label={pk("goToSection", { name: props.sectionTitle })}
          onClick={() => goTo(sectionDomId(diagram.section as string))}
        >
          {pk("planSection", { name: props.sectionTitle })}
        </button>
      ) : null}
    </article>
  );
}

function Part(props: { id: string; title: string; children: preact.ComponentChildren }) {
  const heading = `${partDomId(props.id)}-title`;
  return (
    <section id={partDomId(props.id)} class={styles.part} tabIndex={-1} aria-labelledby={heading}>
      <h3 id={heading} class={styles.partTitle}>
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

/** Left/Right/Home/End move between the navigation buttons (a roving toolbar). */
function navKeys(event: KeyboardEvent): void {
  const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const buttons = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button"),
  ];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

export default function PlanViewer(props: {
  artifactId: string;
  title: string;
  files: Array<{ path: string; bytes: number }>;
  entry: string;
}) {
  const { artifactId, files } = props;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef({ artifactId, files });
  latest.current = { artifactId, files };
  const load = useMemo(
    () =>
      createPlanLoader((id) =>
        loadPlanBundle({
          files: latest.current.files,
          fetchText: (path) => api.artifactText(id, path),
        }),
      ),
    [],
  );
  useEffect(() => {
    setLoaded({ status: "loading" });
    load(artifactId).then(
      (bundle) => {
        if (bundle) setLoaded({ status: "ready", bundle });
      },
      (error: unknown) =>
        setLoaded({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    // A new artifact (another revision) supersedes the request in flight.
  }, [artifactId, attempt, load]);

  if (loaded.status === "loading")
    return (
      <div class={styles.state} aria-busy="true">
        {pk("loading")}
      </div>
    );
  if (loaded.status === "error")
    return (
      <div class={`${styles.state} ${styles.stateError}`} role="status">
        <p>{pk("loadFailed")}</p>
        <p>{loaded.message}</p>
        <button type="button" class={styles.retry} onClick={() => setAttempt((n) => n + 1)}>
          {pk("retry")}
        </button>
      </div>
    );
  return <Loaded bundle={loaded.bundle} {...props} />;
}

function Loaded(props: { bundle: PlanBundle; artifactId: string; title: string; entry: string }) {
  const { bundle, artifactId } = props;
  const manifest = bundle.manifest;
  const diagrams = manifest ? manifest.diagrams : bundle.fallbackDiagrams;
  const { components, others } = groupDiagrams(diagrams);
  const sections = useMemo(() => splitPlanSections(bundle.markdown), [bundle.markdown]);
  const sectionTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const section of sections) map.set(section.id, section.title);
    return map;
  }, [sections]);
  const bySection = useMemo(() => diagramsBySection(diagrams), [diagrams]);
  const scope = useMemo(
    () => ({
      image: (href: string) => artifactImageUrl(href, artifactId, props.entry),
      workspaceLinks: false,
    }),
    [artifactId, props.entry],
  );
  const considerations = manifest?.considerations ?? [];
  const parts: Array<{ id: string; label: string }> = [
    ...(manifest?.summary ? [{ id: "summary", label: pk("part.summary") }] : []),
    ...(manifest?.goals.length ? [{ id: "goals", label: pk("part.goals") }] : []),
    ...(manifest?.stages.length ? [{ id: "stages", label: pk("part.stages") }] : []),
    ...(others.length ? [{ id: "diagrams", label: pk("part.diagrams") }] : []),
    ...(components.length ? [{ id: "components", label: pk("part.components") }] : []),
    ...(considerations.length ? [{ id: "considerations", label: pk("part.considerations") }] : []),
    { id: "plan", label: pk("part.plan") },
  ];
  const card = (diagram: ManifestDiagram) => (
    <DiagramCard
      key={diagram.id}
      diagram={diagram}
      load={bundle.diagrams[diagram.id]}
      manifest={manifest}
      sectionTitle={diagram.section ? sectionTitles.get(diagram.section) : undefined}
    />
  );
  return (
    <div class={styles.viewer} role="region" aria-label={pk("label")}>
      <div class={styles.top}>
        <h2 class={styles.heading}>
          <span>{manifest?.title ?? props.title}</span>
          {manifest && manifest.revision > 1 ? (
            <span class={styles.revision}>{pk("revision", { n: manifest.revision })}</span>
          ) : null}
        </h2>
        <nav class={styles.nav} aria-label={pk("nav")} onKeyDown={navKeys}>
          {parts.map((part) => (
            <button
              key={part.id}
              type="button"
              class={styles.navButton}
              onClick={() => goTo(partDomId(part.id))}
            >
              {part.label}
            </button>
          ))}
        </nav>
      </div>
      {!manifest ? <p class={styles.hint}>{pk("noManifest")}</p> : null}
      {manifest?.summary ? (
        <Part id="summary" title={pk("part.summary")}>
          <p class={styles.summary}>{manifest.summary}</p>
        </Part>
      ) : null}
      {manifest?.goals.length ? (
        <Part id="goals" title={pk("part.goals")}>
          <ul class={styles.goals}>
            {manifest.goals.map((goal, index) => (
              <li key={index} class={styles.goal}>
                {goal}
              </li>
            ))}
          </ul>
        </Part>
      ) : null}
      {manifest?.stages.length ? (
        <Part id="stages" title={pk("part.stages")}>
          <ol class={styles.stepper}>
            {manifest.stages.map((stage, index) => (
              <li key={index} class={styles.stage}>
                <span class={styles.bubble} aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <p class={styles.stageTitle}>
                    <span class="sr-only">{pk("stage", { n: index + 1 })}: </span>
                    {stage.title}
                  </p>
                  {stage.detail ? <p class={styles.stageDetail}>{stage.detail}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </Part>
      ) : null}
      {others.length ? (
        <Part id="diagrams" title={pk("part.diagrams")}>
          <div class={styles.cards}>{others.map(card)}</div>
          {manifest?.removed.length ? (
            <p class={styles.removed}>
              {pk("removed", {
                n: manifest.revision,
                names: manifest.removed.map((d) => d.title).join(", "),
              })}
            </p>
          ) : null}
        </Part>
      ) : null}
      {components.length ? (
        <Part id="components" title={pk("part.components")}>
          <div class={styles.cards}>{components.map(card)}</div>
          {!others.length && manifest?.removed.length ? (
            <p class={styles.removed}>
              {pk("removed", {
                n: manifest.revision,
                names: manifest.removed.map((d) => d.title).join(", "),
              })}
            </p>
          ) : null}
        </Part>
      ) : null}
      {!diagrams.length && manifest?.removed.length ? (
        <Part id="diagrams" title={pk("part.diagrams")}>
          <p class={styles.removed}>
            {pk("removed", {
              n: manifest.revision,
              names: manifest.removed.map((d) => d.title).join(", "),
            })}
          </p>
        </Part>
      ) : null}
      {considerations.length ? (
        <Part id="considerations" title={pk("part.considerations")}>
          <div class={styles.notes}>
            {considerations.map((note, index) => (
              <p key={index} class={styles.note} data-kind={note.kind}>
                <span class={styles.noteKind}>{pk(`kind.${note.kind}` as PlanStringKey)}</span>
                {note.text}
              </p>
            ))}
          </div>
        </Part>
      ) : null}
      <Part id="plan" title={pk("part.plan")}>
        <div class={styles.planBody}>
          <MarkdownScope.Provider value={scope}>
            {sections.length ? (
              sections.map((section, index) => {
                const related = bySection.get(section.id) ?? [];
                return (
                  <section
                    key={`${section.id}-${index}`}
                    id={sectionDomId(section.id)}
                    class={styles.planSection}
                    tabIndex={-1}
                  >
                    <Markdown text={section.text} />
                    {related.length ? (
                      <p class={styles.related}>
                        <span>{pk("diagramsFor")}:</span>
                        {related.map((diagram) => (
                          <button
                            key={diagram.id}
                            type="button"
                            class={styles.link}
                            aria-label={pk("goToDiagram", { name: diagram.title })}
                            onClick={() => goTo(diagramDomId(diagram.id))}
                          >
                            {diagram.title}
                          </button>
                        ))}
                      </p>
                    ) : null}
                  </section>
                );
              })
            ) : (
              <p class={styles.explanation}>{pk("empty")}</p>
            )}
          </MarkdownScope.Provider>
        </div>
      </Part>
    </div>
  );
}
