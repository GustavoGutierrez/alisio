import { useState } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { copyText } from "../util/clipboard.ts";
import { Icon } from "./icons.tsx";

/** Copy action with a short "Copied" confirmation (announced through its label). */
export function CopyButton(props: {
  text: () => string;
  label?: string;
  class?: string;
  showText?: boolean;
}) {
  const [done, setDone] = useState(false);
  const label = done ? t("common.copied") : (props.label ?? t("common.copy"));
  return (
    <button
      type="button"
      class={props.class ?? "icon-btn"}
      aria-label={props.showText ? undefined : label}
      title={label}
      onClick={async () => {
        if (await copyText(props.text())) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={15} />
      {props.showText ? <span>{label}</span> : null}
    </button>
  );
}
