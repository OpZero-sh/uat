<div align="center">

# UAT Engine

### AI-native testing over Model Context Protocol

**Give your AI agent a browser, an HTTP client, and an MCP probe. Let it test anything.**

46 MCP tools for browser automation, API testing, and MCP server verification --
controlled entirely through the [Model Context Protocol](https://modelcontextprotocol.io).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![MCP](https://img.shields.io/badge/Protocol-MCP-8B5CF6)](https://modelcontextprotocol.io)
[![Playwright](https://img.shields.io/badge/Browser-Playwright-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)

Built by [OpZero](https://opzero.sh) -- the AI-native deployment platform.

[Get Started](#quick-start) &#183; [MCP Tools](#mcp-tools) &#183; [Flow Specs](#flow-specs) &#183; [Docker](#docker) &#183; [Architecture](#architecture)

</div>

---

## Why UAT Engine?

AI agents are shipping code -- but who tests it? Traditional test frameworks need humans to write and maintain scripts. UAT Engine flips the model: agents **describe what to test**, the engine handles **how**.

- **MCP-native** -- Plugs into any MCP client (Claude, Cursor, custom agents). No SDKs, no wrappers, just tool calls.
- **Browser + API + MCP** -- One engine covers UI acceptance testing, API integration testing, and MCP server verification.
- **Declarative flows** -- Write YAML specs with variable interpolation, conditionals, parallel execution, and cross-step data passing. Zero code.
- **Playwright under the hood** -- Full Chromium automation with screenshots, traces, device emulation, and proxy support.
- **Production-hardened** -- Multi-stage Docker image, non-root execution, graceful shutdown with connection draining, readiness probes.

> Used in production at [OpZero.sh](https://opzero.sh) to verify deployments across Cloudflare, Netlify, and Vercel.

## Quick Start

```bash
# Install
bun install

# Start the MCP server
bun run start
# => Listening on http://localhost:3200/mcp
```

Point any MCP client at `http://localhost:3200/mcp` and start calling tools:

```json
{
  "mcpServers": {
    "uat": {
      "type": "url",
      "url": "http://localhost:3200/mcp"
    }
  }
}
```

### With Docker

```bash
docker build -t uat-engine .
docker run --init -p 3200:3200 uat-engine
```

## MCP Tools

46 tools across 9 categories. All prefixed with `uat_`.

### Session Management

| Tool | What it does |
|------|-------------|
| `uat_session_create` | Launch a browser session (headless, viewport, device emulation, proxy) |
| `uat_session_list` | List active sessions with status |
| `uat_session_close` | Close a session and release resources |

### Browser Navigation

| Tool | What it does |
|------|-------------|
| `uat_navigate_goto` | Navigate to a URL |
| `uat_navigate_back` | Go back in history |
| `uat_navigate_forward` | Go forward in history |
| `uat_navigate_reload` | Reload the page |
| `uat_navigate_wait` | Wait for a condition (selector, networkidle, timeout) |

### Browser Interaction

| Tool | What it does |
|------|-------------|
| `uat_interact_click` | Click an element by selector |
| `uat_interact_fill` | Fill an input field |
| `uat_interact_select` | Select a dropdown option |
| `uat_interact_check` | Toggle a checkbox |
| `uat_interact_press` | Press a keyboard key |
| `uat_interact_scroll` | Scroll the page or to an element |
| `uat_interact_upload` | Upload a file to an input |

### Browser Observation

| Tool | What it does |
|------|-------------|
| `uat_observe_screenshot` | Capture a screenshot (full page or element) |
| `uat_observe_snapshot` | Get page HTML snapshot |
| `uat_observe_get_text` | Extract text content from an element |
| `uat_observe_get_attribute` | Read an element attribute |
| `uat_observe_evaluate` | Execute JavaScript in the page context |

### Assertions

| Tool | What it does |
|------|-------------|
| `uat_assert_visible` | Assert an element is visible |
| `uat_assert_text` | Assert element text matches (exact, contains, regex) |
| `uat_assert_url` | Assert current URL matches a pattern |
| `uat_assert_title` | Assert page title |
| `uat_assert_count` | Assert element count (eq, gt, lt) |
| `uat_assert_value` | Assert input field value |
| `uat_assert_status` | Assert HTTP response status code |
| `uat_assert_body` | Assert value in a response body (supports dotted paths) |

### API Testing

| Tool | What it does |
|------|-------------|
| `uat_api_request` | Send HTTP requests with headers, body, auth -- returns structured response with timing |

### MCP Server Testing

| Tool | What it does |
|------|-------------|
| `uat_mcp_connect` | Connect to a remote MCP server |
| `uat_mcp_list_tools` | Discover available tools on a connection |
| `uat_mcp_call` | Call a tool and measure response time |
| `uat_mcp_disconnect` | Disconnect from an MCP server |

### Flow Execution

| Tool | What it does |
|------|-------------|
| `uat_flow_run` | Execute a YAML flow spec |
| `uat_flow_run_suite` | Run multiple flows with aggregated pass/fail |
| `uat_flow_list` | List available flow specs |
| `uat_flow_validate` | Validate a flow spec without running it |
| `uat_flow_get_results` | Retrieve results from a completed flow run |

### Recording

| Tool | What it does |
|------|-------------|
| `uat_record_start` | Start recording a Playwright trace |
| `uat_record_stop` | Stop recording and save the trace file |
| `uat_record_list` | List saved recordings |

## Flow Specs

Flows are declarative YAML files that chain tools into complete test scenarios. No code needed -- agents write the YAML, the engine executes it.

### Example: Health check

```yaml
name: health-check
description: Verify a page loads and has expected content
config:
  base_url: "${BASE_URL}"
steps:
  - action: goto
    url: "${BASE_URL}"
  - action: wait
    condition: networkidle
  - action: screenshot
    name: homepage-loaded
  - action: assert_title
    match: contains
    value: "${EXPECTED_TITLE}"
  - action: assert_visible
    selector: "nav"
```

### Example: Deploy and verify (API + Browser)

```yaml
name: api-deploy-verify
description: Deploy via API, then verify the result in a browser
steps:
  - action: api_request
    method: POST
    url: "${BASE_URL}/api/deploy"
    headers:
      Authorization: "Bearer ${API_TOKEN}"
    body:
      files:
        index.html: "<h1>smoke test</h1>"
    assert_status: 200
    save_as: deploy

  - action: goto
    url: "${deploy.body.url}"

  - action: assert_text
    selector: "h1"
    value: "smoke test"
```

### Example: MCP server verification

```yaml
name: mcp-tools-check
description: Verify an MCP server responds with expected tools
steps:
  - action: mcp_connect
    url: "${MCP_URL}"
    auth: "Bearer ${MCP_TOKEN}"
  - action: mcp_list_tools
    save_as: tools
  - action: assert_body
    path: "tools.length"
    operator: gte
    value: 1
  - action: mcp_call
    tool: "repos_list"
    params: {}
    save_as: repos
  - action: mcp_disconnect
```

### Flow features

- **Variable interpolation** -- `${VAR}` resolves from session context, flow config, then env vars. Dotted paths like `${deploy.body.url}` supported.
- **Cross-step data** -- `save_as: name` stores step results for use in later steps
- **Conditionals** -- `if: key` / `unless: key` for conditional step execution
- **Parallel groups** -- `parallel:` block runs steps concurrently
- **Action routing** -- `api_*` goes to HTTP client, `mcp_*` to MCP probe, `assert_*` to assertions, everything else to Playwright

## Docker

### Standalone

```bash
docker build -t uat-engine .
docker run --init -p 3200:3200 uat-engine
```

### Docker Compose (with network)

```bash
docker network create devnet  # if not already created
docker compose up
```

The compose config includes:
- `init: true` for proper signal handling
- `read_only: true` rootfs with explicit tmpfs mounts
- 2GB memory / 2 CPU limit (Chromium needs headroom)
- Health checks on `/health`
- Joins the `devnet` network for service discovery

### Deploy to Railway

```bash
railway up
```

See [`railway.toml`](railway.toml) for the deploy config.

## Architecture

```
mcp-server/src/
  index.ts              Entrypoint -- HTTP server, graceful shutdown, readiness probe
  types.ts              Shared TypeScript types
  engine/
    browser.ts          Playwright browser pool (singleton, isolated contexts per session)
    http-client.ts      HTTP client with structured responses
    mcp-probe.ts        MCP client for testing remote MCP servers
    trace-manager.ts    Playwright trace recording
    session-store.ts    In-memory session + context store
    flow-runner.ts      YAML flow execution engine
  tools/
    session.ts          Session lifecycle tools
    navigate.ts         Browser navigation tools
    interact.ts         Browser interaction tools
    observe.ts          Screenshot, snapshot, text extraction
    assert.ts           Assertion tools (browser + API)
    api.ts              HTTP request tool
    mcp-client.ts       MCP connect / list / call / disconnect
    flow.ts             Flow execution tools
    record.ts           Trace recording tools
flows/
  examples/             Starter flow specs
```

### Production hardening

- **Multi-stage Dockerfile** -- Builder installs deps, runtime copies only production artifacts
- **Non-root execution** -- Runs as `pwuser` (uid 1001) from the Playwright base image
- **Graceful shutdown** -- SIGTERM/SIGINT triggers readiness probe failure, connection draining (10s deadline), browser pool shutdown, then clean exit
- **Readiness probe** -- `/readiness` returns 503 during drain, separate from `/health` liveness
- **Request timeout** -- 5-minute deadline per MCP request
- **Transport tracking** -- Active connections are tracked and drained on shutdown

## Built by OpZero

[OpZero](https://opzero.sh) is an AI-native deployment platform. Ship websites to Cloudflare, Netlify, and Vercel from any MCP client -- Claude, Cursor, or your own agents.

UAT Engine is how we verify that deployments work. Every deploy to [opzero.sh](https://opzero.sh) can be smoke-tested by an AI agent using this engine.

- [opzero.sh](https://opzero.sh) -- Deploy from AI
- [@OpZero-sh](https://github.com/OpZero-sh) -- More open source from OpZero

## Contributing

Contributions welcome. Please open an issue first for non-trivial changes.

```bash
bun install        # install deps
bun run dev        # start with watch mode
bun test           # run tests
bun run typecheck  # type check
```

## License

[MIT](LICENSE)
