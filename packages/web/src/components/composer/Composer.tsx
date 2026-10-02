import type { CommandDescriptor, PermissionPresetId } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { newId } from "../../net/api.ts";
import {
  activateAgent,
  agentList,
  api,
  busy,
  cancelRun,
  commands,
  composerInsert,
  context,
  currentId,
  cycleAgent,
  detail,
  focusComposer,
  goalInfo,
  history,
  loadDraft,
  models,
  saveDraft,
  setEffort,
  setModel,
  setPreset,
  showToast,
  submit,
} from "../../store/app.ts";
import {
  ACCEPT,
  applyDatasetOutcome,
  applyPolledDatasets,
  canSend,
  checkFile,
  isDatasetFile,
  type PendingAttachment,
  type Rejection,
  readyDatasets,
  readyRefs,
  updateAttachment,
} from "../../store/attachments.ts";
import { historyStep, paletteRows } from "../../store/composer.ts";
import { datasetNotices } from "../../store/datasets.ts";
import { activeAgentId, needsFullAccessConfirm, shiftTabCycles } from "../../store/modes.ts";
import { datasetShape } from "../artifacts/DatasetChips.tsx";
import { Icon } from "../icons.tsx";
import { Menu } from "../Menu.tsx";
import styles from "./composer.module.css";

const PALETTE_ID = "slash-palette";

/** Thumbnails of the images about to be sent, each removable. */
function Thumbs(props: { items: PendingAttachment[]; onRemove: (id: string) => void }) {
  return (
    <ul class={styles.thumbs} aria-label={t("composer.attachments")}>
      {props.items.map((item) =>
        item.kind === "dataset" ? (
          <li
            key={item.id}
            class={styles.dataChip}
            data-status={item.status}
            title={
              item.error ? t("dataset.failed", { name: item.name, error: item.error }) : item.name
            }
          >
            <Icon name="fileTable" size={15} />
            <span class={styles.dataChipText}>
              {item.status === "uploading"
                ? t("dataset.uploading", { name: item.name })
                : item.status === "failed"
                  ? t("dataset.failed", { name: item.name, error: item.error ?? "" })
                  : item.name}
            </span>
            {item.status === "ready" && item.dataset ? (
              <span class={styles.dataChipShape}>{datasetShape(item.dataset)}</span>
            ) : null}
            {item.status === "uploading" ? <span class={`${styles.thumbSpinner} spin`} /> : null}
            <button
              type="button"
              class={styles.dataChipRemove}
              aria-label={t("composer.removeAttachment", { name: item.name })}
              onClick={() => props.onRemove(item.id)}
            >
              <Icon name="x" size={12} />
            </button>
          </li>
        ) : (
          <li
            key={item.id}
            class={styles.thumb}
            data-status={item.status}
            title={item.error ?? item.name}
          >
            <img src={item.url} alt={item.name} />
            {item.status === "uploading" ? <span class={`${styles.thumbSpinner} spin`} /> : null}
            {item.status === "failed" ? (
              <span class={styles.thumbError} role="alert">
                {t("composer.uploadFailed")}
              </span>
            ) : null}
            <button
              type="button"
              class={styles.thumbRemove}
              aria-label={t("composer.removeAttachment", { name: item.name })}
              onClick={() => props.onRemove(item.id)}
            >
              <Icon name="x" size={12} />
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function ContextRing() {
  const usage = context.value;
  if (!usage) return null;
  const used = usage.estimated.toLocaleString();
  const percent = usage.total
    ? Math.min(100, Math.round((usage.estimated / usage.total) * 100))
    : 0;
  const label = usage.total
    ? t("composer.context", { used, total: usage.total.toLocaleString(), percent })
    : t("composer.contextUnknown", { used });
  const tone = !usage.total
    ? "unknown"
    : percent >= usage.compactionAt
      ? "danger"
      : percent >= usage.compactionAt * 0.8
        ? "warn"
        : "ok";
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <span class={styles.ring} data-tone={tone} role="img" aria-label={label} title={label}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r={r} class={styles.ringTrack} />
        <circle
          cx="11"
          cy="11"
          r={r}
          class={styles.ringValue}
          stroke-dasharray={`${(c * percent) / 100} ${c}`}
          transform="rotate(-90 11 11)"
        />
      </svg>
    </span>
  );
}

function SlashPalette(props: {
  items: CommandDescriptor[];
  active: number;
  onPick: (command: CommandDescriptor) => void;
}) {
  return (
    <div class={styles.palette}>
      <ul id={PALETTE_ID} role="listbox" aria-label={t("palette.label")} class={styles.paletteList}>
        {props.items.length ? (
          props.items.map((command, i) => (
            <li
              key={command.name}
              id={`${PALETTE_ID}-${i}`}
              role="option"
              aria-selected={i === props.active}
              class={styles.option}
              onMouseDown={(event) => {
                event.preventDefault();
                props.onPick(command);
              }}
            >
              <span class={styles.optionName}>
                /{command.name}
                {command.argumentHint ? (
                  <span class={styles.optionHint}> {command.argumentHint}</span>
                ) : null}
              </span>
              <span class={styles.optionDescription}>{command.description}</span>
              <span class={styles.optionSource}>
                {command.owner ?? t(`palette.source.${command.source}`)}
              </span>
            </li>
          ))
        ) : (
          <li class={styles.paletteEmpty}>{t("palette.empty")}</li>
        )}
      </ul>
    </div>
  );
}

/** The composer: textarea, `/` palette, permission preset, model + effort, context, send/stop. */
export function Composer() {
  const session = detail.value;
  const id = currentId.value;
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => (id ? loadDraft(id) : ""));
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  // The latest list for async upload callbacks.
  const current = useRef(attachments);
  current.current = attachments;

  useEffect(() => {
    setText(id ? loadDraft(id) : "");
    setHistoryIndex(undefined);
    for (const a of current.current) if (a.url) URL.revokeObjectURL(a.url);
    setAttachments([]);
  }, [id]);

  useEffect(() => {
    if (focusComposer.value) area.current?.focus();
  }, [focusComposer.value]);

  // Ingestion results of uploaded data files (frames), applied once each.
  const seenNotice = useRef(0);
  useEffect(() => {
    for (const notice of datasetNotices.value) {
      if (notice.n <= seenNotice.current) continue;
      seenNotice.current = notice.n;
      if (notice.sessionId !== id) continue;
      const outcome = notice.ready
        ? { ready: notice.ready }
        : notice.failed
          ? { failed: notice.failed }
          : undefined;
      if (outcome) setAttachments(applyDatasetOutcome(current.current, outcome));
    }
  }, [datasetNotices.value]);
  // A missed frame (the stream reconnected) must not leave a chip reading forever: poll the list.
  const reading = attachments.some((a) => a.kind === "dataset" && a.status === "uploading");
  useEffect(() => {
    if (!reading || !id) return;
    const timer = setInterval(() => {
      api.datasets(id).then(
        ({ items }) => setAttachments(applyPolledDatasets(current.current, items)),
        () => undefined,
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [reading, id]);

  // `@path` mentions and other insertions requested by the dock.
  useEffect(() => {
    const request = composerInsert.value;
    if (!request) return;
    const el = area.current;
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    const glue = before && !/\s$/.test(before) ? " " : "";
    update(`${before}${glue}${request.text}${text.slice(at)}`);
  }, [composerInsert.value?.n]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    const max = window.innerHeight * 0.4;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  const locked = session?.status === "locked";
  const child = !!session?.parentId;
  const disabled = !id || locked || child;
  const running = busy.value;
  const query = /^\/(\S*)$/.exec(text)?.[1];
  const matches =
    query !== undefined ? paletteRows(commands.value, query, goalInfo.value).slice(0, 12) : [];
  const paletteOpen = query !== undefined && !dismissed && !disabled;
  const index = Math.min(active, Math.max(0, matches.length - 1));

  const update = (value: string) => {
    setText(value);
    setDismissed(false);
    setActive(0);
    if (id) saveDraft(id, value);
  };

  const pick = (command: CommandDescriptor) => {
    update(`/${command.name} `);
    area.current?.focus();
  };

  const addFiles = (list: Iterable<File>) => {
    let next = current.current;
    const rejected = new Set<Rejection>();
    for (const file of list) {
      const problem = checkFile(file, next.length);
      if (problem) {
        rejected.add(problem);
        continue;
      }
      if (isDatasetFile(file) && id) {
        const dataItem: PendingAttachment = {
          id: newId(),
          name: file.name,
          url: "",
          bytes: file.size,
          status: "uploading",
          kind: "dataset",
        };
        next = [...next, dataItem];
        void api.uploadDataset(id, file).then(
          (answer) => {
            // 200: already ingested in this session. 202: a dataset_ready frame follows.
            if (answer.dataset)
              setAttachments(
                updateAttachment(current.current, dataItem.id, {
                  status: "ready",
                  dataset: answer.dataset,
                }),
              );
          },
          (error: unknown) =>
            setAttachments(
              updateAttachment(current.current, dataItem.id, {
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
        );
        continue;
      }
      const item: PendingAttachment = {
        id: newId(),
        name: file.name || "image",
        url: URL.createObjectURL(file),
        bytes: file.size,
        status: "uploading",
      };
      next = [...next, item];
      void api.upload(file).then(
        (ref) =>
          setAttachments(updateAttachment(current.current, item.id, { status: "ready", ref })),
        (error: unknown) =>
          setAttachments(
            updateAttachment(current.current, item.id, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
      );
    }
    current.current = next;
    setAttachments(next);
    for (const problem of rejected) showToast(t(`composer.reject.${problem}`));
  };

  const removeAttachment = (attachmentId: string) => {
    const item = current.current.find((a) => a.id === attachmentId);
    if (item?.url) URL.revokeObjectURL(item.url);
    const next = current.current.filter((a) => a.id !== attachmentId);
    current.current = next;
    setAttachments(next);
  };

  const sendable = canSend(text, attachments);
  const send = () => {
    if (disabled || !sendable) return;
    const value = text;
    const refs = readyRefs(attachments);
    const datasets = readyDatasets(attachments);
    const thumbs = attachments
      .filter((a) => a.status === "ready" && a.kind !== "dataset")
      .map((a) => a.url);
    update("");
    setHistoryIndex(undefined);
    current.current = [];
    setAttachments([]);
    void submit(value, refs.length ? { refs, thumbs } : undefined, datasets);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (composing.current || event.isComposing) return;
    // Shift+Tab cycles the main agents (build, plan, your own). The selector next to the
    // permissions menu is the accessible path: Shift+Tab normally moves the focus backwards.
    if (shiftTabCycles(event, { paletteOpen, composing: composing.current, disabled })) {
      event.preventDefault();
      void cycleAgent(1);
      return;
    }
    if (paletteOpen && matches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index + step + matches.length) % matches.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        const command = matches[index];
        // Enter on an exact, argument-free match runs it; otherwise it completes the name.
        if (
          !(
            event.key === "Enter" &&
            command &&
            `/${command.name}` === text &&
            !command.argumentHint
          )
        ) {
          event.preventDefault();
          if (command) pick(command);
          return;
        }
      }
    }
    if (event.key === "Escape" && paletteOpen) {
      event.preventDefault();
      setDismissed(true);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      send();
      return;
    }
    const el = area.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionEnd);
    if (
      event.key === "ArrowUp" &&
      !before.includes("\n") &&
      (historyIndex !== undefined || !text)
    ) {
      event.preventDefault();
      const step = historyStep(
        history.value,
        historyIndex,
        -1,
        historyIndex === undefined ? text : draft,
      );
      if (historyIndex === undefined) setDraft(text);
      setHistoryIndex(step.index);
      setText(step.text);
    } else if (event.key === "ArrowDown" && historyIndex !== undefined && !after.includes("\n")) {
      event.preventDefault();
      const step = historyStep(history.value, historyIndex, 1, draft);
      setHistoryIndex(step.index);
      setText(step.text);
    }
  };

  const presets = session?.presets ?? [];
  const preset = session?.preset ?? "workspace-write";
  const agents = agentList.value;
  const agentId = activeAgentId(session?.agent, agents);
  const agentName = agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const catalog = models.value;
  const model = session?.model ?? catalog?.model ?? "";
  const effort = session?.effort;
  const info = catalog?.models.find((m) => m.id === model);
  const levels = info?.effort?.supportedLevels ?? [];
  const placeholder = locked
    ? t("composer.locked")
    : child
      ? t("composer.child")
      : t("composer.placeholder");

  return (
    <div class={styles.dock}>
      <div
        class={styles.box}
        data-disabled={disabled ? "true" : undefined}
        data-dragging={dragging ? "true" : undefined}
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(event) => {
          if (disabled || !event.dataTransfer?.files.length) return;
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        {attachments.length ? <Thumbs items={attachments} onRemove={removeAttachment} /> : null}
        {paletteOpen ? <SlashPalette items={matches} active={index} onPick={pick} /> : null}
        <label class="sr-only" for="composer-input">
          {t("composer.label")}
        </label>
        <textarea
          id="composer-input"
          ref={area}
          class={styles.input}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={paletteOpen}
          aria-controls={paletteOpen ? PALETTE_ID : undefined}
          aria-activedescendant={
            paletteOpen && matches.length ? `${PALETTE_ID}-${index}` : undefined
          }
          onInput={(event) => update((event.target as HTMLTextAreaElement).value)}
          onPaste={(event) => {
            const pasted = [...(event.clipboardData?.files ?? [])].filter((f) =>
              f.type.startsWith("image/"),
            );
            if (!pasted.length) return;
            event.preventDefault();
            addFiles(pasted);
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        />
        <div class={styles.toolbar}>
          <button
            type="button"
            class={`icon-btn ${styles.round}`}
            disabled={disabled}
            aria-label={t("composer.attach")}
            title={t("composer.attach")}
            onClick={() => files.current?.click()}
          >
            <Icon name="plus" />
          </button>
          <input
            ref={files}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              if (input.files) addFiles(input.files);
              input.value = "";
            }}
          />
          <Menu
            label={t("composer.agentHint")}
            disabled={disabled || !agents.length}
            groups={[
              {
                items: agents.map((agent) => ({
                  id: agent.id,
                  label: agent.readOnly ? `${agent.name} · ${t("agents.readOnly")}` : agent.name,
                  description: agent.description,
                  checked: agent.id === agentId,
                })),
                onSelect: (value) => {
                  if (value !== agentId) void activateAgent(value);
                },
              },
            ]}
          >
            <Icon name="users" size={15} />
            <span class={styles.truncate}>{t("composer.agent", { agent: agentName })}</span>
            <Icon name="chevronDown" size={14} />
          </Menu>
          <Menu
            label={t("composer.preset", { preset: t(`preset.${preset}`) })}
            disabled={disabled || !presets.length}
            groups={[
              {
                items: presets.map((p) => ({
                  id: p.id,
                  label: t(`preset.${p.id}`),
                  description: p.reason ?? t(`presetHint.${p.id}`),
                  disabled: !p.available,
                  checked: p.id === preset,
                })),
                onSelect: (value) => {
                  // Full access is not a sandbox: say so before it is switched on.
                  if (
                    needsFullAccessConfirm(value as PermissionPresetId, preset) &&
                    !window.confirm(t("modes.fullConfirm"))
                  )
                    return;
                  void setPreset(value as PermissionPresetId);
                },
              },
            ]}
          >
            <Icon name="shield" size={15} />
            <span class={styles.truncate}>{t(`preset.${preset}`)}</span>
            <Icon name="chevronDown" size={14} />
          </Menu>
          <span class={styles.spacer} />
          <Menu
            label={t("composer.model")}
            align="end"
            disabled={disabled || !model}
            class={styles.modelTrigger}
            groups={[
              {
                label: catalog?.unavailable
                  ? t("composer.modelsUnavailable")
                  : t("composer.models"),
                items: (catalog?.models.length ? catalog.models : [{ id: model }]).map((m) => ({
                  id: m.id,
                  label: m.id,
                  checked: m.id === model,
                  disabled: running && m.id !== model,
                })),
                onSelect: (value) => {
                  if (value !== model) void setModel(value);
                },
              },
              ...(levels.length
                ? [
                    {
                      label: t("composer.effort"),
                      items: [
                        { id: "", label: t("composer.effortDefault"), checked: !effort },
                        ...levels.map((level) => ({
                          id: level,
                          label: level,
                          checked: level === effort,
                        })),
                      ],
                      onSelect: (value: string) => void setEffort(value || null),
                    },
                  ]
                : []),
            ]}
          >
            <span class={styles.truncate}>{model}</span>
            {effort ? <span class={styles.effort}>{effort}</span> : null}
            <Icon name="chevronDown" size={14} />
          </Menu>
          <ContextRing />
          {running && !text.trim() && !attachments.length ? (
            <button
              type="button"
              class={`${styles.send} ${styles.stop}`}
              aria-label={t("composer.stop")}
              title={t("composer.stop")}
              onClick={() => void cancelRun()}
            >
              {/* An arc circling the button while the run is active (static with reduced motion). */}
              <svg class={styles.stopRing} viewBox="0 0 36 36" aria-hidden="true" focusable="false">
                <circle class={styles.stopTrack} cx="18" cy="18" r="16.5" />
                <circle class={styles.stopArc} cx="18" cy="18" r="16.5" pathLength="100" />
              </svg>
              <Icon name="stop" size={20} class={styles.stopGlyph} />
            </button>
          ) : (
            <button
              type="button"
              class={styles.send}
              aria-label={t("composer.send")}
              title={t("composer.send")}
              disabled={disabled || !sendable}
              onClick={send}
            >
              <Icon name="arrowUp" size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
