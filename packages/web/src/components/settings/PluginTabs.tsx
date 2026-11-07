import { nextTab } from "./catalog-model.ts";
import styles from "./settings.module.css";

export interface TabSpec<T extends string> {
  id: T;
  label: string;
}

/**
 * Accessible tab list: roving tabindex, `aria-controls` to the panel `plugins-panel-<id>`, and the
 * arrow keys, Home and End move and activate the neighbouring tab.
 */
export function PluginTabs<T extends string>(props: {
  tabs: TabSpec<T>[];
  active: T;
  label: string;
  onSelect: (id: T) => void;
}) {
  const ids = props.tabs.map((tab) => tab.id);
  return (
    <div class={styles.tabs} role="tablist" aria-label={props.label}>
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`plugins-tab-${tab.id}`}
          class={styles.tab}
          aria-selected={props.active === tab.id}
          aria-controls={`plugins-panel-${tab.id}`}
          tabIndex={props.active === tab.id ? 0 : -1}
          onClick={() => props.onSelect(tab.id)}
          onKeyDown={(event: { key: string; preventDefault(): void }) => {
            const next = nextTab(ids, props.active, event.key);
            if (!next) return;
            event.preventDefault();
            props.onSelect(next);
            document.getElementById(`plugins-tab-${next}`)?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
