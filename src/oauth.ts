import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Browser-OAuth handshake for `create-canopy-agent`'s scaffold flow.
 *
 * The CLI passes the chosen starter + agent name + approval choice as
 * query params on the consent URL. The consent submit handler validates
 * everything server-side, then in a single Postgres transaction:
 *   - inserts the policies row matching the starter preset (with the
 *     user-overridden approval fields),
 *   - inserts the agents row bound to that policy,
 *   - inserts the cli_grants row pointing at the agent.
 *
 * The grant returns a revocable MCP token scoped to that agent. The org
 * primary API key never leaves the server. The cli_grants row provides
 * a clean audit trail tying "this consent" to "this agent."
 *
 * Mirrors the localhost listener / browser launcher in
 * `sdk/typescript/src/cli/{_localhost,_browser}.ts`. Duplicated rather than
 * shared: two CLIs, no third caller yet.
 */

const CONSENT_TIMEOUT_MS = 10 * 60 * 1000;
const NONCE_RE = /^[A-Za-z0-9_\-]{22,128}$/;
const CODE_RE = /^[A-Za-z0-9_\-]{32,128}$/;
const ERROR_RE = /^[A-Za-z0-9_.\-]{1,80}$/;
const HOSTNAME_RE = /^[A-Za-z0-9.\-_]+$/;
const SCAFFOLD_MODE = "scaffold";

interface CallbackResult {
  code?: string;
  error?: string;
  nonce?: string;
}

export interface AuthorizeScaffoldArgs {
  baseUrl: string;
  starterSlug: string;
  agentName: string;
  approvalRequired: boolean;
  approvalThresholdUsd: number | null;
}

export interface AuthorizeScaffoldResult {
  mcpToken: string;
  mcpUrl: string;
  agentId: string;
  baseUrl: string;
  org: { id: string; name: string | null };
  hostname: string | null;
}

interface GrantResponseBody {
  mcp_token?: unknown;
  mcp_url?: unknown;
  agent_id?: unknown;
  base_url?: unknown;
  hostname?: unknown;
  org?: { id?: unknown; name?: unknown } | null;
  error?: unknown;
}

export class AuthorizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizeError";
  }
}

export async function authorizeScaffold(
  args: AuthorizeScaffoldArgs,
): Promise<AuthorizeScaffoldResult> {
  const normalizedBaseUrl = args.baseUrl.replace(/\/$/, "");
  const nonce = randomBytes(32).toString("base64url");
  const machine = sanitizeHostname(osHostname()) ?? "this-machine";

  const listener = await startCallbackListener(CONSENT_TIMEOUT_MS, nonce);

  const params = new URLSearchParams({
    nonce,
    port: String(listener.port),
    hostname: machine,
    mode: SCAFFOLD_MODE,
    starter: args.starterSlug,
    agent_name: args.agentName,
    approval_required: String(args.approvalRequired),
    approval_threshold_usd:
      args.approvalThresholdUsd === null ? "null" : String(args.approvalThresholdUsd),
  });
  const authorizeUrl = `${normalizedBaseUrl}/cli/authorize?${params.toString()}`;

  process.stdout.write(`\nOpening your browser for consent…\n`);
  process.stdout.write(`If it doesn't open, visit:\n  ${authorizeUrl}\n\n`);
  const opened = openBrowser(authorizeUrl);
  if (!opened) {
    listener.close();
    throw new AuthorizeError(
      "Could not open a browser. Re-run with --api-key or set CANOPY_API_KEY=ak_live_…",
    );
  }

  let callback: CallbackResult;
  try {
    callback = await listener.ready;
  } finally {
    listener.close();
  }

  if (callback.error) {
    throw new AuthorizeError(`Authorization ${callback.error}.`);
  }
  if (!callback.code || !callback.nonce) {
    throw new AuthorizeError("Callback missing code/nonce. Aborted.");
  }
  if (callback.nonce !== nonce) {
    throw new AuthorizeError(
      "Callback nonce did not match. Aborted (suspected replay or stale tab).",
    );
  }

  const res = await fetch(`${normalizedBaseUrl}/api/cli/grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: callback.code,
      nonce,
      credential_format: "mcp_token",
    }),
  });

  let body: GrantResponseBody = {};
  try {
    body = (await res.json()) as GrantResponseBody;
  } catch {
    /* ignore — handled below */
  }

  if (!res.ok) {
    const detail = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new AuthorizeError(`Grant exchange failed: ${detail}`);
  }

  if (typeof body.mcp_token !== "string" || !body.mcp_token.startsWith("canopy_")) {
    throw new AuthorizeError("Grant response did not include a valid MCP token.");
  }
  if (typeof body.agent_id !== "string" || !body.agent_id) {
    throw new AuthorizeError("Grant response did not include an agent id.");
  }
  if (typeof body.mcp_url !== "string") {
    throw new AuthorizeError("Grant response did not include an MCP URL.");
  }

  const orgId = typeof body.org?.id === "string" ? body.org.id : "";
  const orgName = typeof body.org?.name === "string" ? body.org.name : null;
  const responseBaseUrl =
    typeof body.base_url === "string" && body.base_url.startsWith("http")
      ? body.base_url
      : normalizedBaseUrl;
  const hostname = typeof body.hostname === "string" ? body.hostname : null;

  return {
    mcpToken: body.mcp_token,
    mcpUrl: body.mcp_url,
    agentId: body.agent_id,
    baseUrl: responseBaseUrl,
    org: { id: orgId, name: orgName },
    hostname,
  };
}

function sanitizeHostname(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^A-Za-z0-9.\-_]/g, "-").slice(0, 64);
  return HOSTNAME_RE.test(cleaned) ? cleaned : null;
}

function openBrowser(url: string): boolean {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* launcher missing — caller surfaces the URL */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function startCallbackListener(
  timeoutMs: number,
  expectedNonce: string,
): Promise<{ port: number; ready: Promise<CallbackResult>; close: () => void }> {
  return new Promise((resolveStart, rejectStart) => {
    let resolved = false;
    let resolveReady: (v: CallbackResult) => void = () => {};
    let rejectReady: (e: Error) => void = () => {};
    const ready = new Promise<CallbackResult>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const parsed = parseCallback(req.method ?? "GET", req.url ?? "/", expectedNonce);
      if (parsed.status === 404) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (parsed.status === 405) {
        res.statusCode = 405;
        res.end("Method not allowed");
        return;
      }
      if (parsed.status !== 200) {
        res.statusCode = 400;
        res.end("Invalid callback");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      if (!resolved) {
        resolved = true;
        resolveReady(parsed.result);
      }
    };

    const server: Server = createServer(handler);
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        rejectReady(new AuthorizeError("Timed out waiting for browser consent"));
        server.close();
      }
    }, timeoutMs);

    server.on("error", (err) => {
      if (!resolved) rejectStart(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        rejectStart(new AuthorizeError("listener returned no address"));
        return;
      }
      resolveStart({
        port: addr.port,
        ready,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

function parseCallback(
  method: string,
  path: string,
  expectedNonce: string,
):
  | { status: 200; result: CallbackResult }
  | { status: 400 | 404 | 405; result?: never } {
  const url = new URL(path, "http://127.0.0.1");
  if (url.pathname !== "/callback") return { status: 404 };
  if (method !== "GET") return { status: 405 };

  const nonce = url.searchParams.get("nonce") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const error = url.searchParams.get("error") ?? "";
  const validNonce = NONCE_RE.test(nonce) && nonce === expectedNonce;
  const validCode = CODE_RE.test(code);
  const validError = ERROR_RE.test(error);
  if (!validNonce || (!validCode && !validError)) return { status: 400 };

  return {
    status: 200,
    result: {
      code: validCode ? code : undefined,
      nonce,
      error: validError ? error : undefined,
    },
  };
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Canopy connected</title>
<style>
body{font:14px/1.5 ui-sans-serif,system-ui;color:#333;max-width:480px;margin:120px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 12px}
p{color:#666}
</style></head>
<body>
<h1>You can close this tab.</h1>
<p>Canopy received the consent. Return to your terminal — the CLI is finishing up.</p>
</body></html>`;
