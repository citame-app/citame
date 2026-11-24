type SignupResponse = { authResponse?: { code?: string } };
type FacebookSdk = {
  init(options: {
    appId: string;
    version: string;
    xfbml: boolean;
    autoLogAppEvents: boolean;
  }): void;
  login(
    callback: (response?: SignupResponse | null) => void,
    options: {
      config_id: string;
      response_type: "code";
      override_default_response_type: true;
      extras: { version: "v5"; setup: Record<string, never> };
    },
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const trustedOrigins = new Set(["https://www.facebook.com", "https://web.facebook.com"]);
const numericId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{5,32}$/.test(value);

export function readSignupEvent({ origin, data }: Pick<MessageEvent, "origin" | "data">) {
  if (!trustedOrigins.has(origin)) return null;
  try {
    const event = typeof data === "string" ? JSON.parse(data) : data;
    if (event?.type !== "WA_EMBEDDED_SIGNUP") return null;
    if (event.event === "CANCEL" || event.event === "ERROR") return { type: "cancel" } as const;
    if (!["FINISH", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"].includes(event.event)) return null;
    const accountIds = event.data?.messaging_account_ids;
    const wabaId =
      accountIds === undefined
        ? event.data?.waba_id
        : Array.isArray(accountIds) && accountIds.length === 1
          ? accountIds[0]
          : undefined;
    const phoneId = event.data?.phone_number_id;
    if (!numericId(wabaId) || (phoneId !== undefined && !numericId(phoneId)))
      return { type: "invalid" } as const;
    return { type: "success", wabaId, phoneId } as const;
  } catch {
    return null;
  }
}

let sdkLoad: Promise<FacebookSdk> | undefined;
export function loadFacebookSdk() {
  if (window.FB) return Promise.resolve(window.FB);
  sdkLoad ??= new Promise<FacebookSdk>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(fail, 15000);
    function fail() {
      window.clearTimeout(timer);
      window.fbAsyncInit = undefined;
      script.remove();
      sdkLoad = undefined;
      reject(new Error("WhatsApp SDK unavailable"));
    }
    window.fbAsyncInit = () => {
      if (!window.FB) return fail();
      window.clearTimeout(timer);
      window.fbAsyncInit = undefined;
      resolve(window.FB);
    };
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.onerror = fail;
    document.head.append(script);
  });
  return sdkLoad;
}

export function startMetaSignup(
  configId: string,
  pin: string,
  onComplete: (input: { code: string; wabaId: string; phoneId?: string; pin?: string }) => void,
  onError: (reason: "cancel" | "invalid") => void,
) {
  let code: string | undefined;
  let asset:
    | Extract<NonNullable<ReturnType<typeof readSignupEvent>>, { type: "success" }>
    | undefined;
  let ended = false;
  const timer = window.setTimeout(() => fail("cancel"), 420000);
  function clean() {
    ended = true;
    window.clearTimeout(timer);
    window.removeEventListener("message", onMessage);
  }
  function fail(reason: "cancel" | "invalid") {
    if (ended) return;
    clean();
    onError(reason);
  }
  function submit() {
    if (ended || !code || !asset) return;
    clean();
    onComplete({ code, wabaId: asset.wabaId, phoneId: asset.phoneId, pin: pin || undefined });
  }
  function onMessage(event: MessageEvent) {
    const result = readSignupEvent(event);
    if (!result) return;
    if (result.type !== "success") return fail(result.type);
    asset = result;
    submit();
  }
  window.addEventListener("message", onMessage);
  try {
    if (!window.FB) throw new Error("WhatsApp SDK unavailable");
    window.FB.login(
      (result) => {
        code = result?.authResponse?.code;
        if (!code) return fail("cancel");
        submit();
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { version: "v5", setup: {} },
      },
    );
  } catch {
    fail("invalid");
  }
  return clean;
}
