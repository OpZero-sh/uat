import { z } from "zod";

// ─── Session ────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  type: "browser" | "api" | "mcp";
  createdAt: number;
  status: "active" | "closed";
  /** Current page URL (browser sessions only) */
  url?: string;
  /** Current page title (browser sessions only) */
  title?: string;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** Device emulation name */
  device?: string;
  /** Saved values from step results (save_as) */
  context: Record<string, unknown>;
  /** Paths to artifacts (screenshots, traces, recordings) */
  artifacts: string[];
}

export const SessionCreateOptionsSchema = z.object({
  headless: z.boolean().default(true),
  viewport: z
    .object({ width: z.number(), height: z.number() })
    .default({ width: 1280, height: 720 }),
  device: z.string().optional(),
  proxy: z
    .object({
      server: z.string(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  /** Timeout for navigation/actions in ms */
  timeout: z.number().default(30_000),
});
export type SessionCreateOptions = z.infer<typeof SessionCreateOptionsSchema>;

// ─── Flow Specs ─────────────────────────────────────────────────────────────

export type StepAction =
  // Browser navigation
  | "goto"
  | "back"
  | "forward"
  | "reload"
  | "wait"
  // Browser interaction
  | "click"
  | "fill"
  | "select"
  | "check"
  | "press"
  | "scroll"
  | "upload"
  // Browser observation
  | "screenshot"
  | "snapshot"
  | "get_text"
  | "get_attribute"
  | "evaluate"
  | "get_url"
  | "get_title"
  // Assertions
  | "assert_visible"
  | "assert_text"
  | "assert_url"
  | "assert_title"
  | "assert_count"
  | "assert_value"
  | "assert_accessible"
  | "assert_status"
  | "assert_body"
  | "assert_header"
  | "assert_timing"
  // API
  | "api_request"
  // MCP
  | "mcp_connect"
  | "mcp_list_tools"
  | "mcp_call"
  | "mcp_disconnect";

export interface FlowStep {
  action: StepAction;
  /** Save step result to session context under this key */
  save_as?: string;
  /** Conditional: only run if this context key is truthy */
  if?: string;
  /** Conditional: only run if this context key is falsy */
  unless?: string;
  /** Step-level timeout override in ms */
  timeout?: number;
  /** Arbitrary params passed to the action handler */
  [key: string]: unknown;
}

export interface FlowParallelGroup {
  parallel: FlowStep[];
}

export type FlowEntry = FlowStep | FlowParallelGroup;

export interface FlowSpec {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  steps: FlowEntry[];
}

export const FlowSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  steps: z.array(z.union([
    z.object({ parallel: z.array(z.record(z.unknown())) }),
    z.record(z.unknown()),
  ])),
});

// ─── Step Results ───────────────────────────────────────────────────────────

export type StepStatus = "pass" | "fail" | "skip" | "error";

export interface StepResult {
  action: string;
  status: StepStatus;
  /** Duration in ms */
  duration: number;
  /** Saved value if save_as was set */
  value?: unknown;
  /** Error message if status is fail/error */
  error?: string;
  /** Paths to artifacts produced by this step */
  artifacts?: string[];
}

export interface FlowResult {
  flow: string;
  status: "pass" | "fail" | "error";
  startedAt: number;
  finishedAt: number;
  /** Duration in ms */
  duration: number;
  steps: StepResult[];
  /** Aggregate artifact paths */
  artifacts: string[];
}

export interface SuiteResult {
  status: "pass" | "fail" | "error";
  startedAt: number;
  finishedAt: number;
  duration: number;
  flows: FlowResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
  };
}

// ─── API Testing ────────────────────────────────────────────────────────────

export interface ApiRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  /** Raw body text */
  bodyText: string;
  /** Response time in ms */
  timing: number;
}

// ─── MCP Testing ────────────────────────────────────────────────────────────

export interface McpConnection {
  id: string;
  url: string;
  status: "connected" | "disconnected";
  tools?: string[];
}

export interface McpCallResult {
  tool: string;
  result: unknown;
  isError: boolean;
  timing: number;
}

// ─── Assertions ─────────────────────────────────────────────────────────────

export type MatchMode = "exact" | "contains" | "regex";
export type CompareOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "matches";

export interface AssertionResult {
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

// ─── Recording / Trace ──────────────────────────────────────────────────────

export interface TraceInfo {
  sessionId: string;
  path: string;
  startedAt: number;
  stoppedAt?: number;
  size?: number;
}

export interface RecordingInfo {
  id: string;
  sessionId: string;
  type: "trace" | "video" | "api-log";
  path: string;
  createdAt: number;
  size: number;
}
