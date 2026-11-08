/**
 * Eden's live feed over /ws: send {"subscribe": "<channel>"}, receive {"channel", "type", "data"} frames.
 * Channels: "feed" (every trade, launch and graduation), "token:<address>", "wallet:<address>". Uses the global
 * WebSocket (Node 22+, browsers) and reconnects with backoff, re-subscribing every channel.
 */
import { DEFAULT_WS_URL } from "./constants.ts";
import { EdenError } from "./errors.ts";
import type { LiveFrame } from "./types.ts";

export type LiveOptions = {
  url?: string;
  channels?: string[];
  onFrame: (frame: LiveFrame) => void;
  onStatus?: (connected: boolean) => void;
  onError?: (error: unknown) => void;
  /** Reconnect after a drop (default true). */
  reconnect?: boolean;
  WebSocket?: typeof WebSocket;
};

export type LiveSubscription = {
  subscribe(channel: string): void;
  unsubscribe(channel: string): void;
  close(): void;
  readonly connected: boolean;
  /** Resolves once the first connection is open. */
  ready: Promise<void>;
};

const CHANNEL = /^(feed|(token|wallet):0x[0-9a-fA-F]{40})$/;

export function channelFor(kind: "feed" | "token" | "wallet", address?: string): string {
  return kind === "feed" ? "feed" : `${kind}:${(address ?? "").toLowerCase()}`;
}

export function subscribeLive(o: LiveOptions): LiveSubscription {
  const WS = o.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new EdenError("unsupported", "No global WebSocket: use Node 22+ or pass a WebSocket implementation.");
  const Socket: typeof WebSocket = WS;
  const url = o.url ?? DEFAULT_WS_URL;
  const channels = new Set<string>();
  for (const c of o.channels ?? ["feed"]) add(c);
  let socket: WebSocket | undefined, closed = false, connected = false, attempt = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });

  function add(c: string) {
    if (!CHANNEL.test(c)) throw new EdenError("invalid:channel", `"${c}" is not a channel: use feed, token:<address> or wallet:<address>.`);
    channels.add(c.toLowerCase());
  }
  function send(m: object) { if (socket && socket.readyState === 1) socket.send(JSON.stringify(m)); }
  function connect() {
    socket = new Socket(url);
    socket.onopen = () => {
      connected = true; attempt = 0;
      for (const c of channels) send({ subscribe: c });
      o.onStatus?.(true);
      resolveReady();
    };
    socket.onmessage = (m: MessageEvent) => {
      try { o.onFrame(JSON.parse(String(m.data)) as LiveFrame); } catch (e) { o.onError?.(e); }
    };
    socket.onerror = (e: Event) => o.onError?.(e);
    socket.onclose = () => {
      const was = connected;
      connected = false;
      if (was) o.onStatus?.(false);
      if (!closed && (o.reconnect ?? true)) setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
    };
  }
  connect();
  return {
    subscribe(c) { add(c); send({ subscribe: c.toLowerCase() }); },
    unsubscribe(c) { channels.delete(c.toLowerCase()); send({ unsubscribe: c.toLowerCase() }); },
    close() { closed = true; socket?.close(); },
    get connected() { return connected; },
    ready,
  };
}
