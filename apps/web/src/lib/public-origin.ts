/** Plain HTTP(S) origins only: never carry credentials, secret query strings or paths into links. */
export function publicOrigin(raw: string): string {
  const value = raw.trim();
  if (
    !value ||
    [...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    value.includes("*")
  )
    throw new Error("Use an exact HTTP(S) origin");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw new Error("Use an exact HTTP(S) origin without a path or credentials");
  return url.origin;
}
