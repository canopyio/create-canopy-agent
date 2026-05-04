#!/usr/bin/env node
import path from "node:path";
import { input, password, select, confirm } from "@inquirer/prompts";
import { CanopyApiClient, CanopyApiError, type OrgContext } from "./api.js";
import { authorizeScaffold, AuthorizeError } from "./oauth.js";
import { preflightScaffold, scaffold } from "./scaffold.js";
import { STARTERS, type StarterDef } from "./starters.js";
import { bold, dim, fail, info, step, success, warn } from "./log.js";

interface ApprovalChoice {
  approval_required: boolean;
  approval_threshold_usd: number | null;
}

interface ParsedArgs {
  projectName: string | null;
  apiKey: string | null;
}

const DEFAULT_BASE_URL = process.env.CANOPY_BASE_URL ?? "https://trycanopy.ai";

function parseArgs(argv: string[]): ParsedArgs {
  let projectName: string | null = null;
  let apiKey: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--api-key") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--api-key requires a value\n");
        process.exit(2);
      }
      apiKey = v.trim();
    } else if (a.startsWith("--api-key=")) {
      apiKey = a.slice("--api-key=".length).trim();
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "Usage: npx @canopy-ai/create-canopy-agent <project-name> [--api-key <key>]\n" +
          "\n" +
          "Flags:\n" +
          "  --api-key <key>   Skip the auth prompt (also reads CANOPY_API_KEY env var)\n" +
          "  -h, --help        Show this help\n",
      );
      process.exit(0);
    } else if (a.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      process.exit(2);
    } else if (projectName === null) {
      projectName = a;
    }
  }
  return { projectName, apiKey };
}

function resolveProvidedKey(parsed: ParsedArgs): string | null {
  const fromEnv = process.env.CANOPY_API_KEY?.trim() || null;
  const fromFlag = parsed.apiKey || null;
  if (fromFlag && fromEnv && fromFlag !== fromEnv) {
    fail("--api-key and CANOPY_API_KEY are both set with different values. Pick one.");
    process.exit(2);
  }
  return fromFlag ?? fromEnv;
}

async function main(): Promise<void> {
  // Parse first so --help / --version (future) exit cleanly without the banner.
  const argv = parseArgs(process.argv.slice(2));
  const providedKey = resolveProvidedKey(argv);

  console.log("");
  step("Canopy starter scaffolder");
  info("Connect your Canopy org, pick a starter, get a runnable agent in ~30 seconds.\n");

  const projectName = (
    argv.projectName ??
    (await input({
      message: "Project name:",
      default: "my-canopy-agent",
      validate: (v) => (v.trim().length > 0 ? true : "required"),
    }))
  ).trim();

  const destDir = path.resolve(process.cwd(), projectName);

  // 1. Pick starter
  const sortedStarters = [...STARTERS].sort(
    (a, b) => Number(b.recommendedFirst ?? false) - Number(a.recommendedFirst ?? false),
  );
  const starterSlug: string = await select({
    message: "Pick a starter:",
    choices: sortedStarters.map((s) => ({
      name: s.recommendedFirst ? `${s.label}  (Recommended)` : s.label,
      value: s.slug,
      description: s.shortDescription,
    })),
  });
  const starter = STARTERS.find((s) => s.slug === starterSlug)!;

  try {
    await preflightScaffold({ starterSlug: starter.slug, destDir });
  } catch (err) {
    fail(`Scaffold preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 2. Agent name (collected up front so it can flow through the consent URL).
  const agentName = (
    await input({
      message: "Name your agent:",
      default: projectName,
      validate: (v) => (v.trim().length > 0 ? true : "required"),
    })
  ).trim();

  // 3. Show suggested policy + ask about approval
  console.log("");
  step(`Suggested policy preset for ${starter.slug}:`);
  printPolicyTable(starter);

  const approval = await pickApproval(starter);

  // 4. Authenticate. Three paths:
  //    (a) Provided key (--api-key / CANOPY_API_KEY) → CLI calls /api/policies + /api/agents
  //    (b) Browser → server creates policy + agent + cli_grants in ONE transaction;
  //        CLI receives an MCP token bound to the new agent. Org primary API key
  //        never leaves the server. cli_grants row provides clean audit trail.
  //    (c) Paste → same as provided key but interactive prompt
  console.log("");
  let env: Record<string, string>;
  let agentId: string;
  let orgLabel: string;

  const authChoice = await resolveAuthChoice(providedKey);

  if (authChoice.kind === "browser") {
    let result;
    try {
      result = await authorizeScaffold({
        baseUrl: DEFAULT_BASE_URL,
        starterSlug: starter.slug,
        agentName,
        approvalRequired: approval.approval_required,
        approvalThresholdUsd: approval.approval_threshold_usd,
      });
    } catch (err) {
      if (err instanceof AuthorizeError) {
        fail(err.message);
      } else {
        fail(`Browser authorization failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    agentId = result.agentId;
    orgLabel = result.org.name ?? result.org.id;
    success(`Created agent "${agentName}" (${dim(agentId)}) in "${bold(orgLabel)}"`);
    env = {
      CANOPY_MCP_TOKEN: result.mcpToken,
      CANOPY_MCP_URL: result.mcpUrl,
      CANOPY_AGENT_ID: agentId,
    };
  } else {
    const apiKey = authChoice.apiKey;
    const client = new CanopyApiClient(apiKey);
    let org: OrgContext;
    try {
      org = await client.me();
    } catch (err) {
      if (err instanceof CanopyApiError && err.status === 401) {
        fail("Invalid or revoked API key. Get a fresh one from the dashboard.");
      } else {
        fail(`Failed to validate API key: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }

    if (!org.treasury_provisioned) {
      fail(`Org "${org.org_name ?? org.org_id}" has no treasury provisioned yet.`);
      info(`Fund your treasury, then re-run this command:\n   ${dim(`${DEFAULT_BASE_URL}/dashboard/treasury`)}`);
      if (org.treasury_address) {
        info(`Treasury address: ${dim(org.treasury_address)} (USDC on Base, USDC.e on Tempo)`);
      }
      process.exit(1);
    }

    orgLabel = org.org_name ?? org.org_id;
    success(
      `Connected to "${bold(orgLabel)}" (treasury ${dim(shortenAddress(org.treasury_address!))})`,
    );

    const ok = await confirm({
      message: `Create policy "${starter.policy.name}" + agent "${agentName}" in this org?`,
      default: true,
    });
    if (!ok) {
      info("Aborted before creating any resources.");
      process.exit(0);
    }

    let policyId: string;
    try {
      const created = await client.createPolicy({
        ...starter.policy,
        approval_required: approval.approval_required,
        approval_threshold_usd: approval.approval_threshold_usd,
      });
      policyId = created.policy_id;
      success(`Created policy "${starter.policy.name}" (${dim(policyId)})`);
    } catch (err) {
      fail(`Failed to create policy: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    try {
      const created = await client.createAgent(agentName, policyId);
      agentId = created.agentId;
      success(`Created agent "${agentName}" (${dim(agentId)})`);
    } catch (err) {
      fail(`Failed to create agent: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    env = {
      CANOPY_API_KEY: apiKey,
      CANOPY_AGENT_ID: agentId,
    };
  }

  // 5. Anthropic API key
  console.log("");
  info(
    `Claude Agent SDK runs on Claude. Get a key here:\n   ${dim("https://console.anthropic.com/")}`,
  );
  const anthropicKey = (
    await password({
      message: "Anthropic API key (sk-ant-…) [leave empty to fill .env later]:",
    })
  ).trim();
  env.ANTHROPIC_API_KEY = anthropicKey;

  // 6. Scaffold project
  try {
    await scaffold({
      starterSlug: starter.slug,
      destDir,
      projectName,
      env,
    });
    success(`Scaffolded ${dim(destDir)}`);
  } catch (err) {
    fail(
      `Scaffold failed: ${err instanceof Error ? err.message : String(err)}\n   Your Canopy agent + policy were created and are reusable — re-run with a fresh project name.`,
    );
    process.exit(1);
  }

  // 10. Next steps
  console.log("");
  step("🎉 Done.");
  console.log("");
  console.log(`   ${bold("cd " + projectName)}`);
  console.log(`   ${bold("npm install")}`);
  console.log(`   ${bold("npm start")}`);
  console.log("");
  info(`Edit your policy or pause the agent at:\n   https://trycanopy.ai/dashboard/agents/${agentId}`);
  info(
    `To restrict which services this agent can pay (allowlist), browse the\n   registry and pick services in the policy editor in the dashboard.`,
  );
  info(
    `Want to use Canopy from Claude Code, Cursor, etc. while you build?\n   Run ${bold("npx @canopy-ai/sdk connect")} from the project root.`,
  );
  if (!anthropicKey) {
    warn(
      `Don't forget to set ANTHROPIC_API_KEY in ${path.join(projectName, ".env")} before \`npm start\`.`,
    );
  }
}

function shortenAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function printPolicyTable(starter: StarterDef): void {
  const p = starter.policy;
  console.log(`   • Spend cap            $${p.spend_cap_usd} / ${p.cap_period_hours}h`);
  if (p.approval_required && p.approval_threshold_usd != null) {
    console.log(`   • Approval threshold   $${p.approval_threshold_usd} single payment`);
  } else {
    console.log(`   • Approval threshold   none — all payments under cap auto-approve`);
  }
  console.log(
    `   • Allowlisted services configure in dashboard → https://trycanopy.ai/dashboard`,
  );
}

type AuthChoice =
  | { kind: "browser" }
  | { kind: "paste" | "provided"; apiKey: string };

async function resolveAuthChoice(providedKey: string | null): Promise<AuthChoice> {
  if (providedKey) {
    if (!providedKey.startsWith("ak_")) {
      fail("API key from --api-key / CANOPY_API_KEY must start with ak_…");
      process.exit(2);
    }
    info("Using API key from environment.");
    return { kind: "provided", apiKey: providedKey };
  }
  const method = await select({
    message: "How would you like to authenticate?",
    choices: [
      {
        name: "Browser  (recommended)",
        value: "browser",
        description: "Opens a consent page; the server creates the policy + agent atomically",
      },
      {
        name: "Paste API key",
        value: "paste",
        description: "Paste an org API key; the CLI creates the policy + agent itself",
      },
    ],
  });

  if (method === "browser") return { kind: "browser" };

  info(
    `Paste your org API key. Find it here:\n   ${dim("https://trycanopy.ai/dashboard/settings#api-keys")}`,
  );
  const apiKey = (
    await password({
      message: "Org API key (ak_live_…):",
      validate: (v) =>
        v.trim().startsWith("ak_") || v.trim().startsWith("ak_live_")
          ? true
          : "expected an ak_live_… key",
    })
  ).trim();
  return { kind: "paste", apiKey };
}

async function pickApproval(starter: StarterDef): Promise<ApprovalChoice> {
  const recommendedThreshold = starter.policy.approval_threshold_usd ?? 0;
  const choice = await select({
    message: "Approval threshold for single payments:",
    choices: [
      {
        name: starter.policy.approval_required
          ? `Recommended ($${recommendedThreshold} — payments above this need human approval)`
          : `Recommended (no approvals — auto-approve everything under the spend cap)`,
        value: "recommended",
      },
      {
        name: "No approvals needed (auto-approve everything under the spend cap)",
        value: "none",
      },
      {
        name: "Custom amount",
        value: "custom",
      },
    ],
  });

  if (choice === "recommended") {
    return {
      approval_required: starter.policy.approval_required,
      approval_threshold_usd: starter.policy.approval_threshold_usd,
    };
  }

  if (choice === "none") {
    return { approval_required: false, approval_threshold_usd: null };
  }

  const customStr = await input({
    message: "Approval threshold (USD):",
    default: String(recommendedThreshold),
    validate: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? true : "must be a non-negative number";
    },
  });
  return {
    approval_required: true,
    approval_threshold_usd: Number(customStr),
  };
}

main().catch((err) => {
  if (err && err.name === "ExitPromptError") {
    info("Aborted.");
    process.exit(0);
  }
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
