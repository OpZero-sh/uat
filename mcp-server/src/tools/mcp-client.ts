import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpProbe } from "../engine/mcp-probe.js";
import type { AssertionResult } from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    const idx = Number(part);
    if (Array.isArray(current) && !Number.isNaN(idx)) {
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

// ─── Registration ───────────────────────────────────────────────────────────

export function register(server: McpServer): void {
  server.tool(
    "uat_mcp_connect",
    "Connect to a remote MCP server for testing",
    {
      url: z.string().describe("MCP server URL (e.g. http://localhost:3100/mcp)"),
      auth: z.string().optional().describe("Authorization header value (e.g. 'Bearer token')"),
    },
    async ({ url, auth }) => {
      const connection = await mcpProbe.connect(url, auth);
      return json({
        id: connection.id,
        url: connection.url,
        status: connection.status,
        tools: connection.tools,
      });
    },
  );

  server.tool(
    "uat_mcp_list_tools",
    "List all tools available on a connected MCP server",
    {
      connection_id: z.string().describe("Connection ID from uat_mcp_connect"),
    },
    async ({ connection_id }) => {
      const tools = await mcpProbe.listTools(connection_id);
      return json(tools);
    },
  );

  server.tool(
    "uat_mcp_call",
    "Call a tool on a connected MCP server and return the result",
    {
      connection_id: z.string().describe("Connection ID from uat_mcp_connect"),
      tool: z.string().describe("Tool name to call"),
      params: z.record(z.unknown()).optional().describe("Tool parameters"),
    },
    async ({ connection_id, tool, params }) => {
      const result = await mcpProbe.callTool(connection_id, tool, params);
      return json({
        tool: result.tool,
        result: result.result,
        isError: result.isError,
        timing: result.timing,
      });
    },
  );

  server.tool(
    "uat_mcp_assert_result",
    "Assert properties of an MCP tool call result",
    {
      result: z.record(z.unknown()).describe("MCP call result object"),
      path: z.string().optional().describe("Dot-separated path into the result (e.g. 'result.data.id')"),
      operator: z.enum(["eq", "neq", "contains", "matches"])
        .default("eq")
        .describe("Comparison operator"),
      value: z.unknown().optional().describe("Expected value (for path assertions)"),
      expect_error: z.boolean().optional().describe("If true, assert that isError is true"),
    },
    async ({ result, path, operator, value, expect_error }) => {
      // Check error expectation
      if (expect_error !== undefined) {
        const isError = Boolean(result.isError);
        const passed = isError === expect_error;
        const assertResult: AssertionResult = {
          passed,
          message: passed
            ? `Error state matches: isError=${isError}`
            : `Error state mismatch: expected isError=${expect_error}, got ${isError}`,
          expected: expect_error,
          actual: isError,
        };
        return json(assertResult);
      }

      // Path-based assertion
      if (path && value !== undefined) {
        const actual = resolvePath(result, path);
        let passed = false;
        switch (operator) {
          case "eq":
            passed = actual === value || JSON.stringify(actual) === JSON.stringify(value);
            break;
          case "neq":
            passed = actual !== value && JSON.stringify(actual) !== JSON.stringify(value);
            break;
          case "contains":
            passed = String(actual).includes(String(value));
            break;
          case "matches":
            passed = new RegExp(String(value)).test(String(actual));
            break;
        }
        const assertResult: AssertionResult = {
          passed,
          message: passed
            ? `Assertion passed: ${path} ${operator} ${JSON.stringify(value)}`
            : `Assertion failed: ${path} = ${JSON.stringify(actual)}, expected ${operator} ${JSON.stringify(value)}`,
          expected: value,
          actual,
        };
        return json(assertResult);
      }

      return json({
        passed: false,
        message: "No assertion specified: provide path+value or expect_error",
      });
    },
  );

  server.tool(
    "uat_mcp_disconnect",
    "Disconnect from a remote MCP server",
    {
      connection_id: z.string().describe("Connection ID to disconnect"),
    },
    async ({ connection_id }) => {
      await mcpProbe.disconnect(connection_id);
      return text(`Disconnected from MCP server (connection: ${connection_id})`);
    },
  );
}
