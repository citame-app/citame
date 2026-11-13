import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "tokens.css"), "utf8");

/** Extracts `--name: value;` declarations inside the first block that starts with `selector`. */
function declarations(source: string, selector: string): Record<string, string> {
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = source.slice(open + 1, end);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out[match[1] as string] = (match[2] as string).trim();
  }
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] as number) +
    0.7152 * (channels[1] as number) +
    0.0722 * (channels[2] as number)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = declarations(css, ":root {");
const dark = declarations(css, ':root[data-theme="dark"] {');

/** [foreground, background, minimum ratio]: 4.5 for text, 3 for UI boundaries and focus rings. */
const PAIRS: [string, string, number][] = [
  ["fg", "bg", 4.5],
  ["fg", "surface", 4.5],
  ["fg", "surface-sunken", 4.5],
  ["fg-muted", "bg", 4.5],
  ["fg-muted", "surface", 4.5],
  ["fg-muted", "surface-sunken", 4.5],
  ["accent-fg", "accent", 4.5],
  ["accent-fg", "accent-hover", 4.5],
  ["accent-text", "bg", 4.5],
  ["accent-text", "surface", 4.5],
  ["accent-soft-fg", "accent-soft", 4.5],
  ["danger-fg", "danger-soft", 4.5],
  ["success-fg", "success-soft", 4.5],
  ["warning-fg", "warning-soft", 4.5],
  ["danger-fg", "bg", 4.5],
  ["ring", "bg", 3],
  ["ring", "surface", 3],
  ["border-strong", "bg", 3],
  ["border-strong", "surface", 3],
  ["accent", "bg", 3],
];

describe("design tokens meet WCAG AA", () => {
  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    for (const [fg, bg, min] of PAIRS) {
      test(`${name}: ${fg} on ${bg} is at least ${min}:1`, () => {
        const fgValue = theme[fg];
        const bgValue = theme[bg];
        expect(fgValue).toMatch(/^#[0-9a-f]{6}$/i);
        expect(bgValue).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrast(fgValue as string, bgValue as string)).toBeGreaterThanOrEqual(min);
      });
    }
  }

  test("dark overrides define every color role the light theme defines", () => {
    const roles = Object.keys(light).filter((key) => /^#[0-9a-f]{6}$/i.test(light[key] ?? ""));
    for (const role of roles) expect(dark[role]).toBeDefined();
  });

  test("the system dark preference block is identical to the manual dark theme", () => {
    const media = declarations(css, ":root:not([data-theme])");
    expect(media).toEqual(dark);
  });
});
