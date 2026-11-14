import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { api } from "~/lib/api/instance";
import { homeFor, safeRedirect } from "~/lib/auth/access";
import { bootstrapQuery } from "~/server/request";
import type { SignInValues, SignUpValues } from "./validate";

export interface AuthOptions {
  /** Where to go afterwards (sanitized). Defaults to the role's home. */
  redirectTo?: string;
  /** Stay on the current page, e.g. when signing in inline during booking. */
  stay?: boolean;
  /**
   * The signed query of an OAuth authorization request that sent the visitor here. The server
   * resumes that flow after the credentials check and answers with the URL to open next
   * (usually the consent screen, which is a page of this app).
   */
  oauthQuery?: string;
}

/** Session mutations. Each one refreshes the cached session so every route guard re-evaluates. */
export function useAuth() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();

  async function refreshSession() {
    let session = null;
    try {
      session = await api().me();
    } catch {
      session = null;
    }
    queryClient.setQueryData(bootstrapQuery.queryKey, (previous) =>
      previous ? { ...previous, session } : previous,
    );
    await router.invalidate();
    return session;
  }

  async function afterAuth(options: AuthOptions, continueTo?: string) {
    const session = await refreshSession();
    if (options.oauthQuery && continueTo) {
      // A full navigation: the target may be the consent page or an external client redirect.
      window.location.assign(continueTo);
      return;
    }
    if (options.stay) return;
    await navigate({
      to: safeRedirect(options.redirectTo, session ? homeFor(session.user.role) : "/"),
      replace: true,
    });
  }

  return {
    refreshSession,
    async signIn(values: SignInValues, options: AuthOptions = {}) {
      const next = await api().auth.signIn(values, options.oauthQuery);
      await afterAuth(options, next.url);
    },
    async signUp(values: SignUpValues, options: AuthOptions = {}) {
      const next = await api().auth.signUp(values, options.oauthQuery);
      await afterAuth(options, next.url);
    },
    async signOut() {
      await api().auth.signOut();
      queryClient.removeQueries({ queryKey: ["appointments"] });
      await refreshSession();
      await navigate({ to: "/" });
    },
  };
}
