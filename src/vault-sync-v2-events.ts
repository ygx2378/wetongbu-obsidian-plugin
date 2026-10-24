import type { VaultSyncV2EventTicket } from "./vault-sync-v2-remote.ts";

type TicketRemote = { createEventTicket(): Promise<VaultSyncV2EventTicket> };

type SocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type IntervalTimerHost = {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
};

type ReconnectTimerHost = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const MAX_RECONNECT_TIMER_DELAY_MS = 2_147_000_000;

export type VaultSyncEventStatus = "stopped" | "offline" | "connecting" | "connected" | "polling";
export type VaultSyncEventIssue =
  | "ticket_unauthorized"
  | "ticket_rate_limited"
  | "ticket_server_error"
  | "ticket_http_error"
  | "ticket_response_invalid"
  | "ticket_session_mismatch"
  | "ticket_transport_error"
  | "websocket_unavailable"
  | "websocket_open_timeout"
  | "websocket_ready_timeout"
  | `websocket_closed_before_open_${number}`
  | `websocket_closed_before_ready_${number}`
  | `websocket_closed_after_ready_${number}`
  | `websocket_closed_${number}`;

function eventSocketUrl(apiBaseUrl: string, targetId: string): string {
  const base = new URL(apiBaseUrl);
  if (base.protocol === "https:") base.protocol = "wss:";
  else if (base.protocol === "http:") base.protocol = "ws:";
  else throw new Error("Vault sync API URL must use HTTP or HTTPS");
  base.pathname = `/api/sync-targets/${targetId}/vault/events`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function retryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const candidate = error as { retryAfterMs?: unknown; retryAfterSeconds?: unknown };
  if (typeof candidate.retryAfterMs === "number" && Number.isFinite(candidate.retryAfterMs)) {
    return Math.max(0, candidate.retryAfterMs);
  }
  if (typeof candidate.retryAfterSeconds === "number" && Number.isFinite(candidate.retryAfterSeconds)) {
    return Math.max(0, candidate.retryAfterSeconds * 1000);
  }
  return 0;
}

function ticketIssue(error: unknown): VaultSyncEventIssue {
  if (!error || typeof error !== "object") return "ticket_transport_error";
  const candidate = error as { status?: unknown; code?: unknown };
  if (candidate.code === "invalid_event_ticket") return "ticket_response_invalid";
  if (candidate.code === "event_ticket_session_mismatch") return "ticket_session_mismatch";
  if (typeof candidate.status === "number" && Number.isInteger(candidate.status)) {
    if (candidate.status === 401 || candidate.status === 403) return "ticket_unauthorized";
    if (candidate.status === 429) return "ticket_rate_limited";
    if (candidate.status >= 500 && candidate.status <= 599) return "ticket_server_error";
    if (candidate.status >= 400 && candidate.status <= 499) return "ticket_http_error";
  }
  return "ticket_transport_error";
}

/** Wake the durable REST engine from server hints, with bounded reconnect and foreground fallback polling. */
export function createVaultSyncV2EventsClient(options: {
  apiBaseUrl: string;
  targetId: string;
  protocolEpoch: number;
  sessionGeneration: string;
  knownCursor?: string;
  remote: TicketRemote;
  onWake(): void | Promise<void>;
  onStatus?(status: VaultSyncEventStatus): void;
  onIssue?(issue: VaultSyncEventIssue): void;
  onReconnect?(): void;
  socketFactory?: (url: string) => SocketLike;
  intervalTimerHost?: IntervalTimerHost;
  reconnectTimerHost?: ReconnectTimerHost;
  pollMs?: number;
  reconcileMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  socketOpenTimeoutMs?: number;
  socketReadyTimeoutMs?: number;
  random?: () => number;
}) {
  const createSocket = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const intervalTimerHost = options.intervalTimerHost ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const reconnectTimerHost = options.reconnectTimerHost ?? {
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const pollMs = options.pollMs ?? 10_000;
  const reconcileMs = options.reconcileMs ?? 60_000;
  const reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
  const socketOpenTimeoutMs = options.socketOpenTimeoutMs ?? 15_000;
  const socketReadyTimeoutMs = options.socketReadyTimeoutMs ?? 10_000;
  const random = options.random ?? Math.random;
  let enabled = true;
  let online = true;
  let foreground = true;
  let started = false;
  let stopped = false;
  let connected = false;
  let hasConnected = false;
  let connecting = false;
  let sessionRefreshRequested = false;
  let retryCount = 0;
  let connectGeneration = 0;
  let socket: SocketLike | null = null;
  let reconnectTimer: unknown | null = null;
  let reconnectDueAt: number | null = null;
  let pollTimer: unknown | null = null;
  let reconcileTimer: unknown | null = null;
  let socketPhaseTimer: ReturnType<typeof setTimeout> | null = null;

  const active = () => started && !stopped && enabled && online && foreground;
  const status = (value: VaultSyncEventStatus) => options.onStatus?.(value);
  const wake = () => { void Promise.resolve(options.onWake()).catch(() => {}); };

  const clearReconnect = () => {
    if (reconnectTimer !== null) reconnectTimerHost.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectDueAt = null;
  };

  const armReconnect = (dueAt: number) => {
    const delay = Math.min(MAX_RECONNECT_TIMER_DELAY_MS, Math.max(0, dueAt - reconnectTimerHost.now()));
    reconnectTimer = reconnectTimerHost.setTimeout(() => {
      reconnectTimer = null;
      if (reconnectDueAt !== dueAt) return;
      if (reconnectTimerHost.now() < dueAt) {
        armReconnect(dueAt);
        return;
      }
      reconnectDueAt = null;
      if (active()) void connect();
    }, delay);
  };

  const clearSocketPhaseTimer = () => {
    if (socketPhaseTimer !== null) clearTimeout(socketPhaseTimer);
    socketPhaseTimer = null;
  };

  const closeSocket = () => {
    connectGeneration += 1;
    clearSocketPhaseTimer();
    const current = socket;
    socket = null;
    connected = false;
    connecting = false;
    if (current && current.readyState < 2) current.close(1000, "client inactive");
  };

  const scheduleReconnect = (error?: unknown) => {
    if (!active() || reconnectTimer !== null || connecting) return;
    retryCount += 1;
    const exponential = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** Math.min(retryCount - 1, 10)));
    const jittered = Math.round(exponential * (0.75 + Math.min(1, Math.max(0, random())) * 0.5));
    const delay = Math.max(retryAfterMs(error), Math.min(reconnectMaxMs, jittered));
    reconnectDueAt = reconnectTimerHost.now() + delay;
    armReconnect(reconnectDueAt);
  };

  async function connect() {
    if (!active() || connected || connecting || socket) return;
    const generation = ++connectGeneration;
    connecting = true;
    status("connecting");
    let stage: "ticket" | "websocket" = "ticket";
    try {
      const ticket = await options.remote.createEventTicket();
      if (generation !== connectGeneration) return;
      if (!active()) { connecting = false; return; }
      if (ticket.protocolEpoch !== options.protocolEpoch || ticket.sessionGeneration !== options.sessionGeneration
        || !/^[A-Za-z0-9_-]{40,64}$/.test(ticket.ticket)) {
        if (ticket.protocolEpoch !== options.protocolEpoch || ticket.sessionGeneration !== options.sessionGeneration) {
          // The ticket is authorized for the current device token, but the
          // local snapshot may still carry an older session fence. Wake the
          // durable REST engine immediately so it can reconcile that fence;
          // keep rejecting this socket until a fresh event client is created.
          if (!sessionRefreshRequested) {
            sessionRefreshRequested = true;
            wake();
          }
        }
        throw Object.assign(new Error("Vault sync event ticket does not match the active device session"), {
          code: "event_ticket_session_mismatch",
        });
      }
      sessionRefreshRequested = false;
      stage = "websocket";
      const current = createSocket(eventSocketUrl(options.apiBaseUrl, options.targetId));
      if (generation !== connectGeneration) { current.close(); return; }
      socket = current;
      let opened = false;
      let receivedReady = false;
      const armSocketPhaseTimeout = (phase: "open" | "ready", timeoutMs: number) => {
        clearSocketPhaseTimer();
        socketPhaseTimer = setTimeout(() => {
          if (socket !== current || (phase === "open" ? opened : receivedReady)) return;
          socketPhaseTimer = null;
          socket = null;
          connected = false;
          connecting = false;
          status("polling");
          options.onIssue?.(phase === "open" ? "websocket_open_timeout" : "websocket_ready_timeout");
          // Timeout owns the retry. Detach handlers before aborting so a
          // late close event cannot schedule a second retry for this socket.
          current.onopen = null;
          current.onmessage = null;
          current.onerror = null;
          current.onclose = null;
          try {
            if (current.readyState < 2) current.close(1000, `event ${phase} timeout`);
          } catch { /* the WebSocket implementation may already be closing */ }
          scheduleReconnect();
        }, timeoutMs);
      };
      armSocketPhaseTimeout("open", socketOpenTimeoutMs);
      current.onopen = () => {
        if (socket !== current) { current.close(); return; }
        if (!active()) return closeSocket();
        opened = true;
        armSocketPhaseTimeout("ready", socketReadyTimeoutMs);
        try {
          current.send(JSON.stringify({ type: "authenticate", ticket: ticket.ticket }));
        } catch {
          current.close();
        }
      };
      current.onmessage = (event) => {
        if (socket !== current) return;
        let frame: unknown;
        try { frame = JSON.parse(String(event.data)); } catch { current.close(4400, "invalid server frame"); return; }
        if (!frame || typeof frame !== "object") { current.close(4400, "invalid server frame"); return; }
        const value = frame as Record<string, unknown>;
        if (value.type === "ready") {
          if (value.protocolEpoch !== options.protocolEpoch || !positiveDecimal(value.sessionGeneration)
            || value.sessionGeneration !== options.sessionGeneration
            || !decimal(value.cursor)) {
            current.close(4401, "device session changed");
            return;
          }
          connected = true;
          connecting = false;
          receivedReady = true;
          clearSocketPhaseTimer();
          if (hasConnected) options.onReconnect?.();
          hasConnected = true;
          retryCount = 0;
          clearReconnect();
          status("connected");
          const knownCursor = options.knownCursor ?? "0";
          if (decimal(knownCursor) && BigInt(value.cursor) > BigInt(knownCursor)) wake();
          return;
        }
        if (value.type === "changed" && Object.keys(value).length === 1) {
          wake();
          return;
        }
        current.close(4400, "unexpected server frame");
      };
      current.onerror = () => current.close();
      current.onclose = (event) => {
        if (socket !== current) return;
        clearSocketPhaseTimer();
        socket = null;
        connected = false;
        connecting = false;
        if (active()) {
          status("polling");
          const closeCode = Number.isInteger(event?.code) && Number(event.code) >= 1000 && Number(event.code) <= 4999
            ? Number(event.code)
            : null;
          const closeStage = receivedReady ? "after_ready" : opened ? "before_ready" : "before_open";
          options.onIssue?.(closeCode === null
            ? `websocket_closed_${closeStage}_0`
            : `websocket_closed_${closeStage}_${closeCode}`);
          scheduleReconnect();
        } else status(online ? "stopped" : "offline");
      };
    } catch (error) {
      if (generation !== connectGeneration) return;
      connecting = false;
      connected = false;
      status("polling");
      options.onIssue?.(stage === "ticket" ? ticketIssue(error) : "websocket_unavailable");
      scheduleReconnect(error);
    }
  }

  const startTimers = () => {
    if (!active()) return;
    if (pollTimer === null) {
      pollTimer = intervalTimerHost.setInterval(() => {
        if (active() && !connected) wake();
      }, pollMs);
    }
    if (reconcileTimer === null) {
      reconcileTimer = intervalTimerHost.setInterval(() => {
        if (active()) wake();
      }, reconcileMs);
    }
  };

  const clearTimers = () => {
    if (pollTimer !== null) intervalTimerHost.clearInterval(pollTimer);
    if (reconcileTimer !== null) intervalTimerHost.clearInterval(reconcileTimer);
    pollTimer = null;
    reconcileTimer = null;
  };

  return {
    start() {
      if (stopped || started) return;
      started = true;
      if (active()) {
        startTimers();
        void connect();
      }
      else status(online ? "stopped" : "offline");
    },
    setEnabled(value: boolean) {
      enabled = value;
      if (!active()) {
        clearReconnect();
        clearTimers();
        closeSocket();
        status(online ? "stopped" : "offline");
      } else {
        startTimers();
        wake();
        void connect();
      }
    },
    setOnline(value: boolean) {
      online = value;
      if (!online) {
        clearReconnect();
        clearTimers();
        closeSocket();
        status("offline");
      } else if (active()) {
        startTimers();
        wake();
        void connect();
      }
    },
    setForeground(value: boolean) {
      foreground = value;
      if (!foreground) {
        clearReconnect();
        clearTimers();
        closeSocket();
        status(online ? "stopped" : "offline");
      } else if (active()) {
        startTimers();
        wake();
        void connect();
      }
    },
    stop() {
      stopped = true;
      clearReconnect();
      clearTimers();
      closeSocket();
      status("stopped");
    },
  };
}
