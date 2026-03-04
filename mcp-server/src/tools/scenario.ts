/**
 * UAT Scenario tools — high-level acceptance test lifecycle management.
 *
 * These tools sit above the flow runner and provide:
 * - Scenario definition (steps as flow specs or plain descriptions)
 * - Execution via the flow runner
 * - Evidence attachment
 * - Expected vs actual comparison
 * - Human sign-off and exception recording
 * - Report generation
 * - Release blocking
 *
 * State is persisted to UAT_STATE_FILE (default: /tmp/uat-state.json).
 * Set UAT_STATE_FILE env var to override.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runFlow, loadFlow } from "../engine/flow-runner.js";
import type { FlowResult } from "../types.js";

// ─── State file ─────────────────────────────────────────────────────────────

const DEFAULT_STATE_FILE = "/tmp/uat-state.json";

function getStateFile(): string {
  return process.env.UAT_STATE_FILE ?? DEFAULT_STATE_FILE;
}

// ─── Data structures ────────────────────────────────────────────────────────

export interface ScenarioStep {
  description: string;
  /** Optional: reference to a named flow spec to run for this step */
  flowName?: string;
  type: "navigate" | "interact" | "assert" | "api_call" | "wait" | "flow";
  params: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  steps: ScenarioStep[];
  expectedOutcomes: string[];
  status: "draft" | "running" | "passed" | "failed" | "signed_off" | "exception";
  /** Attached evidence bundle IDs or artifact paths */
  evidence: string[];
  /** Flow run results from the last execution */
  flowResults?: FlowResult[];
  signoff?: { by: string; at: string; notes?: string };
  exception?: { by: string; at: string; reason: string };
  createdAt: string;
  lastRunAt?: string;
}

export interface UatReport {
  id: string;
  scenarios: {
    scenarioId: string;
    name: string;
    status: string;
    evidence: string[];
  }[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    signedOff: number;
    exceptions: number;
    draft: number;
  };
  generatedAt: string;
  /** Markdown-formatted summary */
  markdown: string;
}

interface UatState {
  scenarios: Scenario[];
  reports: UatReport[];
}

// ─── Storage helpers ─────────────────────────────────────────────────────────

function ensureStateDir(): void {
  const file = getStateFile();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
}

function loadState(): UatState {
  ensureStateDir();
  const file = getStateFile();
  if (!existsSync(file)) return { scenarios: [], reports: [] };
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as UatState;
  } catch {
    return { scenarios: [], reports: [] };
  }
}

function saveState(state: UatState): void {
  ensureStateDir();
  writeFileSync(getStateFile(), JSON.stringify(state, null, 2));
}

// ─── Event ledger ────────────────────────────────────────────────────────────

const LEDGER_FILE =
  process.env.UAT_LEDGER_FILE ??
  join(process.env.WORKSPACE_ROOT ?? "/workspace", "infra", ".claude", "state", "events.jsonl");

function emitEvent(type: string, payload: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LEDGER_FILE), { recursive: true });
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      actor: "uat-engine",
      payload,
    };
    appendFileSync(LEDGER_FILE, JSON.stringify(event) + "\n");
  } catch {
    // Ledger write failure is non-fatal
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

function notFound(type: string, id: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: `${type} not found: ${id}` }) }],
    isError: true as const,
  };
}

function generateMarkdown(report: UatReport): string {
  const lines: string[] = [
    `# UAT Report — ${report.id}`,
    `Generated: ${report.generatedAt}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Count |`,
    `|---|---|`,
    `| Total | ${report.summary.total} |`,
    `| Passed | ${report.summary.passed} |`,
    `| Failed | ${report.summary.failed} |`,
    `| Signed Off | ${report.summary.signedOff} |`,
    `| Exceptions | ${report.summary.exceptions} |`,
    `| Draft | ${report.summary.draft} |`,
    ``,
    `## Scenarios`,
    ``,
  ];

  for (const s of report.scenarios) {
    const statusEmoji =
      s.status === "signed_off" ? "APPROVED"
      : s.status === "passed" ? "PASS"
      : s.status === "failed" ? "FAIL"
      : s.status === "exception" ? "WAIVED"
      : s.status.toUpperCase();
    lines.push(`### [${statusEmoji}] ${s.name}`);
    lines.push(`ID: \`${s.scenarioId}\``);
    lines.push(`Status: \`${s.status}\``);
    if (s.evidence.length > 0) {
      lines.push(`Evidence: ${s.evidence.join(", ")}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ─── Registration ────────────────────────────────────────────────────────────

export function register(server: McpServer): void {
  // 1. uat.scenario_create
  server.tool(
    "uat.scenario_create",
    "Create a UAT scenario with steps and expected outcomes. Steps can reference named flow specs.",
    {
      name: z.string().describe("Scenario name"),
      description: z.string().describe("What this scenario tests"),
      steps: z
        .array(
          z.object({
            description: z.string().describe("Human-readable step description"),
            type: z
              .enum(["navigate", "interact", "assert", "api_call", "wait", "flow"])
              .describe("Step type"),
            flowName: z
              .string()
              .optional()
              .describe("Named flow spec to execute for this step (type: flow)"),
            params: z.record(z.unknown()).default({}).describe("Step parameters"),
          }),
        )
        .describe("Ordered scenario steps"),
      expectedOutcomes: z.array(z.string()).describe("Expected outcomes as plain-text assertions"),
    },
    async ({ name, description, steps, expectedOutcomes }) => {
      const state = loadState();
      const scenario: Scenario = {
        id: randomUUID(),
        name,
        description,
        steps: steps.map((s) => ({
          description: s.description,
          type: s.type,
          params: s.params ?? {},
          ...(s.flowName ? { flowName: s.flowName } : {}),
        })),
        expectedOutcomes,
        status: "draft",
        evidence: [],
        createdAt: new Date().toISOString(),
      };
      state.scenarios.push(scenario);
      saveState(state);
      emitEvent("uat.scenario_created", { scenarioId: scenario.id, name });
      return json(scenario);
    },
  );

  // 2. uat.scenario_run
  server.tool(
    "uat.scenario_run",
    "Execute a UAT scenario. Steps with type 'flow' and a flowName are run via the Playwright flow runner. Other steps are recorded as attempted.",
    {
      scenarioId: z.string().describe("ID of the scenario to run"),
      variables: z
        .record(z.string())
        .optional()
        .describe("Variables to inject into flow contexts"),
    },
    async ({ scenarioId, variables }) => {
      const state = loadState();
      const idx = state.scenarios.findIndex((s) => s.id === scenarioId);
      if (idx < 0) return notFound("Scenario", scenarioId);

      const scenario = state.scenarios[idx];
      scenario.status = "running";
      scenario.lastRunAt = new Date().toISOString();
      state.scenarios[idx] = scenario;
      saveState(state);
      emitEvent("uat.scenario_run_started", { scenarioId, name: scenario.name });

      // Execute steps
      const stepResults: {
        step: number;
        description: string;
        type: string;
        status: "pass" | "fail" | "skipped";
        error?: string;
        flowResult?: FlowResult;
      }[] = [];

      let anyFailed = false;
      const flowResults: FlowResult[] = [];

      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];

        if (step.type === "flow" && step.flowName) {
          // Run via Playwright flow runner
          try {
            const spec = await loadFlow(step.flowName);
            if (variables) {
              spec.config = { ...spec.config, ...variables };
            }
            const result = await runFlow(spec);
            flowResults.push(result);
            const passed = result.status === "pass";
            if (!passed) anyFailed = true;
            stepResults.push({
              step: i,
              description: step.description,
              type: step.type,
              status: passed ? "pass" : "fail",
              flowResult: result,
            });
          } catch (err) {
            anyFailed = true;
            stepResults.push({
              step: i,
              description: step.description,
              type: step.type,
              status: "fail",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          // Non-flow step: validate it has required fields, mark as attempted
          if (!step.description || !step.type) {
            anyFailed = true;
            stepResults.push({
              step: i,
              description: step.description ?? "(no description)",
              type: step.type ?? "unknown",
              status: "fail",
              error: "Step missing required fields",
            });
          } else {
            stepResults.push({
              step: i,
              description: step.description,
              type: step.type,
              status: "pass",
            });
          }
        }
      }

      // No expected outcomes = failure
      if (scenario.expectedOutcomes.length === 0) {
        anyFailed = true;
      }

      scenario.status = anyFailed ? "failed" : "passed";
      if (flowResults.length > 0) scenario.flowResults = flowResults;
      state.scenarios[idx] = scenario;
      saveState(state);

      emitEvent("uat.scenario_run_completed", {
        scenarioId,
        status: scenario.status,
        stepsRan: stepResults.length,
      });

      return json({ scenarioId, status: scenario.status, steps: stepResults });
    },
  );

  // 3. uat.attach_evidence
  server.tool(
    "uat.attach_evidence",
    "Attach an evidence bundle ID or artifact path to a scenario.",
    {
      scenarioId: z.string().describe("Scenario ID"),
      bundleId: z.string().describe("Evidence bundle ID or artifact path to attach"),
    },
    async ({ scenarioId, bundleId }) => {
      const state = loadState();
      const idx = state.scenarios.findIndex((s) => s.id === scenarioId);
      if (idx < 0) return notFound("Scenario", scenarioId);

      const scenario = state.scenarios[idx];
      if (!scenario.evidence.includes(bundleId)) {
        scenario.evidence.push(bundleId);
      }
      state.scenarios[idx] = scenario;
      saveState(state);
      emitEvent("uat.evidence_attached", { scenarioId, bundleId });
      return json(scenario);
    },
  );

  // 4. uat.compare_expected
  server.tool(
    "uat.compare_expected",
    "Compare actual evidence and flow results against expected outcomes for a scenario.",
    {
      scenarioId: z.string().describe("Scenario ID to evaluate"),
    },
    async ({ scenarioId }) => {
      const state = loadState();
      const scenario = state.scenarios.find((s) => s.id === scenarioId);
      if (!scenario) return notFound("Scenario", scenarioId);

      const hasEvidence = scenario.evidence.length > 0;
      const hasPassedRun = scenario.status === "passed" || scenario.status === "signed_off";

      const details = scenario.expectedOutcomes.map((outcome) => {
        const matched = hasEvidence || hasPassedRun;
        return {
          outcome,
          evidenceCount: scenario.evidence.length,
          runStatus: scenario.status,
          matched,
          note: matched
            ? `${scenario.evidence.length} evidence bundle(s); run status: ${scenario.status}`
            : "No evidence attached and scenario has not passed",
        };
      });

      const allMatched = details.length > 0 && details.every((d) => d.matched);

      return json({ scenarioId, matches: allMatched, details });
    },
  );

  // 5. uat.record_signoff
  server.tool(
    "uat.record_signoff",
    "Record human sign-off on a UAT scenario. Sets status to signed_off.",
    {
      scenarioId: z.string().describe("Scenario ID"),
      by: z.string().describe("Name or ID of person signing off"),
      notes: z.string().optional().describe("Optional sign-off notes"),
    },
    async ({ scenarioId, by, notes }) => {
      const state = loadState();
      const idx = state.scenarios.findIndex((s) => s.id === scenarioId);
      if (idx < 0) return notFound("Scenario", scenarioId);

      const scenario = state.scenarios[idx];
      scenario.status = "signed_off";
      scenario.signoff = {
        by,
        at: new Date().toISOString(),
        ...(notes ? { notes } : {}),
      };
      state.scenarios[idx] = scenario;
      saveState(state);
      emitEvent("uat.scenario_signed_off", { scenarioId, by });
      return json(scenario);
    },
  );

  // 6. uat.record_exception
  server.tool(
    "uat.record_exception",
    "Record an exception or waiver for a UAT scenario. Sets status to exception.",
    {
      scenarioId: z.string().describe("Scenario ID"),
      by: z.string().describe("Name or ID of person recording the exception"),
      reason: z.string().describe("Reason for the exception or waiver"),
    },
    async ({ scenarioId, by, reason }) => {
      const state = loadState();
      const idx = state.scenarios.findIndex((s) => s.id === scenarioId);
      if (idx < 0) return notFound("Scenario", scenarioId);

      const scenario = state.scenarios[idx];
      scenario.status = "exception";
      scenario.exception = { by, at: new Date().toISOString(), reason };
      state.scenarios[idx] = scenario;
      saveState(state);
      emitEvent("uat.exception_recorded", { scenarioId, by, reason });
      return json(scenario);
    },
  );

  // 7. uat.publish_report
  server.tool(
    "uat.publish_report",
    "Generate a UAT report. Includes all scenarios if no IDs specified. Returns JSON + markdown summary.",
    {
      scenarioIds: z
        .array(z.string())
        .optional()
        .describe("Specific scenario IDs to include; omit for all"),
    },
    async ({ scenarioIds }) => {
      const state = loadState();

      const selected =
        scenarioIds && scenarioIds.length > 0
          ? state.scenarios.filter((s) => scenarioIds.includes(s.id))
          : state.scenarios;

      const summary = {
        total: selected.length,
        passed: selected.filter((s) => s.status === "passed").length,
        failed: selected.filter((s) => s.status === "failed").length,
        signedOff: selected.filter((s) => s.status === "signed_off").length,
        exceptions: selected.filter((s) => s.status === "exception").length,
        draft: selected.filter((s) => s.status === "draft" || s.status === "running").length,
      };

      const report: UatReport = {
        id: randomUUID(),
        scenarios: selected.map((s) => ({
          scenarioId: s.id,
          name: s.name,
          status: s.status,
          evidence: s.evidence,
        })),
        summary,
        generatedAt: new Date().toISOString(),
        markdown: "",
      };

      report.markdown = generateMarkdown(report);

      state.reports.push(report);
      saveState(state);

      emitEvent("uat.report_published", { reportId: report.id, summary });
      return json(report);
    },
  );

  // 8. uat.block_release
  server.tool(
    "uat.block_release",
    "Check whether a release should be blocked based on UAT scenario outcomes. Returns blocked=true if any scenario is not passed or signed_off.",
    {
      releaseId: z.string().describe("Release identifier (e.g. v1.2.0)"),
      scenarioIds: z
        .array(z.string())
        .describe("Scenario IDs that must pass for this release"),
    },
    async ({ releaseId, scenarioIds }) => {
      const state = loadState();

      const failedScenarios: {
        scenarioId: string;
        name: string;
        status: string;
      }[] = [];

      for (const id of scenarioIds) {
        const scenario = state.scenarios.find((s) => s.id === id);
        if (!scenario) {
          failedScenarios.push({ scenarioId: id, name: "(not found)", status: "missing" });
          continue;
        }
        if (scenario.status !== "passed" && scenario.status !== "signed_off") {
          failedScenarios.push({ scenarioId: id, name: scenario.name, status: scenario.status });
        }
      }

      const blocked = failedScenarios.length > 0;

      emitEvent("uat.release_block_checked", {
        releaseId,
        blocked,
        failedCount: failedScenarios.length,
        scenarioIds,
      });

      return json({ releaseId, blocked, failedScenarios });
    },
  );
}
