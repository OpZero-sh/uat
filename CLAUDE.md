# CLAUDE.md — UAT Engine

## What this is

AI-native test engine with an MCP interface. Covers UAT (browser-based acceptance testing),
API integration testing, and MCP server verification. Runs in its own container with
Playwright. All target knowledge lives in flow specs (YAML), not in the engine itself.

## Build & test

```bash
bun install              # install deps (pnpm for package management)
bun run dev              # start MCP server with watch (port 3200)
bun run start            # start MCP server (production)
bun test                 # run unit tests
bun run typecheck        # tsc --noEmit
```

## Environment variables

Target app env vars are managed on **Vercel**. For UAT testing against OpZero services:

```bash
# Pull env from the OpZero Vercel project for integration testing
cd ~/opzero-sh/OpZero.sh && bunx vercel env pull .env.local
```

| Variable | Description |
|----------|-------------|
| `UAT_BASE_URL` | Target app URL (default: `https://opzero.sh`) |
| `UAT_MCP_URL` | MCP server URL to test against |
| `OPZERO_API_KEY` | API key for authenticated test flows |

Flow specs use `${VAR}` interpolation — set vars in env or pass via session context.

## Architecture

- `mcp-server/src/index.ts` — MCP server entrypoint (streamable HTTP on port 3200)
- `mcp-server/src/types.ts` — Shared types
- `mcp-server/src/engine/` — Core engines (browser pool, HTTP client, MCP probe, trace, session store)
- `mcp-server/src/tools/` — MCP tool handlers (session, navigate, interact, observe, assert, api, mcp-client, flow, record)
- `flows/` — Flow spec directory (YAML/JSON). Examples in `flows/examples/`

## MCP tools (46 tools, 9 categories)

| Category | Tools | Purpose |
|----------|-------|---------|
| Session | `uat_session_*` | Create/manage browser sessions |
| Navigate | `uat_navigate_*` | Page navigation, URL management |
| Interact | `uat_click`, `uat_fill`, `uat_select` | Form/element interaction |
| Observe | `uat_screenshot`, `uat_get_text` | Page inspection |
| Assert | `uat_assert_*` | Content/element assertions |
| API | `uat_api_*` | HTTP request testing |
| MCP Client | `uat_mcp_*` | MCP server verification |
| Flow | `uat_flow_run`, `uat_flow_list` | Execute YAML flow specs |
| Visual Diff | `uat_visual_diff` | Screenshot comparison (pixelmatch) |

## Testing OpZero services

### Test the website (OpZero.sh)
```bash
# Run health check flow
bun run start &
# Then via MCP: uat_flow_run with flow="health-check"

# Or write a custom flow:
cat > flows/opzero-health.yaml << 'EOF'
name: OpZero Health Check
steps:
  - navigate: ${UAT_BASE_URL:-https://opzero.sh}
  - assert_text: "Deploy"
  - screenshot: opzero-home.png
EOF
```

### Test the MCP server
```bash
# Verify MCP server endpoints
# Via MCP: uat_mcp_connect with url="https://opzero.sh/mcp"
# Then: uat_mcp_list_tools
# Then: uat_mcp_call_tool with tool="get_system_status"
```

### Test the auth flow
```bash
# Via MCP: uat_flow_run with flow="api-integration"
# Customize flows/api-integration.yaml with target auth endpoints
```

### Visual regression
```bash
# Compare screenshots between deploys
bun run src/visual-diff.ts baseline.png current.png
```

## Writing flow specs

Flow specs are YAML files in `flows/`. They support:
- Variable interpolation: `${VAR}` from env or session
- Conditionals: `if:` blocks
- Parallel execution: `parallel:` blocks
- Assertions: text, element, status code checks
- Screenshots and visual diffs

Example flow specs in `flows/examples/`:
- `health-check.yaml` — Page load + content assertion
- `api-integration.yaml` — API endpoint testing
- `mcp-tools-check.yaml` — MCP server tool verification

## Conventions

- TypeScript strict mode
- bun runtime, pnpm for packages
- All tool names prefixed with `uat_`
- Engine modules are singletons (browser pool, session store)
- Flow specs use `${VAR}` interpolation from env or session context

## Related repos

- **OpZero.sh** (`~/opzero-sh/OpZero.sh`) — Primary test target (website + API + MCP)
- **MCPAuthKit** (`~/opzero-sh/MCPAuthKit`) — Auth flow test target
- **Infra** (`~/opzero-sh/Infra`) — Orchestrates UAT runs via MCP tools
