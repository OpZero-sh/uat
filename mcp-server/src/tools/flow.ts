import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  runFlow,
  loadFlow,
  listFlows,
  validateFlow,
} from "../engine/flow-runner.js";
import type { FlowResult, SuiteResult } from "../types.js";

// ─── Results Store ─────────────────────────────────────────────────────────

const resultsStore = new Map<string, FlowResult>();

// ─── Registration ──────────────────────────────────────────────────────────

export function register(server: McpServer): void {
  // ── uat_flow_run ────────────────────────────────────────────────────────
  server.tool(
    "uat_flow_run",
    "Load and execute a named flow, returning structured results",
    {
      name: z.string().describe("Flow name or path (e.g. 'health-check' or 'examples/health-check.yaml')"),
      session_id: z.string().optional().describe("Existing session ID to reuse"),
      variables: z.record(z.string()).optional().describe("Variables to inject into flow context"),
    },
    async ({ name, session_id, variables }) => {
      try {
        const spec = await loadFlow(name);

        // Inject variables into flow config
        if (variables) {
          spec.config = { ...spec.config, ...variables };
        }

        const result = await runFlow(spec, session_id);
        const runId = randomUUID().slice(0, 8);
        resultsStore.set(runId, result);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ run_id: runId, ...result }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── uat_flow_run_suite ──────────────────────────────────────────────────
  server.tool(
    "uat_flow_run_suite",
    "Run multiple flows sequentially and return aggregated results",
    {
      flows: z.array(z.string()).describe("List of flow names to run"),
      variables: z.record(z.string()).optional().describe("Variables to inject into all flows"),
      stop_on_failure: z.boolean().default(true).describe("Stop suite on first flow failure"),
    },
    async ({ flows, variables, stop_on_failure }) => {
      const startedAt = Date.now();
      const flowResults: FlowResult[] = [];
      let suiteStatus: SuiteResult["status"] = "pass";

      for (const name of flows) {
        try {
          const spec = await loadFlow(name);
          if (variables) {
            spec.config = { ...spec.config, ...variables };
          }

          const result = await runFlow(spec);
          flowResults.push(result);

          if (result.status !== "pass") {
            suiteStatus = result.status === "error" ? "error" : "fail";
            if (stop_on_failure) break;
          }
        } catch (err) {
          const errorResult: FlowResult = {
            flow: name,
            status: "error",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            duration: 0,
            steps: [],
            artifacts: [],
          };
          flowResults.push(errorResult);
          suiteStatus = "error";
          if (stop_on_failure) break;
        }
      }

      const finishedAt = Date.now();
      const suite: SuiteResult = {
        status: suiteStatus,
        startedAt,
        finishedAt,
        duration: finishedAt - startedAt,
        flows: flowResults,
        summary: {
          total: flowResults.length,
          passed: flowResults.filter((f) => f.status === "pass").length,
          failed: flowResults.filter((f) => f.status === "fail").length,
          errored: flowResults.filter((f) => f.status === "error").length,
        },
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(suite, null, 2),
          },
        ],
      };
    }
  );

  // ── uat_flow_list ───────────────────────────────────────────────────────
  server.tool(
    "uat_flow_list",
    "List available flow specs from the flows/ directory",
    {},
    async () => {
      const flows = await listFlows();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ flows, count: flows.length }, null, 2),
          },
        ],
      };
    }
  );

  // ── uat_flow_validate ───────────────────────────────────────────────────
  server.tool(
    "uat_flow_validate",
    "Validate a flow spec without running it",
    {
      name: z.string().optional().describe("Flow name to load and validate"),
      spec: z.string().optional().describe("Inline flow spec as YAML or JSON string"),
    },
    async ({ name, spec }) => {
      try {
        let flowSpec;
        if (name) {
          flowSpec = await loadFlow(name);
        } else if (spec) {
          const YAML = await import("yaml");
          flowSpec = YAML.parse(spec);
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Provide either 'name' or 'spec'" }),
              },
            ],
            isError: true,
          };
        }

        const result = validateFlow(flowSpec);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                valid: false,
                errors: [err instanceof Error ? err.message : String(err)],
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── uat_flow_get_results ────────────────────────────────────────────────
  server.tool(
    "uat_flow_get_results",
    "Get results from a completed flow run by run ID",
    {
      run_id: z.string().describe("Run ID returned from uat_flow_run"),
    },
    async ({ run_id }) => {
      const result = resultsStore.get(run_id);
      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `No results found for run ID: ${run_id}`,
                available: Array.from(resultsStore.keys()),
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
