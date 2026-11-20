/** The audience for first-party desktop access tokens. */
export const desktopResource = (base: string) => `${base.replace(/\/+$/, "")}/api/auth/desktop`;
