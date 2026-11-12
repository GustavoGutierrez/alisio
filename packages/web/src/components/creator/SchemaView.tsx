/**
 * The plugin's tables as a diagram (SVG boxes with key/link markers and curved connector lines)
 * or as plain tables. Screen readers always get the tables; the diagram is a labelled image.
 */
import type { PluginCreatorSchema } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import styles from "./creator.module.css";
import { SCHEMA_BOX, schemaLayout } from "./model.ts";
import { cr } from "./strings.ts";

function TableList({ schema, hidden }: { schema: PluginCreatorSchema; hidden?: boolean }) {
  return (
    <div class={hidden ? "sr-only" : styles.tableList}>
      {schema.tables.map((table) => (
        <table key={table.name}>
          <caption>{cr("dbTable", { name: table.name })}</caption>
          <thead>
            <tr>
              <th scope="col">{cr("dbColumn")}</th>
              <th scope="col">{cr("dbType")}</th>
              <th scope="col">{cr("dbNotes")}</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((column) => (
              <tr key={column.name}>
                <td>{column.name}</td>
                <td>
                  <code>{column.type || "—"}</code>
                </td>
                <td>
                  {[
                    column.pk ? cr("dbPk") : "",
                    column.fk ? cr("dbFk", { table: column.fk.table }) : "",
                    column.notNull && !column.pk ? cr("dbRequired") : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function Diagram({ schema }: { schema: PluginCreatorSchema }) {
  const layout = schemaLayout(schema);
  const { header, row, width } = SCHEMA_BOX;
  return (
    <div class={styles.diagramWrap}>
      <svg
        class={styles.diagram}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={cr("dbDiagram")}
      >
        <defs>
          <marker
            id="creator-fk-end"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" class={styles.linkEnd} />
          </marker>
        </defs>
        {layout.tables.map((table) => (
          <g key={table.name}>
            <rect
              class={styles.tableBox}
              x={table.x}
              y={table.y}
              width={table.width}
              height={table.height}
              rx={10}
            />
            <path
              class={styles.tableHead}
              d={`M${table.x + 1} ${table.y + header} V${table.y + 10} a9 9 0 0 1 9 -9 H${table.x + width - 10} a9 9 0 0 1 9 9 V${table.y + header} Z`}
            />
            <text class={styles.tableName} x={table.x + 12} y={table.y + header / 2 + 5}>
              {clip(table.name, 26)}
            </text>
            {table.columns.map((column) => (
              <g key={column.name}>
                {column.pk || column.fk ? (
                  <text
                    class={`${styles.marker} ${column.pk ? styles.pk : styles.fk}`}
                    x={table.x + 12}
                    y={column.y + 4}
                  >
                    {column.pk ? "PK" : "FK"}
                  </text>
                ) : null}
                <text class={styles.colName} x={table.x + 36} y={column.y + 4}>
                  {clip(column.name, 18)}
                </text>
                <text
                  class={styles.colType}
                  x={table.x + width - 12}
                  y={column.y + 4}
                  text-anchor="end"
                >
                  {clip(column.type, 10)}
                </text>
              </g>
            ))}
            {table.columns.length ? null : (
              <text class={styles.colType} x={table.x + 12} y={table.y + header + row / 2 + 4}>
                —
              </text>
            )}
          </g>
        ))}
        {layout.links.map((link) => (
          <path
            key={`${link.from}-${link.to}`}
            class={styles.link}
            d={link.path}
            marker-end="url(#creator-fk-end)"
          />
        ))}
      </svg>
    </div>
  );
}

export function SchemaView({ schema }: { schema: PluginCreatorSchema }) {
  const [list, setList] = useState(false);
  return (
    <div>
      <p class={styles.lead}>{cr("dbLead")}</p>
      <div class={`${styles.actions} ${styles.spaced}`}>
        <button type="button" class={styles.ghost} onClick={() => setList(!list)}>
          <Icon name={list ? "layers" : "fileTable"} size={15} />
          {list ? cr("dbDiagramView") : cr("dbListView")}
        </button>
      </div>
      {list ? (
        <TableList schema={schema} />
      ) : (
        <>
          <Diagram schema={schema} />
          <p class={styles.legend} aria-hidden="true">
            <span>
              <b data-k="pk">PK</b> {cr("dbPk")}
            </span>
            <span>
              <b data-k="fk">FK</b> {cr("dbFkLegend")}
            </span>
          </p>
          <TableList schema={schema} hidden />
        </>
      )}
    </div>
  );
}
