import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { authorizeScaffold } from "../src/oauth.ts";

async function withGrantServer<T>(
  grantBody: Record<string, unknown>,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req: IncomingMessage, res) => {
    if (req.url === "/api/cli/grant") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(grantBody));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe("authorizeScaffold", () => {
  it("waits for a manual callback when the browser launcher fails", async () => {
    await withGrantServer(
      {
        mcp_token: "canopy_mcp_test",
        mcp_url: "https://mcp.trycanopy.ai/mcp",
        agent_id: "agt_123",
        base_url: "https://trycanopy.ai",
        org: { id: "org_123", name: "Acme" },
      },
      async (baseUrl) => {
        let authorizeUrl = "";
        const resultPromise = authorizeScaffold({
          baseUrl,
          starterSlug: "research-agent",
          agentName: "Research Agent",
          approvalRequired: true,
          approvalThresholdUsd: 0.5,
          openBrowser: () => false,
          onAuthorizeUrl: (url) => {
            authorizeUrl = url;
          },
        });

        await waitFor(() => authorizeUrl.length > 0);
        const parsed = new URL(authorizeUrl);
        const nonce = parsed.searchParams.get("nonce");
        const port = parsed.searchParams.get("port");
        assert(nonce);
        assert(port);

        await fetch(
          `http://127.0.0.1:${port}/callback?code=${"a".repeat(32)}&nonce=${nonce}`,
        );

        const result = await resultPromise;
        assert.equal(result.mcpToken, "canopy_mcp_test");
        assert.equal(result.agentId, "agt_123");
      },
    );
  });

  it("rejects grant responses that are not scoped MCP tokens", async () => {
    await withGrantServer(
      {
        mcp_token: "canopy_at_not_scaffold",
        mcp_url: "https://mcp.trycanopy.ai/mcp",
        agent_id: "agt_123",
      },
      async (baseUrl) => {
        let authorizeUrl = "";
        const resultPromise = authorizeScaffold({
          baseUrl,
          starterSlug: "research-agent",
          agentName: "Research Agent",
          approvalRequired: true,
          approvalThresholdUsd: 0.5,
          openBrowser: () => false,
          onAuthorizeUrl: (url) => {
            authorizeUrl = url;
          },
        });

        await waitFor(() => authorizeUrl.length > 0);
        const parsed = new URL(authorizeUrl);
        await fetch(
          `http://127.0.0.1:${parsed.searchParams.get("port")}/callback?code=${"b".repeat(
            32,
          )}&nonce=${parsed.searchParams.get("nonce")}`,
        );

        await assert.rejects(
          () => resultPromise,
          /Grant response did not include a valid MCP token/,
        );
      },
    );
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate");
}
