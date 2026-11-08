/** Header button of the Settings dialog: maximize or restore it. Hook-free and presentational. */
import { t } from "../../i18n/index.ts";
import { Icon } from "../icons.tsx";

export function MaximizeToggle(props: { maximized: boolean; onToggle: () => void }) {
  const label = t(props.maximized ? "settings.restore" : "settings.maximize");
  return (
    <button
      type="button"
      class="icon-btn"
      aria-label={label}
      aria-pressed={props.maximized}
      title={label}
      onClick={props.onToggle}
    >
      <Icon name={props.maximized ? "shrink" : "expand"} size={18} />
    </button>
  );
}
