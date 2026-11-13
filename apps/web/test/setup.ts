import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register the DOM before any test module imports Testing Library.
GlobalRegistrator.register({ url: "http://localhost:4173", width: 390, height: 844 });

const matchers = await import("@testing-library/jest-dom/matchers");
const { expect, afterEach } = await import("bun:test");
const { cleanup } = await import("@testing-library/react");

expect.extend(matchers);
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("data-theme");
});
