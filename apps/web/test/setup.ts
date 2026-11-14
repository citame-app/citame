import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Keep Bun's native Web API: happy-dom's versions follow browser rules (forbidden headers such
// as Cookie and Set-Cookie), which is wrong for server-side code under test.
const nativeKeys = ["fetch", "Request", "Response", "Headers", "FormData"] as const;
const native = Object.fromEntries(
  nativeKeys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
);
(globalThis as Record<string, unknown>).__nativeWebApi = native;

// Register the DOM before any test module imports Testing Library.
GlobalRegistrator.register({ url: "http://localhost:4173", width: 390, height: 844 });

const matchers = await import("@testing-library/jest-dom/matchers");
const { expect, afterEach } = await import("bun:test");
const { cleanup } = await import("@testing-library/react");

expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);

// Component tests render without a router: links become plain anchors and navigation hooks no-ops.
const { mock } = await import("bun:test");
const React = await import("react");
const router = await import("@tanstack/react-router");
function MockLink({
  to,
  children,
  className,
  ...rest
}: {
  to?: string;
  children?: unknown;
  className?: string;
}) {
  return React.createElement(
    "a",
    {
      href: String(to ?? "#"),
      className,
      "aria-label": (rest as Record<string, string>)["aria-label"],
      "aria-current": (rest as Record<string, string>)["aria-current"],
    },
    children as never,
  );
}
mock.module("@tanstack/react-router", () => ({
  ...router,
  Link: MockLink,
  useNavigate: () => () => Promise.resolve(),
  // Tests drive the unsaved-changes blocker through these globals.
  useBlocker: (options: unknown) => {
    (globalThis as Record<string, unknown>).__blockerOptions = options;
    return (
      (globalThis as { __blockerState?: unknown }).__blockerState ?? {
        status: "idle",
        proceed() {},
        reset() {},
      }
    );
  },
  useRouter: () => ({ invalidate: () => Promise.resolve(), navigate: () => Promise.resolve() }),
}));
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("data-theme");
});
