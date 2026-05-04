# create-canopy-agent

Scaffold a pre-configured Canopy agent starter and provision the matching policy + agent in your Canopy org — in one guided command.

```bash
npx @canopy-ai/create-canopy-agent my-trading-bot
```

> **Already have an agent project?** Use `npx @canopy-ai/sdk connect` instead — that CLI connects an *existing* project (writes credentials + auto-configures installed MCP clients). `create-canopy-agent` is specifically for scaffolding a *new* project from one of the starters below.

The CLI will:

1. Ask which starter to scaffold (trading-defi, research, lead-gen, content-creator, treasury-billpay, travel).
2. Ask the agent name and approval threshold (with sensible per-starter defaults).
3. **Authenticate.** Pick one of:
   - **Browser** *(recommended)* — opens a consent page that previews the policy + agent that's about to be created. On Authorize, the **server** creates the policy + agent + grant in a single Postgres transaction and mints a revocable MCP token scoped to the new agent. The CLI never sees your org's primary API key.
   - **Paste API key** — paste an `ak_live_…` from `dashboard/settings#api-keys`. The CLI then calls `/api/policies` + `/api/agents` itself with that key.
   - **`--api-key <key>` flag or `CANOPY_API_KEY` env var** — non-interactive (CI / scripted). Same path as Paste, but no prompt.
4. Scaffold the starter project locally, write `.env` with the appropriate Canopy creds (MCP token for the browser path, API key for the paste path) + `CANOPY_AGENT_ID` + `ANTHROPIC_API_KEY`.

The only key you paste manually is your Anthropic API key (`sk-ant-…`).

**Audit trail.** In the browser path, the consent grant (`cli_grants` row) is bound to the new `agents` row in the same transaction — `SELECT a.* FROM agents a JOIN cli_grants g ON g.agent_id = a.agent_id` resolves cleanly to "agent created via this consent."

After scaffolding, if you also want Canopy available in your dev tools (Claude Code, Cursor, etc.) while you build, run `npx @canopy-ai/sdk connect` from the project root.

## Available starters

| Starter | What it does |
|---|---|
| `trading-defi-agent` | Quote → validate → execute via price feeds + DEXes |
| `research-agent` | Multi-source research; pays for gated data APIs |
| `lead-gen-agent` | Enrich/verify B2B contacts via per-lead paid APIs |
| `content-creator-agent` | Pay for stock assets + AI image/voice/video generation |
| `treasury-billpay-agent` | Pay vendor invoices + recurring subs within budget |
| `travel-agent` | Search flights/airport schedules; surface options before booking |

All starters are built on [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) with Canopy's hosted MCP server (`https://mcp.trycanopy.ai/mcp`). Zero Canopy code in the templates — the agent reaches Canopy via MCP with your API key + agent id passed as auth headers.

## Requirements

- Node 18+
- A Canopy account with a provisioned treasury (one-time dashboard setup at <https://trycanopy.ai>)
- An Anthropic API key (Claude Agent SDK runs on Claude)

## Local dev

```bash
npm install
npm run start  # tsx src/cli.ts
```

For source-tree dev, the scaffolder reads templates from `../../canopy-agent-starters/`. After `npm run build`, it reads from `dist/templates/`.

## License

MIT
