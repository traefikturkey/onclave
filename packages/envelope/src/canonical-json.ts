export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalJson(value: unknown): string {
  // #lizard forgives: ported verbatim from v1 onclave-comms canonical-json
  return stringifyCanonical(value, "$.");
}

function stringifyCanonical(value: unknown, path: string): string {
  if (value === null) return "null";

  const valueType = typeof value;
  switch (valueType) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonical JSON only supports finite numbers at ${path}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      throw new Error(`canonical JSON does not support undefined at ${path}`);
    case "bigint":
    case "function":
    case "symbol":
      throw new Error(`canonical JSON does not support ${valueType} at ${path}`);
    case "object":
      if (value === null) return "null";
      return stringifyObjectOrArray(value as object, path);
    default:
      throw new Error(`canonical JSON does not support ${valueType} at ${path}`);
  }
}

function stringifyObjectOrArray(value: object, path: string): string {
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => stringifyCanonical(item, `${path}[${index}]`)).join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`canonical JSON only supports plain objects at ${path}`);
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => {
      const encodedKey = JSON.stringify(key);
      const encodedValue = stringifyCanonical(record[key], `${path}${key}.`);
      return `${encodedKey}:${encodedValue}`;
    });

  return `{${entries.join(",")}}`;
}
