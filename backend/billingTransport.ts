import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RELAY_STATUS_URL,
  RELAY_WAKE_URL,
  SCHEDULER_SUPABASE_URL,
  WEB_DISPATCH_URL,
  schedulerEnabled,
  schedulerHeaders,
  schedulerSecret,
  verifySchedulerProof,
  type SchedulerEnv,
  type SchedulerPurpose,
} from "../shared/billingDispatch";

type Identity = { database: string; site: string };
type Event =
  | "configuration_unavailable"
  | "dispatch_processed"
  | "dispatch_duplicate_or_denied"
  | "dispatch_disabled"
  | "dispatch_unavailable"
  | "dispatch_rejected";
type Dependencies = {
  request?: typeof fetch;
  now?: () => number;
  observe?: (event: Event) => void;
};
const EMPTY = Buffer.from("{}");
const SITE = "https://cluera-ai-staging.vercel.app";
const RELAY_HOST = "cluera-ai-relay-staging.onrender.com";
const WAKE_PATH = new URL(RELAY_WAKE_URL).pathname,
  STATUS_PATH = new URL(RELAY_STATUS_URL).pathname;

/** Transport only. No database/provider clients, local credential discovery,
 * self-keepalive, immediate retries or assumption that a free service stays awake. */
export function createRenderBillingTransport(
  identity: Identity,
  env: SchedulerEnv = process.env,
  dependencies: Dependencies = {},
) {
  const key = schedulerSecret(env),
    gate = schedulerEnabled(env);
  const configured =
    identity.database === SCHEDULER_SUPABASE_URL &&
    identity.site === SITE &&
    key !== null;
  const enabled = configured && gate,
    request = dependencies.request ?? fetch,
    now = dependencies.now ?? Date.now;
  let started = false,
    stopped = false,
    lastMinute = -1,
    busy: Promise<void> | undefined,
    controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inbound = new Set<() => void>();
  const observe = (event: Event) => {
    try {
      dependencies.observe?.(event);
    } catch {
      /* Fixed diagnostics cannot break the relay. */
    }
  };
  const reply = (
    response: ServerResponse,
    status: number,
    body: string,
    close = false,
    source?: IncomingMessage,
  ) => {
    if (response.destroyed || response.writableEnded) return;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Type", "application/json");
    if (close) {
      response.setHeader("Connection", "close");
      if (source) response.once("finish", () => source.destroy());
    }
    response.writeHead(status);
    response.end(body);
  };
  async function dispatch(issuedMs: number) {
    const abort = new AbortController();
    controller = abort;
    let bound: ReturnType<typeof setTimeout> | undefined,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort: () => void = () => {};
    const expired = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(Error("DISPATCH_UNAVAILABLE"));
      abort.signal.addEventListener("abort", rejectAbort, { once: true });
      bound = setTimeout(() => abort.abort(), 10000);
      bound.unref?.();
    });
    try {
      const response = await Promise.race([
        request(WEB_DISPATCH_URL, {
          method: "POST",
          headers: schedulerHeaders("DISPATCH", key!, issuedMs),
          body: "{}",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: abort.signal,
        }),
        expired,
      ]);
      if (
        response.redirected ||
        (response.url && response.url !== WEB_DISPATCH_URL) ||
        (response.status >= 300 && response.status < 400)
      )
        throw Error("DISPATCH_UNAVAILABLE");
      if (
        response.headers.get("content-type")?.split(";", 1)[0].trim() !==
          "application/json" ||
        !response.body
      )
        throw Error("DISPATCH_UNAVAILABLE");
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 4096)
      )
        throw Error("DISPATCH_UNAVAILABLE");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await Promise.race([reader.read(), expired]);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) throw Error("DISPATCH_UNAVAILABLE");
        chunks.push(part.value);
      }
      if (stopped || abort.signal.aborted) throw Error("DISPATCH_UNAVAILABLE");
      if (response.status === 200) {
        const parsed = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as unknown;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 1 ||
          (parsed as { processed?: unknown }).processed !== true
        )
          throw Error("DISPATCH_UNAVAILABLE");
        observe("dispatch_processed");
      } else
        observe(
          response.status === 401
            ? "dispatch_duplicate_or_denied"
            : response.status === 404
              ? "dispatch_disabled"
              : response.status === 503
                ? "dispatch_unavailable"
                : "dispatch_rejected",
        );
    } catch {
      if (!stopped) observe("dispatch_unavailable");
    } finally {
      clearTimeout(bound);
      abort.signal.removeEventListener("abort", rejectAbort);
      abort.abort();
      void reader?.cancel().catch(() => {});
      try {
        reader?.releaseLock();
      } catch {
        /* Do not await cancellation. */
      }
      if (controller === abort) controller = undefined;
    }
  }
  function nudge(): "started" | "coalesced" | "disabled" | "stopped" {
    if (stopped) return "stopped";
    if (!enabled || !started) return "disabled";
    const issued = now();
    if (!Number.isFinite(issued) || issued <= 0) return "disabled";
    const minute = Math.floor(issued / 60000);
    if (busy || minute <= lastMinute) return "coalesced";
    lastMinute = minute;
    const current = dispatch(issued);
    busy = current;
    void current.finally(() => {
      if (busy === current) busy = undefined;
    });
    return "started";
  }
  function arm() {
    if (stopped || !enabled || !started) return;
    const issued = now();
    if (!Number.isFinite(issued) || issued <= 0) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        nudge();
        arm();
      },
      60000 - (issued % 60000),
    );
    timer.unref?.();
  }
  function readBody(source: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      let size = 0,
        done = false;
      const chunks: Buffer[] = [];
      const finish = (result: Buffer | null) => {
        if (done) return;
        done = true;
        clearTimeout(bound);
        source.off("data", data);
        source.off("end", end);
        source.off("error", error);
        source.off("aborted", error);
        inbound.delete(cancel);
        resolve(result);
      };
      const data = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 2) finish(null);
        else chunks.push(bytes);
      };
      const end = () => finish(Buffer.concat(chunks));
      const error = () => finish(null);
      const cancel = () => finish(null);
      const bound = setTimeout(() => finish(null), 2000);
      bound.unref?.();
      inbound.add(cancel);
      source.on("data", data);
      source.once("end", end);
      source.once("error", error);
      source.once("aborted", error);
      if (source.readableEnded) end();
    });
  }
  function handleRequest(
    source: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const purpose: SchedulerPurpose | null =
      source.url === WAKE_PATH
        ? "WAKE"
        : source.url === STATUS_PATH
          ? "STATUS"
          : null;
    if (!purpose) return false;
    if (!configured || (purpose === "WAKE" && !enabled)) {
      reply(response, 404, '{"error":"Not found."}', true, source);
      return true;
    }
    if (stopped) {
      reply(response, 503, '{"error":"Unavailable."}', true, source);
      return true;
    }
    const url = purpose === "WAKE" ? RELAY_WAKE_URL : RELAY_STATUS_URL;
    let headers: Headers;
    try {
      if (source.rawHeaders.length > 64 || source.rawHeaders.length % 2 !== 0)
        throw Error("INVALID");
      headers = new Headers();
      for (let i = 0; i < source.rawHeaders.length; i += 2)
        headers.append(source.rawHeaders[i], source.rawHeaders[i + 1]);
      if (
        headers.get("host") !== RELAY_HOST ||
        !verifySchedulerProof(
          purpose,
          { url, method: source.method ?? "", headers, body: EMPTY },
          key!,
          now(),
        )
      )
        throw Error("INVALID");
    } catch {
      reply(response, 401, '{"error":"Unauthorized."}', true, source);
      return true;
    }
    void readBody(source)
      .then((body) => {
        if (stopped) {
          reply(response, 503, '{"error":"Unavailable."}', true, source);
          return;
        }
        if (
          !body ||
          !verifySchedulerProof(
            purpose,
            { url, method: source.method ?? "", headers, body },
            key!,
            now(),
          )
        ) {
          reply(response, 401, '{"error":"Unauthorized."}', true, source);
          return;
        }
        if (purpose === "STATUS") {
          reply(response, 200, JSON.stringify({ configured: true, enabled }));
          return;
        }
        const result = nudge();
        reply(
          response,
          result === "started" ? 202 : result === "coalesced" ? 200 : 503,
          result === "started" || result === "coalesced"
            ? '{"accepted":true}'
            : '{"error":"Unavailable."}',
        );
      })
      .catch(() =>
        reply(response, 503, '{"error":"Unavailable."}', true, source),
      );
    return true;
  }
  return {
    configured,
    enabled,
    handleRequest,
    nudge,
    start() {
      if (started || stopped) return;
      started = true;
      if (gate && !configured) observe("configuration_unavailable");
      if (enabled) {
        nudge();
        arm();
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      for (const cancel of [...inbound]) cancel();
      controller?.abort();
      await busy;
    },
  };
}