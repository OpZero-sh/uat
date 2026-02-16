import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browserPool } from "../engine/browser.js";
import { traceManager } from "../engine/trace-manager.js";
import { sessionStore } from "../engine/session-store.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

// ─── Registration ───────────────────────────────────────────────────────────

export function register(server: McpServer): void {
  server.tool(
    "uat_trace_start",
    "Start a Playwright trace recording for a browser session",
    {
      session_id: z.string().describe("Browser session ID"),
    },
    async ({ session_id }) => {
      const context = browserPool.getContext(session_id);
      if (!context) throw new Error(`No browser context for session: ${session_id}`);

      const traceInfo = await traceManager.startTrace(session_id, context);

      return json({
        sessionId: traceInfo.sessionId,
        path: traceInfo.path,
        startedAt: traceInfo.startedAt,
        message: "Trace recording started",
      });
    },
  );

  server.tool(
    "uat_trace_stop",
    "Stop a running trace recording and save the trace file",
    {
      session_id: z.string().describe("Browser session ID"),
    },
    async ({ session_id }) => {
      const context = browserPool.getContext(session_id);
      if (!context) throw new Error(`No browser context for session: ${session_id}`);

      const traceInfo = await traceManager.stopTrace(session_id, context);

      // Register the trace as a session artifact
      if (traceInfo.path) {
        sessionStore.addArtifact(session_id, traceInfo.path);
      }

      return json({
        sessionId: traceInfo.sessionId,
        path: traceInfo.path,
        startedAt: traceInfo.startedAt,
        stoppedAt: traceInfo.stoppedAt,
        size: traceInfo.size,
        message: "Trace recording stopped",
      });
    },
  );

  server.tool(
    "uat_recording_list",
    "List all available recordings (traces, videos, API logs)",
    {},
    async () => {
      const recordings = traceManager.listRecordings();
      return json({
        count: recordings.length,
        recordings,
      });
    },
  );

  server.tool(
    "uat_recording_export",
    "Export a recording file and return its path",
    {
      id: z.string().describe("Recording ID"),
    },
    async ({ id }) => {
      const path = traceManager.exportRecording(id);
      const recording = traceManager.getRecording(id);
      return json({
        id,
        path,
        size: recording.size,
        message: "Recording exported",
      });
    },
  );
}
