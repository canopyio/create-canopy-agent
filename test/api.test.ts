import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { CanopyApiClient, CanopyApiError } from "../src/api.ts";

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

async function withMockServer<T>(
  handler: (req: IncomingMessage, body: unknown) => { status?: number; body: unknown },
  run: (baseUrl: string, seen: SeenRequest[]) => Promise<T>,
): Promise<T> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = raw ? JSON.parse(raw) : undefined;
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: parsed,
      });

      const result = handler(req, parsed);
      res.statusCode = result.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    return await run(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe("CanopyApiClient", () => {
  it("me() sends bearer auth and parses org context", async () => {
    await withMockServer(
      () => ({
        body: {
          org_id: "org_123",
          org_name: "Acme",
          treasury_address: "0xabc",
          treasury_provisioned: true,
        },
      }),
      async (baseUrl, seen) => {
        const client = new CanopyApiClient("ak_live_test", baseUrl);
        const org = await client.me();

        assert.deepEqual(org, {
          org_id: "org_123",
          org_name: "Acme",
          treasury_address: "0xabc",
          treasury_provisioned: true,
        });
        assert.equal(seen[0]?.method, "GET");
        assert.equal(seen[0]?.url, "/api/me");
        assert.equal(seen[0]?.authorization, "Bearer ak_live_test");
      },
    );
  });

  it("createPolicy() sends the expected policy body and returns policy_id", async () => {
    await withMockServer(
      () => ({ body: { policy_id: "pol_123" } }),
      async (baseUrl, seen) => {
        const client = new CanopyApiClient("ak_live_test", baseUrl);
        const created = await client.createPolicy({
          name: "starter-default",
          description: "Starter policy",
          spend_cap_usd: 25,
          cap_period_hours: 24,
          approval_required: true,
          approval_threshold_usd: 2,
        });

        assert.equal(created.policy_id, "pol_123");
        assert.equal(seen[0]?.method, "POST");
        assert.equal(seen[0]?.url, "/api/policies");
        assert.deepEqual(seen[0]?.body, {
          name: "starter-default",
          description: "Starter policy",
          spend_cap_usd: 25,
          cap_period_hours: 24,
          approval_required: true,
          approval_threshold_usd: 2,
        });
      },
    );
  });

  it("createAgent() sends name and policyId and returns agentId", async () => {
    await withMockServer(
      () => ({ body: { agentId: "agt_123", policyId: "pol_123" } }),
      async (baseUrl, seen) => {
        const client = new CanopyApiClient("ak_live_test", baseUrl);
        const created = await client.createAgent("Research Agent", "pol_123");

        assert.equal(created.agentId, "agt_123");
        assert.equal(seen[0]?.method, "POST");
        assert.equal(seen[0]?.url, "/api/agents");
        assert.deepEqual(seen[0]?.body, {
          name: "Research Agent",
          policyId: "pol_123",
        });
      },
    );
  });

  it("surfaces non-2xx JSON errors as CanopyApiError", async () => {
    await withMockServer(
      () => ({ status: 401, body: { error: "Invalid API key" } }),
      async (baseUrl) => {
        const client = new CanopyApiClient("ak_live_bad", baseUrl);

        await assert.rejects(
          () => client.me(),
          (err) =>
            err instanceof CanopyApiError &&
            err.status === 401 &&
            err.message === "Invalid API key",
        );
      },
    );
  });
});
