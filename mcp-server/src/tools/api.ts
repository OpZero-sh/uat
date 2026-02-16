import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendRequest } from "../engine/http-client.js";
import { sessionStore } from "../engine/session-store.js";
import type { ApiResponse, AssertionResult, CompareOperator } from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveResponse(
  response: ApiResponse | undefined,
  ref: string | undefined,
  sessionId: string | undefined,
): ApiResponse {
  if (response) return response;
  if (ref && sessionId) {
    const saved = sessionStore.getContext(sessionId, ref);
    if (saved && typeof saved === "object" && "status" in (saved as object)) {
      return saved as ApiResponse;
    }
    throw new Error(`Context key "${ref}" is not a valid API response`);
  }
  throw new Error("Either response or ref + session_id must be provided");
}

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    // Handle array indexing: items.0.name
    const idx = Number(part);
    if (Array.isArray(current) && !Number.isNaN(idx)) {
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function compare(
  actual: unknown,
  operator: CompareOperator,
  expected: unknown,
): AssertionResult {
  const a = actual;
  const e = expected;
  let passed = false;
  switch (operator) {
    case "eq":
      passed = a === e || JSON.stringify(a) === JSON.stringify(e);
      break;
    case "neq":
      passed = a !== e && JSON.stringify(a) !== JSON.stringify(e);
      break;
    case "gt":
      passed = Number(a) > Number(e);
      break;
    case "gte":
      passed = Number(a) >= Number(e);
      break;
    case "lt":
      passed = Number(a) < Number(e);
      break;
    case "lte":
      passed = Number(a) <= Number(e);
      break;
    case "contains":
      passed = String(a).includes(String(e));
      break;
    case "matches":
      passed = new RegExp(String(e)).test(String(a));
      break;
  }
  return {
    passed,
    message: passed
      ? `Assertion passed: ${JSON.stringify(a)} ${operator} ${JSON.stringify(e)}`
      : `Assertion failed: expected ${JSON.stringify(a)} ${operator} ${JSON.stringify(e)}`,
    expected: e,
    actual: a,
  };
}

function matchStatus(actual: number, pattern: string): boolean {
  // Exact match: "200"
  if (/^\d{3}$/.test(pattern)) return actual === Number(pattern);
  // Class match: "2xx", "4xx"
  if (/^\d[xX]{2}$/.test(pattern)) {
    return Math.floor(actual / 100) === Number(pattern[0]);
  }
  return actual === Number(pattern);
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
    "uat_api_request",
    "Send an HTTP request and optionally save the response to session context",
    {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
        .describe("HTTP method"),
      url: z.string().describe("Request URL"),
      headers: z.record(z.string()).optional().describe("Request headers"),
      body: z.unknown().optional().describe("Request body (JSON)"),
      timeout: z.number().optional().describe("Timeout in ms"),
      session_id: z.string().optional().describe("Session ID for context storage"),
      save_as: z.string().optional().describe("Save response to session context under this key"),
    },
    async ({ method, url, headers, body, timeout, session_id, save_as }) => {
      // Interpolate URL if session context available
      let resolvedUrl = url;
      if (session_id) {
        resolvedUrl = sessionStore.interpolate(session_id, url);
      }

      const response = await sendRequest({
        method,
        url: resolvedUrl,
        headers,
        body,
        timeout,
      });

      if (save_as && session_id) {
        sessionStore.saveContext(session_id, save_as, response);
      }

      return json({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
        timing: response.timing,
      });
    },
  );

  server.tool(
    "uat_api_assert_status",
    "Assert that an API response status matches an expected value or pattern (e.g. 200, '2xx')",
    {
      status: z.number().describe("Actual response status code"),
      expected: z.string().describe("Expected status: exact number or pattern like '2xx'"),
    },
    async ({ status, expected }) => {
      const passed = matchStatus(status, expected);
      const result: AssertionResult = {
        passed,
        message: passed
          ? `Status ${status} matches ${expected}`
          : `Status ${status} does not match ${expected}`,
        expected,
        actual: status,
      };
      return json(result);
    },
  );

  server.tool(
    "uat_api_assert_body",
    "Assert a value in the API response body using a JSON path and comparison operator",
    {
      response: z.record(z.unknown()).optional()
        .describe("Full API response object (or use ref + session_id)"),
      ref: z.string().optional().describe("Context key referencing a saved response"),
      session_id: z.string().optional().describe("Session ID for context lookup"),
      path: z.string().describe("Dot-separated path into the response body (e.g. 'data.id')"),
      operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "matches"])
        .default("eq")
        .describe("Comparison operator"),
      value: z.unknown().describe("Expected value"),
    },
    async ({ response, ref, session_id, path, operator, value }) => {
      const res = resolveResponse(
        response as ApiResponse | undefined,
        ref,
        session_id,
      );
      const actual = resolvePath(res.body, path);
      const result = compare(actual, operator, value);
      return json(result);
    },
  );

  server.tool(
    "uat_api_assert_header",
    "Assert that an API response header has an expected value",
    {
      response: z.record(z.unknown()).optional()
        .describe("Full API response object (or use ref + session_id)"),
      ref: z.string().optional().describe("Context key referencing a saved response"),
      session_id: z.string().optional().describe("Session ID for context lookup"),
      header: z.string().describe("Header name (case-insensitive)"),
      operator: z.enum(["eq", "neq", "contains", "matches"])
        .default("eq")
        .describe("Comparison operator"),
      value: z.string().describe("Expected header value"),
    },
    async ({ response, ref, session_id, header, operator, value }) => {
      const res = resolveResponse(
        response as ApiResponse | undefined,
        ref,
        session_id,
      );
      // Headers are stored lowercase
      const headerKey = header.toLowerCase();
      const actual = res.headers[headerKey] ?? res.headers[header];
      const result = compare(actual, operator, value);
      return json(result);
    },
  );

  server.tool(
    "uat_api_assert_timing",
    "Assert that the API response time is under a threshold",
    {
      timing: z.number().describe("Actual response time in ms"),
      threshold_ms: z.number().describe("Maximum acceptable response time in ms"),
    },
    async ({ timing, threshold_ms }) => {
      const passed = timing <= threshold_ms;
      const result: AssertionResult = {
        passed,
        message: passed
          ? `Response time ${timing}ms is within ${threshold_ms}ms threshold`
          : `Response time ${timing}ms exceeds ${threshold_ms}ms threshold`,
        expected: threshold_ms,
        actual: timing,
      };
      return json(result);
    },
  );
}
