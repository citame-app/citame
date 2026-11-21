import type { MeResponse, UserRole } from "@sob/contracts";

/** What a route family requires from the visitor. */
export type AccessRequirement = "public" | "guest" | "account" | "admin";

export type AccessDecision =
  | { type: "allow" }
  | { type: "signin" }
  | { type: "forbidden" }
  | { type: "redirect-home" };

export function resolveAccess(
  requirement: AccessRequirement,
  session: MeResponse | null,
): AccessDecision {
  switch (requirement) {
    case "public":
      return { type: "allow" };
    case "guest":
      return session ? { type: "redirect-home" } : { type: "allow" };
    case "account":
      return session ? { type: "allow" } : { type: "signin" };
    case "admin":
      if (!session) return { type: "signin" };
      return session.user.role === "client" ? { type: "forbidden" } : { type: "allow" };
  }
}

export function homeFor(role: UserRole): string {
  return role === "client" ? "/account" : "/admin/calendar";
}

const AUTH_PATHS = ["/sign-in", "/sign-up"];

/** Only same-site relative paths survive; everything else becomes the fallback. */
export function safeRedirect(target: string | undefined, fallback = "/"): string {
  if (!target) return fallback;
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\"))
    return fallback;
  for (const character of safeDecode(target)) {
    if (character.charCodeAt(0) < 32) return fallback;
  }
  const path = target.split("?")[0] ?? "";
  if (AUTH_PATHS.includes(path)) return fallback;
  return target;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type { MeResponse };
