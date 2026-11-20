/** PostgreSQL JSONB rejects NUL and unpaired UTF-16 surrogates. Never strip source bytes. */
const tag = "citame-booksy-json-utf8-base64-v1";
export function packBooksyJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  const reserved = value !== null && typeof value === "object" && "__booksyEncoding" in value;
  if (reserved || /\\u0000|\\ud[89a-f][0-9a-f]{2}/i.test(serialized))
    return { __booksyEncoding: tag, base64: Buffer.from(serialized, "utf8").toString("base64") };
  return value;
}
export function unpackBooksyJson<T = unknown>(value: unknown): T {
  if (
    value &&
    typeof value === "object" &&
    "__booksyEncoding" in value &&
    value.__booksyEncoding === tag &&
    "base64" in value &&
    typeof value.base64 === "string" &&
    Object.keys(value).length === 2
  )
    return JSON.parse(Buffer.from(value.base64, "base64").toString("utf8")) as T;
  return value as T;
}
