/**
 * Name hints of the dashboard profiler (spec 6.1) and the goal vocabulary of the rule planner
 * (spec 6.2). Tables of whole words in English and Spanish, normalized without accents. Pure.
 */

/** `Año Fiscal ($)` → `ano_fiscal`: lowercase, no accents, `_` between words, never padded. */
export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

/** A name that talks about quantities of something. */
const MAGNITUDE =
  words(`amount amounts total totals sales sale revenue revenues price prices cost costs
  profit profits margin margins qty quantity units venta ventas ingreso ingresos monto montos importe
  importes precio precios costo costos ganancia ganancias utilidad utilidades margen margenes cantidad
  cantidades unidades`);
/** Numeric-looking columns that are not measures. */
const NEGATIVE = words(`lat lon lng latitude longitude zip postal phone telefono year anio`);
const DIMENSION =
  words(`category status type region channel segment seller country city categoria estado
  tipo canal segmento vendedor pais ciudad`);
const TIME = words(`date fecha time created order pedido`);
/** Rates, prices and scores: averaged rather than summed. */
const AVERAGE =
  words(`price prices rate rates tasa tasas ratio pct percent percentage porcentaje margin
  margen avg average promedio rating precio precios score`);

export interface NameHints {
  magnitude: boolean;
  negative: boolean;
  dimension: boolean;
  time: boolean;
  average: boolean;
}

function tokensOf(...texts: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const text of texts)
    for (const token of normalizeName(text).split("_")) if (token) tokens.add(token);
  return tokens;
}

const anyOf = (tokens: Set<string>, table: ReadonlySet<string>): boolean => {
  for (const token of tokens) if (table.has(token)) return true;
  return false;
};

/** Hints from the sanitized column name and its original header, matched by whole word. */
export function hintsOf(name: string, label: string): NameHints {
  const tokens = tokensOf(name, label);
  return {
    magnitude: anyOf(tokens, MAGNITUDE),
    negative: anyOf(tokens, NEGATIVE),
    dimension: anyOf(tokens, DIMENSION),
    time: anyOf(tokens, TIME),
    average: anyOf(tokens, AVERAGE),
  };
}

/** `(^|_)(id|uuid|…)(_|$)` over the normalized name or header. */
const IDENTIFIER_NAME = /(?:^|_)(?:id|uuid|guid|code|codigo|sku|ref|key|folio|nro|num)(?:_|$)/;
export function looksLikeIdentifierName(name: string, label: string): boolean {
  return [name, label].some((text) => IDENTIFIER_NAME.test(normalizeName(text)));
}

/** Words of the goal (normalized, accent-free) that pick the dashboard purpose, in priority order. */
export const PURPOSE_WORDS: ReadonlyArray<{
  purpose: "executive" | "operational" | "analytical";
  words: readonly string[];
}> = [
  { purpose: "executive", words: ["executive", "overview", "resumen", "ejecutivo", "kpi"] },
  { purpose: "operational", words: ["operational", "monitor", "status", "operativo", "estado"] },
  { purpose: "analytical", words: ["analy", "analis", "compar", "explor"] },
];

/** Goal words that name a measure, with the column words that satisfy them. */
export const MEASURE_SYNONYMS: ReadonlyArray<{
  goal: readonly string[];
  column: ReadonlySet<string>;
}> = [
  {
    goal: ["sales", "ventas", "venta", "ingreso", "revenue"],
    column: words(
      "sales sale ventas venta ingresos ingreso revenue revenues amount amounts monto montos importe importes",
    ),
  },
  {
    goal: ["profit", "rentabilidad", "utilidad", "ganancia", "margin", "margen"],
    column: words(
      "profit profits rentabilidad utilidad utilidades ganancia ganancias margin margen",
    ),
  },
  { goal: ["cost", "costo", "gasto"], column: words("cost costs costo costos gasto gastos") },
  {
    goal: ["quantity", "cantidad", "unidades", "units"],
    column: words("quantity qty cantidad units unidades"),
  },
];

/** The tokens of a column (name and header), for matching against the synonym tables. */
export function columnTokens(name: string, label: string): Set<string> {
  return tokensOf(name, label);
}

/** Dimension words that mean the same in English and Spanish (spec 6.2, goal-aware planning). */
export const DIMENSION_SYNONYMS: ReadonlyArray<ReadonlySet<string>> = [
  words("category categories categoria categorias"),
  words("status estado"),
  words("seller salesperson salesman rep vendedor vendedora vendedores"),
  words("type tipo"),
  words("region regiones"),
  words("channel canal"),
  words("segment segmento"),
  words("country pais"),
  words("city ciudad"),
  words("product producto"),
  words("customer client cliente"),
  words("payment pago"),
  words("discount descuento"),
  words("date fecha"),
  words("month mes"),
  words("year ano anio"),
  words("quarter trimestre"),
  words("rating calificacion"),
  words("delivery entrega envio"),
];

/** Groups of words that name the same thing: the measure synonyms (goal and column side) and the dimension ones. */
export const SYNONYM_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  ...MEASURE_SYNONYMS.map((entry) => new Set([...entry.goal, ...entry.column])),
  ...DIMENSION_SYNONYMS,
];
