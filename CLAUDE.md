# CLAUDE.md — UAT Engine

## What this is

AI-native test engine with an MCP interface. Covers UAT (browser-based acceptance testing),
API integration testing, and MCP server verification. Runs in its own container with
Playwright. All target knowledge lives in flow specs (YAML), not in the engine itself.

## Build & test

```bash
bun install              # install deps
bun run dev              # start MCP server with watch
bun run start            # start MCP server (production)
bun test                 # run tests
bun run typecheck        # tsc --noEmit
```

## Architecture

- `mcp-server/src/index.ts` — MCP server entrypoint (streamable HTTP on port 3200)
- `mcp-server/src/types.ts` — Shared types
- `mcp-server/src/engine/` — Core engines (browser pool, HTTP client, MCP probe, trace, session store)
- `mcp-server/src/tools/` — MCP tool handlers (session, navigate, interact, observe, assert, api, mcp-client, flow, record)
- `flows/` — Flow spec directory (YAML/JSON). Examples in `flows/examples/`

## Conventions

- TypeScript strict mode
- bun runtime, pnpm for packages
- All tool names prefixed with `uat_`
- Engine modules are singletons (browser pool, session store)
- Flow specs use `${VAR}` interpolation from env or session context
