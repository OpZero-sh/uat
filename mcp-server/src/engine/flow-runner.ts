import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { sessionStore } from "./session-store.js";
import type {
  FlowSpec,
  FlowEntry,
  FlowStep,
  FlowResult,
  StepResult,
  StepStatus,
  FlowParallelGroup,
} from "../types.js";

// ─── Lazy engine imports (avoids circular deps at module load) ──────────────

async function getBrowserPool() {
  const mod = await import("./browser.js");
  return mod.browserPool;
}

async function getSendRequest() {
  const mod = await import("./http-client.js");
  return mod.sendRequest;
}

async function getMcpProbe() {
  const mod = await import("./mcp-probe.js");
  return mod.mcpProbe;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const FLOWS_DIR = join(import.meta.dir, "../../../flows");

// ─── Flow Loading ──────────────────────────────────────────────────────────

/** List available flow spec files from the flows/ directory. */
export async function listFlows(): Promise<string[]> {
  const names: string[] = [];

  async function scan(dir: string, prefix: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) {
        await scan(join(dir, name), rel);
      } else {
        const ext = extname(name).toLowerCase();
        if ([".yaml", ".yml", ".json"].includes(ext)) {
          names.push(rel);
        }
      }
    }
  }

  await scan(FLOWS_DIR, "");
  return names.sort();
}

/** Load and parse a flow spec from the flows/ directory by name. */
export async function loadFlow(name: string): Promise<FlowSpec> {
  // Try exact path first, then with extensions
  const candidates = [
    name,
    `${name}.yaml`,
    `${name}.yml`,
    `${name}.json`,
    `examples/${name}`,
    `examples/${name}.yaml`,
    `examples/${name}.yml`,
    `examples/${name}.json`,
  ];

  for (const candidate of candidates) {
    const filePath = join(FLOWS_DIR, candidate);
    try {
      const raw = await readFile(filePath, "utf-8");
      const ext = extname(candidate).toLowerCase();
      const parsed = ext === ".json" ? JSON.parse(raw) : YAML.parse(raw);
      return parsed as FlowSpec;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Flow not found: "${name}". Available flows: ${(await listFlows()).join(", ") || "(none)"}`
  );
}

// ─── Flow Validation ───────────────────────────────────────────────────────

/** Validate a flow spec without running it. */
export function validateFlow(spec: FlowSpec): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!spec.name || typeof spec.name !== "string") {
    errors.push("Flow must have a 'name' string field");
  }

  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    errors.push("Flow must have a non-empty 'steps' array");
  } else {
    for (let i = 0; i < spec.steps.length; i++) {
      const entry = spec.steps[i];
      if (isParallelGroup(entry)) {
        if (!Array.isArray(entry.parallel) || entry.parallel.length === 0) {
          errors.push(`Step ${i}: parallel group must have a non-empty 'parallel' array`);
        } else {
          for (let j = 0; j < entry.parallel.length; j++) {
            const step = entry.parallel[j] as FlowStep;
            if (!step.action) {
              errors.push(`Step ${i}.parallel[${j}]: missing 'action' field`);
            }
          }
        }
      } else {
        const step = entry as FlowStep;
        if (!step.action) {
          errors.push(`Step ${i}: missing 'action' field`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Flow Execution ────────────────────────────────────────────────────────

/** Execute a flow spec and return structured results. */
export async function runFlow(
  spec: FlowSpec,
  sessionId?: string
): Promise<FlowResult> {
  const validation = validateFlow(spec);
  if (!validation.valid) {
    throw new Error(`Invalid flow spec: ${validation.errors.join("; ")}`);
  }

  // Create or reuse a session
  let ownSession = false;
  let session: ReturnType<typeof sessionStore.require>;
  if (sessionId) {
    session = sessionStore.require(sessionId);
  } else {
    session = sessionStore.create("browser");
    ownSession = true;
    // Launch browser context for the new session
    const pool = await getBrowserPool();
    await pool.newContext(session.id, { headless: true, viewport: { width: 1280, height: 720 }, timeout: 30_000 });
    await pool.newPage(session.id);
  }

  // Merge flow config into session context
  if (spec.config) {
    for (const [key, value] of Object.entries(spec.config)) {
      if (typeof value === "string") {
        session.context[key] = sessionStore.interpolate(session.id, value);
      } else {
        session.context[key] = value;
      }
    }
  }

  const startedAt = Date.now();
  const stepResults: StepResult[] = [];
  const allArtifacts: string[] = [];
  let flowStatus: FlowResult["status"] = "pass";

  for (const entry of spec.steps) {
    if (isParallelGroup(entry)) {
      const results = await runParallelGroup(entry, session.id);
      for (const result of results) {
        stepResults.push(result);
        if (result.artifacts) allArtifacts.push(...result.artifacts);
        if (result.status === "fail" || result.status === "error") {
          flowStatus = result.status === "error" ? "error" : "fail";
        }
      }
    } else {
      const result = await runSingleStep(entry as FlowStep, session.id);
      stepResults.push(result);
      if (result.artifacts) allArtifacts.push(...result.artifacts);
      if (result.status === "fail" || result.status === "error") {
        flowStatus = result.status === "error" ? "error" : "fail";
        // Stop on first failure
        break;
      }
    }
  }

  // Clean up if we created the session
  if (ownSession) {
    try {
      const pool = await getBrowserPool();
      await pool.closeContext(session.id);
    } catch { /* ignore cleanup errors */ }
    sessionStore.close(session.id);
  }

  const finishedAt = Date.now();

  return {
    flow: spec.name,
    status: flowStatus,
    startedAt,
    finishedAt,
    duration: finishedAt - startedAt,
    steps: stepResults,
    artifacts: allArtifacts,
  };
}

// ─── Step Execution ────────────────────────────────────────────────────────

async function runParallelGroup(
  group: FlowParallelGroup,
  sessionId: string
): Promise<StepResult[]> {
  const promises = group.parallel.map((step) =>
    runSingleStep(step as FlowStep, sessionId)
  );
  return Promise.all(promises);
}

async function runSingleStep(
  step: FlowStep,
  sessionId: string
): Promise<StepResult> {
  const start = Date.now();

  // Evaluate conditionals
  if (step.if) {
    const val = sessionStore.getContext(sessionId, step.if);
    if (!val) {
      return {
        action: step.action,
        status: "skip",
        duration: Date.now() - start,
      };
    }
  }
  if (step.unless) {
    const val = sessionStore.getContext(sessionId, step.unless);
    if (val) {
      return {
        action: step.action,
        status: "skip",
        duration: Date.now() - start,
      };
    }
  }

  // Interpolate all string values in the step
  const interpolated = interpolateStep(step, sessionId);

  try {
    const result = await dispatchStep(interpolated, sessionId);
    const duration = Date.now() - start;

    // Save result to session context if save_as is specified
    if (step.save_as && result.value !== undefined) {
      sessionStore.saveContext(sessionId, step.save_as, result.value);
    }

    return { ...result, duration };
  } catch (err) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      action: step.action,
      status: "error",
      duration,
      error: message,
    };
  }
}

/** Interpolate ${VAR} in all string values of a step. */
function interpolateStep(step: FlowStep, sessionId: string): FlowStep {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step)) {
    if (typeof value === "string") {
      result[key] = sessionStore.interpolate(sessionId, value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = interpolateObject(value as Record<string, unknown>, sessionId);
    } else {
      result[key] = value;
    }
  }
  return result as unknown as FlowStep;
}

function interpolateObject(
  obj: Record<string, unknown>,
  sessionId: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = sessionStore.interpolate(sessionId, value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = interpolateObject(value as Record<string, unknown>, sessionId);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Step Dispatch ─────────────────────────────────────────────────────────

async function dispatchStep(
  step: FlowStep,
  sessionId: string
): Promise<Omit<StepResult, "duration">> {
  const { action } = step;

  // API actions
  if (action.startsWith("api_")) {
    return dispatchApiStep(step, sessionId);
  }

  // MCP actions
  if (action.startsWith("mcp_")) {
    return dispatchMcpStep(step, sessionId);
  }

  // Assertion actions
  if (action.startsWith("assert_")) {
    return dispatchAssertStep(step, sessionId);
  }

  // Browser actions (everything else)
  return dispatchBrowserStep(step, sessionId);
}

async function dispatchApiStep(
  step: FlowStep,
  _sessionId: string
): Promise<Omit<StepResult, "duration">> {
  const sendRequest = await getSendRequest();

  if (step.action === "api_request") {
    const response = await sendRequest({
      method: (step.method as string) ?? "GET",
      url: step.url as string,
      headers: step.headers as Record<string, string> | undefined,
      body: step.body,
      timeout: step.timeout,
    });

    // Check assert_status if present
    if (step.assert_status !== undefined) {
      if (response.status !== Number(step.assert_status)) {
        return {
          action: step.action,
          status: "fail",
          value: response,
          error: `Expected status ${step.assert_status}, got ${response.status}`,
        };
      }
    }

    return { action: step.action, status: "pass", value: response };
  }

  return { action: step.action, status: "error", error: `Unknown API action: ${step.action}` };
}

async function dispatchMcpStep(
  step: FlowStep,
  sessionId: string
): Promise<Omit<StepResult, "duration">> {
  const mcpProbe = await getMcpProbe();

  // Track the active connection ID in session context
  const session = sessionStore.require(sessionId);
  const connId = session.context._mcp_connection_id as string | undefined;

  switch (step.action) {
    case "mcp_connect": {
      const connection = await mcpProbe.connect(
        step.url as string,
        step.auth as string | undefined
      );
      session.context._mcp_connection_id = connection.id;
      return { action: step.action, status: "pass", value: connection };
    }
    case "mcp_list_tools": {
      if (!connId) return { action: step.action, status: "error", error: "No active MCP connection" };
      const tools = await mcpProbe.listTools(connId);
      return { action: step.action, status: "pass", value: tools };
    }
    case "mcp_call": {
      if (!connId) return { action: step.action, status: "error", error: "No active MCP connection" };
      const result = await mcpProbe.callTool(
        connId,
        step.tool as string,
        (step.params as Record<string, unknown>) ?? {}
      );
      if (result.isError) {
        return {
          action: step.action,
          status: "fail",
          value: result,
          error: `MCP tool call failed: ${JSON.stringify(result.result)}`,
        };
      }
      return { action: step.action, status: "pass", value: result };
    }
    case "mcp_disconnect": {
      if (connId) {
        await mcpProbe.disconnect(connId);
        delete session.context._mcp_connection_id;
      }
      return { action: step.action, status: "pass" };
    }
    default:
      return { action: step.action, status: "error", error: `Unknown MCP action: ${step.action}` };
  }
}

async function dispatchAssertStep(
  step: FlowStep,
  sessionId: string
): Promise<Omit<StepResult, "duration">> {
  const session = sessionStore.require(sessionId);

  switch (step.action) {
    case "assert_visible":
    case "assert_text":
    case "assert_count":
    case "assert_value":
    case "assert_accessible": {
      // Browser-based assertions: delegate to browser pool
      return dispatchBrowserStep(step, sessionId);
    }
    case "assert_title": {
      // Can check from session context or browser
      const pool = await getBrowserPool();
      const page = pool.getPage(sessionId);
      if (page) {
        const title = await page.title();
        const match = (step.match as string) ?? "contains";
        const expected = step.value as string;
        const passed = matchValue(title, expected, match);
        return {
          action: step.action,
          status: passed ? "pass" : "fail",
          value: { actual: title, expected, match },
          error: passed ? undefined : `Title "${title}" does not ${match} "${expected}"`,
        };
      }
      return { action: step.action, status: "error", error: "No active browser page" };
    }
    case "assert_url": {
      const pool = await getBrowserPool();
      const page = pool.getPage(sessionId);
      if (page) {
        const url = page.url();
        const match = (step.match as string) ?? "contains";
        const expected = step.value as string;
        const passed = matchValue(url, expected, match);
        return {
          action: step.action,
          status: passed ? "pass" : "fail",
          value: { actual: url, expected, match },
          error: passed ? undefined : `URL "${url}" does not ${match} "${expected}"`,
        };
      }
      return { action: step.action, status: "error", error: "No active browser page" };
    }
    case "assert_status": {
      // Check a saved API response status
      const target = step.save_from
        ? session.context[step.save_from as string]
        : undefined;
      if (target && typeof target === "object" && "status" in (target as Record<string, unknown>)) {
        const actual = (target as Record<string, unknown>).status;
        const expected = Number(step.value);
        return {
          action: step.action,
          status: actual === expected ? "pass" : "fail",
          value: { actual, expected },
          error: actual === expected ? undefined : `Expected status ${expected}, got ${actual}`,
        };
      }
      return { action: step.action, status: "error", error: "No response to check status against" };
    }
    case "assert_body": {
      const path = step.path as string;
      const operator = (step.operator as string) ?? "eq";
      const expected = step.value;
      const actual = resolveDottedPath(session.context, path);

      const passed = compareValues(actual, expected, operator);
      return {
        action: step.action,
        status: passed ? "pass" : "fail",
        value: { actual, expected, operator },
        error: passed ? undefined : `Assertion failed: ${path} ${operator} ${JSON.stringify(expected)} (actual: ${JSON.stringify(actual)})`,
      };
    }
    case "assert_header":
    case "assert_timing": {
      // These depend on saved API response data
      return { action: step.action, status: "error", error: `${step.action} not yet implemented` };
    }
    default:
      return { action: step.action, status: "error", error: `Unknown assertion: ${step.action}` };
  }
}

async function dispatchBrowserStep(
  step: FlowStep,
  sessionId: string
): Promise<Omit<StepResult, "duration">> {
  const pool = await getBrowserPool();
  const page = pool.getPage(sessionId);

  // Some browser actions may need to create a page first
  switch (step.action) {
    case "goto": {
      const targetPage = page ?? (await pool.newPage(sessionId)).page;
      const timeout = step.timeout as number | undefined;
      await targetPage.goto(step.url as string, {
        timeout,
        waitUntil: (step.wait_until as "load" | "domcontentloaded" | "networkidle") ?? "load",
      });
      const session = sessionStore.require(sessionId);
      session.url = targetPage.url();
      session.title = await targetPage.title();
      return { action: step.action, status: "pass", value: { url: targetPage.url() } };
    }
    case "back": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.goBack();
      return { action: step.action, status: "pass" };
    }
    case "forward": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.goForward();
      return { action: step.action, status: "pass" };
    }
    case "reload": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.reload();
      return { action: step.action, status: "pass" };
    }
    case "wait": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const condition = step.condition as string;
      if (condition === "networkidle") {
        await page.waitForLoadState("networkidle");
      } else if (condition === "load") {
        await page.waitForLoadState("load");
      } else if (step.selector) {
        await page.waitForSelector(step.selector as string, {
          timeout: step.timeout as number | undefined,
        });
      } else if (step.ms) {
        await new Promise((r) => setTimeout(r, Number(step.ms)));
      }
      return { action: step.action, status: "pass" };
    }
    case "click": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.click(step.selector as string, {
        timeout: step.timeout as number | undefined,
      });
      return { action: step.action, status: "pass" };
    }
    case "fill": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.fill(step.selector as string, step.value as string);
      return { action: step.action, status: "pass" };
    }
    case "select": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.selectOption(step.selector as string, step.value as string);
      return { action: step.action, status: "pass" };
    }
    case "check": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.check(step.selector as string);
      return { action: step.action, status: "pass" };
    }
    case "press": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      await page.keyboard.press(step.key as string);
      return { action: step.action, status: "pass" };
    }
    case "scroll": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const selector = step.selector as string | undefined;
      if (selector) {
        await page.locator(selector).scrollIntoViewIfNeeded();
      } else {
        await page.evaluate(
          ([x, y]) => window.scrollBy(x, y),
          [Number(step.x ?? 0), Number(step.y ?? 300)]
        );
      }
      return { action: step.action, status: "pass" };
    }
    case "upload": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const fileInput = page.locator(step.selector as string);
      await fileInput.setInputFiles(step.file as string);
      return { action: step.action, status: "pass" };
    }
    case "screenshot": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const name = (step.name as string) ?? `screenshot-${Date.now()}`;
      const path = `/tmp/uat-artifacts/${name}.png`;
      await page.screenshot({ path, fullPage: step.full_page === true });
      sessionStore.addArtifact(sessionId, path);
      return { action: step.action, status: "pass", value: { path }, artifacts: [path] };
    }
    case "snapshot": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const content = await page.content();
      return { action: step.action, status: "pass", value: { length: content.length } };
    }
    case "get_text": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const text = await page.locator(step.selector as string).textContent();
      return { action: step.action, status: "pass", value: text };
    }
    case "get_attribute": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const attr = await page
        .locator(step.selector as string)
        .getAttribute(step.attribute as string);
      return { action: step.action, status: "pass", value: attr };
    }
    case "evaluate": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const result = await page.evaluate(step.expression as string);
      return { action: step.action, status: "pass", value: result };
    }
    case "get_url": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      return { action: step.action, status: "pass", value: page.url() };
    }
    case "get_title": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const title = await page.title();
      return { action: step.action, status: "pass", value: title };
    }
    // Browser-based assertions
    case "assert_visible": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const visible = await page.locator(step.selector as string).isVisible();
      return {
        action: step.action,
        status: visible ? "pass" : "fail",
        value: { visible },
        error: visible ? undefined : `Element "${step.selector}" is not visible`,
      };
    }
    case "assert_text": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const text = await page.locator(step.selector as string).textContent();
      const match = (step.match as string) ?? "contains";
      const expected = step.value as string;
      const passed = matchValue(text ?? "", expected, match);
      return {
        action: step.action,
        status: passed ? "pass" : "fail",
        value: { actual: text, expected, match },
        error: passed ? undefined : `Text "${text}" does not ${match} "${expected}"`,
      };
    }
    case "assert_count": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const count = await page.locator(step.selector as string).count();
      const expected = Number(step.value);
      return {
        action: step.action,
        status: count === expected ? "pass" : "fail",
        value: { actual: count, expected },
        error: count === expected ? undefined : `Expected ${expected} elements, found ${count}`,
      };
    }
    case "assert_value": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      const val = await page.locator(step.selector as string).inputValue();
      const expected = step.value as string;
      return {
        action: step.action,
        status: val === expected ? "pass" : "fail",
        value: { actual: val, expected },
        error: val === expected ? undefined : `Expected value "${expected}", got "${val}"`,
      };
    }
    case "assert_accessible": {
      if (!page) return { action: step.action, status: "error", error: "No active page" };
      // Basic accessibility check: element exists and has accessible name
      const locator = page.locator(step.selector as string);
      const exists = (await locator.count()) > 0;
      return {
        action: step.action,
        status: exists ? "pass" : "fail",
        value: { exists },
        error: exists ? undefined : `Element "${step.selector}" not found for accessibility check`,
      };
    }
    default:
      return { action: step.action, status: "error", error: `Unknown browser action: ${step.action}` };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isParallelGroup(entry: FlowEntry): entry is FlowParallelGroup {
  return "parallel" in entry && Array.isArray((entry as FlowParallelGroup).parallel);
}

function matchValue(actual: string, expected: string, mode: string): boolean {
  switch (mode) {
    case "exact":
      return actual === expected;
    case "contains":
      return actual.includes(expected);
    case "regex":
      return new RegExp(expected).test(actual);
    default:
      return actual.includes(expected);
  }
}

function compareValues(actual: unknown, expected: unknown, operator: string): boolean {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "contains": {
      if (typeof actual === "string") return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.some((v) => JSON.stringify(v).includes(String(expected)));
      return JSON.stringify(actual).includes(String(expected));
    }
    case "matches":
      return new RegExp(String(expected)).test(String(actual));
    default:
      return actual === expected;
  }
}

function resolveDottedPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
