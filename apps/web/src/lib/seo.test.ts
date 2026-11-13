import { describe, expect, test } from "bun:test";
import { pageMeta } from "./seo";

describe("pageMeta", () => {
  const meta = pageMeta({
    title: "Book an appointment",
    description: "Choose your services and a time.",
    siteName: "Sisters of Beauty",
    locale: "es-AR",
  });
  const find = (key: "name" | "property", value: string) =>
    meta.find((entry) => (entry as Record<string, string>)[key] === value) as
      | Record<string, string>
      | undefined;

  test("sets a title that carries the site name", () => {
    expect(meta.find((e) => "title" in e)).toEqual({
      title: "Book an appointment · Sisters of Beauty",
    });
  });

  test("describes the page for search engines and social previews", () => {
    expect(find("name", "description")?.content).toBe("Choose your services and a time.");
    expect(find("property", "og:title")?.content).toBe("Book an appointment · Sisters of Beauty");
    expect(find("property", "og:description")?.content).toBe("Choose your services and a time.");
    expect(find("property", "og:type")?.content).toBe("website");
    expect(find("property", "og:site_name")?.content).toBe("Sisters of Beauty");
    expect(find("name", "twitter:card")?.content).toBe("summary");
  });

  test("declares the language as an underscore locale for Open Graph", () => {
    expect(find("property", "og:locale")?.content).toBe("es_AR");
  });

  test("the home page title is just the site name", () => {
    const home = pageMeta({
      title: "Sisters of Beauty",
      description: "x",
      siteName: "Sisters of Beauty",
      locale: "en",
    });
    expect(home.find((e) => "title" in e)).toEqual({ title: "Sisters of Beauty" });
  });

  test("private pages can opt out of indexing", () => {
    const priv = pageMeta({
      title: "Account",
      description: "x",
      siteName: "S",
      locale: "en",
      noindex: true,
    });
    expect(priv.find((e) => (e as Record<string, string>).name === "robots")).toEqual({
      name: "robots",
      content: "noindex, nofollow",
    });
  });
});
