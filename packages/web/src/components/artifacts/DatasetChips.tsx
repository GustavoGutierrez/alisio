import type { DatasetRef } from "@alisio/sdk";
import { t } from "../../i18n/index.ts";
import { openDataset } from "../../store/artifacts.ts";
import { Icon } from "../icons.tsx";
import styles from "./datasets.module.css";

/** `12,480 rows × 6 columns`, or the number of sheets for a workbook. */
export function datasetShape(dataset: DatasetRef): string {
  const [only] = dataset.sheets;
  return dataset.sheets.length === 1 && only
    ? t("dataset.shape", {
        rows: only.rows.toLocaleString("en-US"),
        columns: only.columns,
      })
    : t("dataset.sheets", { count: dataset.sheets.length });
}

/** Chips of the datasets a prompt attached; each opens its table in the right panel. */
export function DatasetChips(props: { datasets: DatasetRef[] }) {
  return (
    <ul class={styles.chips} aria-label={t("dataset.attached")}>
      {props.datasets.map((dataset) => (
        <li key={dataset.id}>
          <button
            type="button"
            class={styles.chip}
            title={dataset.name}
            aria-label={t("dataset.open", { name: dataset.name })}
            onClick={(event) => openDataset(dataset, event.currentTarget as HTMLElement)}
          >
            <Icon name="fileTable" size={15} />
            <span class={styles.chipName}>{dataset.name}</span>
            <span class={styles.chipShape}>{datasetShape(dataset)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
