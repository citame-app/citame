import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

export const desktopBrowserSession = {
  id: "citame-desktop-browser-session",
  endpoints: {
    createDesktopBrowserSession: createAuthEndpoint.serverOnly(
      { method: "POST", body: z.object({ userId: z.string() }) },
      async (ctx) => {
        const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        if (!user || !user.emailVerified) throw ctx.error("FORBIDDEN");
        const session = await ctx.context.internalAdapter.createSession(user.id, true);
        if (!session) throw ctx.error("INTERNAL_SERVER_ERROR");
        await setSessionCookie(ctx, { user, session }, true);
        return ctx.json({ ok: true });
      },
    ),
  },
};
