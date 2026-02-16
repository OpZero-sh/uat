# UAT Engine

AI-native test engine with an MCP interface. Covers browser-based acceptance testing,
API integration testing, and MCP server verification.

All target knowledge lives in flow specs (YAML), not in the engine itself. Agents
describe *what* to test; the engine handles *how*.

## Quick Start

```bash
# Install dependencies
bun install

# Start in development mode (watch + restart)
bun run dev

# Start in production mode
bun run start

# Run tests
bun test

# Type check
bun run typecheck
```

The MCP server listens on `http://localhost:3200/mcp` (streamable HTTP).

## Docker

```bash
docker build -t uat-engine .
docker run -p 3200:3200 uat-engine
```

The image is based on the official Playwright container and includes all browser
binaries (Chromium, Firefox, WebKit).

## MCP Tools

All tools are prefixed with `uat_`.

### Session Management

| Tool | Description |
|------|-------------|
| `uat_session_create` | Create a new browser session with options (headless, viewport, device, proxy) |
| `uat_session_list` | List all active sessions |
| `uat_session_close` | Close a session and release resources |

### Browser Navigation

| Tool | Description |
|------|-------------|
| `uat_navigate_goto` | Navigate to a URL |
| `uat_navigate_back` | Go back |
| `uat_navigate_forward` | Go forward |
| `uat_navigate_reload` | Reload page |
| `uat_navigate_wait` | Wait for condition (selector, networkidle, timeout) |

### Browser Interaction

| Tool | Description |
|------|-------------|
| `uat_interact_click` | Click an element |
| `uat_interact_fill` | Fill an input field |
| `uat_interact_select` | Select a dropdown option |
| `uat_interact_check` | Check a checkbox |
| `uat_interact_press` | Press a keyboard key |
| `uat_interact_scroll` | Scroll the page or to an element |
| `uat_interact_upload` | Upload a file |

### Browser Observation

| Tool | Description |
|------|-------------|
| `uat_observe_screenshot` | Take a screenshot |
| `uat_observe_snapshot` | Get page HTML snapshot |
| `uat_observe_get_text` | Get text content of an element |
| `uat_observe_get_attribute` | Get an element attribute |
| `uat_observe_evaluate` | Run JavaScript in the page |

### Assertions

| Tool | Description |
|------|-------------|
| `uat_assert_visible` | Assert element is visible |
| `uat_assert_text` | Assert element text matches |
| `uat_assert_url` | Assert current URL matches |
| `uat_assert_title` | Assert page title matches |
| `uat_assert_count` | Assert element count |
| `uat_assert_value` | Assert input value |
| `uat_assert_status` | Assert HTTP response status |
| `uat_assert_body` | Assert value in response body |

### API Testing

| Tool | Description |
|------|-------------|
| `uat_api_request` | Send an HTTP request and get structured response |

### MCP Testing

| Tool | Description |
|------|-------------|
| `uat_mcp_connect` | Connect to an MCP server |
| `uat_mcp_list_tools` | List tools on a connected MCP server |
| `uat_mcp_call` | Call a tool on a connected MCP server |
| `uat_mcp_disconnect` | Disconnect from MCP server |

### Flow Execution

| Tool | Description |
|------|-------------|
| `uat_flow_run` | Load and execute a named flow |
| `uat_flow_run_suite` | Run multiple flows with aggregated results |
| `uat_flow_list` | List available flow specs |
| `uat_flow_validate` | Validate a flow spec without running |
| `uat_flow_get_results` | Get results from a completed flow run |

### Recording

| Tool | Description |
|------|-------------|
| `uat_record_start` | Start recording a Playwright trace |
| `uat_record_stop` | Stop recording and save trace |
| `uat_record_list` | List saved recordings |

## Flow Spec Format

Flows are YAML files in the `flows/` directory. They define a sequence of steps
that the engine executes against a target.

```yaml
name: my-test-flow
description: What this flow verifies
config:
  base_url: "${BASE_URL}"      # Variables from env or session context
  timeout: 30000
steps:
  # Simple step
  - action: goto
    url: "${base_url}"

  # Step with save_as (store result for later use)
  - action: api_request
    method: GET
    url: "${base_url}/api/health"
    assert_status: 200
    save_as: health_response

  # Step with conditional execution
  - action: screenshot
    name: debug-screenshot
    if: debug_mode                # Only run if 'debug_mode' is truthy in context

  # Parallel group (steps run concurrently)
  - parallel:
    - action: api_request
      method: GET
      url: "${base_url}/api/users"
      save_as: users
    - action: api_request
      method: GET
      url: "${base_url}/api/posts"
      save_as: posts

  # Use results from previous steps
  - action: assert_body
    path: "health_response.body.status"
    operator: eq
    value: "ok"
```

### Variable Interpolation

`${VAR}` references are resolved in order:
1. Session context (values saved by `save_as`)
2. Flow config values
3. Environment variables

Dotted paths are supported: `${deploy.body.url}` resolves nested values.

### Step Actions

Steps are dispatched by their action prefix:
- `api_*` -- HTTP client (e.g., `api_request`)
- `mcp_*` -- MCP probe (e.g., `mcp_connect`, `mcp_call`)
- `assert_*` -- Assertions (e.g., `assert_visible`, `assert_body`)
- Everything else -- Browser actions via Playwright (e.g., `goto`, `click`, `fill`)

### Conditionals

- `if: key` -- Only run the step if `key` is truthy in session context
- `unless: key` -- Only run the step if `key` is falsy in session context

## Example Flows

See `flows/examples/` for starter flows:

- **health-check.yaml** -- Verify a page loads with expected title and nav
- **api-integration.yaml** -- Deploy via API, verify result in browser
- **mcp-tools-check.yaml** -- Connect to MCP server, list tools, call a tool

## Architecture

```
uat/
  mcp-server/src/
    index.ts              MCP server entrypoint (port 3200)
    types.ts              Shared types
    engine/
      browser.ts          Playwright browser pool
      http-client.ts      HTTP request client
      mcp-probe.ts        MCP server probe/client
      trace-manager.ts    Trace recording manager
      session-store.ts    In-memory session store
      flow-runner.ts      Flow execution engine
    tools/
      session.ts          Session management tools
      navigate.ts         Browser navigation tools
      interact.ts         Browser interaction tools
      observe.ts          Browser observation tools
      assert.ts           Assertion tools
      api.ts              API testing tools
      mcp-client.ts       MCP testing tools
      flow.ts             Flow execution tools
      record.ts           Recording tools
  flows/
    examples/             Example flow specs
  Dockerfile              Playwright-based container
  package.json
  tsconfig.json
```
