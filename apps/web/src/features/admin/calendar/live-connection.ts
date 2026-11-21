import {
  type SyncChange,
  type SyncLiveView,
  type SyncPullResponse,
  syncNudgeSchema,
} from "@sob/contracts";
import { ApiError } from "~/lib/api/client";

const EVENT_SOURCE_CLOSED = 2;
const DEFAULT_FALLBACK_MS = 30_000;

export interface LiveSource {
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  addEventListener(type: "change", listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

/** One stream per admin session. The cursor survives EventSource reconnects, but never sign-out. */
export function connectCalendarLive(options: {
  open: () => LiveSource;
  pull: (since: number, signal: AbortSignal) => Promise<SyncPullResponse>;
  onChanges: (changes: SyncChange[], refresh: SyncLiveView[]) => void;
  onRefresh: () => void;
  onConnection: (live: boolean) => void;
  onAccessExpired?: () => void;
  fallbackMs?: number;
  networkTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
}) {
  const abort = new AbortController();
  let source = options.open();
  let cursor: number | null = null;
  let targetSeq = 0;
  let generation: string | undefined;
  let history = 0;
  let running = false;
  let stopped = false;
  let forcePull = false;
  let connected = false;
  let reconcileOnOpen = false;
  let networkAvailable = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function baseline(seq: number, nextGeneration?: string) {
    generation = nextGeneration;
    cursor = targetSeq = seq;
    history++;
    options.onRefresh();
  }

  async function drain(force = false) {
    if (stopped || cursor === null) return;
    forcePull ||= force;
    if (running || !networkAvailable || retryTimer !== undefined) return;
    running = true;
    let requestedHistory = history;
    try {
      while (!stopped && networkAvailable && (forcePull || cursor < targetSeq)) {
        forcePull = false;
        const previous: number = cursor;
        requestedHistory = history;
        const response = await options.pull(previous, abort.signal);
        if (stopped) return;
        if (requestedHistory !== history) continue;
        if (generation && response.generation && generation !== response.generation) {
          baseline(response.headSeq, response.generation);
          continue;
        }
        generation ??= response.generation;
        const fresh = response.changes.filter((change) => change.seq > previous);
        if (fresh.length || response.refresh?.length)
          options.onChanges(fresh, response.refresh ?? []);
        if (connected) options.onConnection(true);
        cursor = Math.max(previous, response.nextCursor);
        targetSeq = Math.max(targetSeq, response.headSeq);
        if (cursor === previous && !forcePull) break; // Empty or filtered pages must never spin.
      }
    } catch (error) {
      if (requestedHistory !== history) {
        queueMicrotask(() => void drain());
        return;
      }
      if (!stopped) {
        options.onConnection(false);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          options.onAccessExpired?.();
          stop();
        } else if (error instanceof ApiError && error.status === 429) {
          const retryMs = Math.max(1, error.retryAfterSeconds ?? DEFAULT_FALLBACK_MS / 1000) * 1000;
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            recover();
          }, retryMs);
        } else if (error instanceof ApiError && error.code === "invalid_state") {
          // Server restored from backup: establish a fresh baseline, without replaying history.
          cursor = null;
          targetSeq = 0;
          reopen();
        }
      }
    } finally {
      running = false;
    }
  }
  function attachSource(current: LiveSource) {
    current.onopen = () => {
      if (stopped || !networkAvailable || source !== current) return;
      connected = true;
      if (retryTimer === undefined) options.onConnection(true);
      if (reconcileOnOpen) {
        reconcileOnOpen = false;
        options.onRefresh();
      }
      void drain(true);
    };
    current.onerror = () => {
      if (stopped || !networkAvailable || source !== current) return;
      connected = false;
      reconcileOnOpen ||= cursor !== null;
      options.onConnection(false);
      if (current.readyState === EVENT_SOURCE_CLOSED) options.onAccessExpired?.();
    };
    current.addEventListener("change", (event) => {
      if (stopped || !networkAvailable || source !== current) return;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = syncNudgeSchema.safeParse(payload);
      if (!parsed.success) return;
      const { seq, generation: nextGeneration } = parsed.data;
      if (cursor === null || (generation && nextGeneration && generation !== nextGeneration)) {
        baseline(seq, nextGeneration); // Reconcile without replaying historical notices.
      } else {
        generation ??= nextGeneration;
        targetSeq = Math.max(targetSeq, seq);
        void drain();
      }
    });
  }
  attachSource(source);
  const offline = () => {
    networkAvailable = false;
    connected = false;
    reconcileOnOpen ||= cursor !== null;
    source.close();
    options.onConnection(false);
  };
  function reopen() {
    if (stopped || !networkAvailable) return;
    connected = false;
    source.close();
    source = options.open();
    attachSource(source);
  }
  const online = () => {
    networkAvailable = true;
    recover();
  };
  options.networkTarget?.addEventListener("offline", offline);
  options.networkTarget?.addEventListener("online", online);
  function recover() {
    if (stopped || !networkAvailable || retryTimer !== undefined) return;
    // A terminal HTTP error leaves EventSource closed. CONNECTING already has a native retry.
    if (source.readyState === EVENT_SOURCE_CLOSED) reopen();
    if (cursor === null) options.onRefresh();
    else void drain(true);
  }
  const fallback = setInterval(recover, options.fallbackMs ?? DEFAULT_FALLBACK_MS);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(fallback);
    clearTimeout(retryTimer);
    abort.abort();
    source.close();
    options.networkTarget?.removeEventListener("offline", offline);
    options.networkTarget?.removeEventListener("online", online);
  }
  return stop;
}
