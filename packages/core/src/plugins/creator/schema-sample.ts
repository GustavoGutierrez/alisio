/**
 * A minimal input for a tool's JSON Schema, for the build's smoke call: only the required
 * properties, each with its `default`, `const`, first `enum` value or the smallest value its
 * bounds allow. The caller still validates the result with the real registry and skips the
 * smoke call when it does not fit (a `pattern` or a `format` can make that impossible).
 */
type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema =>
  !!value && typeof value === "object" && !Array.isArray(value);

const firstType = (schema: Schema): string | undefined => {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.find((t) => typeof t === "string");
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options)) {
      const option = options.find(isSchema);
      if (option) return firstType(option);
    }
  }
  if (isSchema(schema.properties)) return "object";
  return undefined;
};

export function sampleInput(schema: unknown, depth = 0): unknown {
  if (!isSchema(schema) || depth > 8) return undefined;
  if ("default" in schema) return structuredClone(schema.default);
  if ("const" in schema) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return structuredClone(schema.enum[0]);
  const variant = ["anyOf", "oneOf"]
    .map((key) => schema[key])
    .find((options): options is unknown[] => Array.isArray(options));
  if (variant && !schema.type) return sampleInput(variant.find(isSchema), depth + 1);
  switch (firstType(schema)) {
    case "string": {
      const min = typeof schema.minLength === "number" ? schema.minLength : 1;
      return "a".repeat(Math.max(1, min));
    }
    case "integer":
    case "number": {
      if (typeof schema.minimum === "number") return Math.ceil(schema.minimum);
      if (typeof schema.exclusiveMinimum === "number")
        return Math.floor(schema.exclusiveMinimum) + 1;
      if (typeof schema.maximum === "number" && schema.maximum < 1)
        return Math.floor(schema.maximum);
      return 1;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    case "array": {
      const min = typeof schema.minItems === "number" ? schema.minItems : 0;
      return Array.from({ length: min }, () => sampleInput(schema.items, depth + 1));
    }
    case "object": {
      const out: Record<string, unknown> = {};
      const properties = isSchema(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const key of required)
        if (typeof key === "string") out[key] = sampleInput(properties[key], depth + 1);
      return out;
    }
    default:
      return undefined;
  }
}
