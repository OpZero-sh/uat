import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";

import { browserPool } from "./engine/browser.js";
import { mcpProbe } from "./engine/mcp-probe.js";

import { register as registerSession } from "./tools/session.js";
import { register as registerNavigate } from "./tools/navigate.js";
import { register as registerInteract } from "./tools/interact.js";
import { register as registerObserve } from "./tools/observe.js";
import { register as registerAssert } from "./tools/assert.js";
import { register as registerApi } from "./tools/api.js";
import { register as registerMcpClient } from "./tools/mcp-client.js";
import { register as registerFlow } from "./tools/flow.js";
import { register as registerRecord } from "./tools/record.js";
import { register as registerScenario } from "./tools/scenario.js";

const PORT = parseInt(process.env.PORT ?? "3200", 10);
const DRAIN_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Server state ──────────────────────────────────────────────────
let isReady = true;
const activeTransports = new Set<StreamableHTTPServerTransport>();

const server = new McpServer({
  name: "uat-engine",
  version: "0.1.0",
});

// Register all tool modules
registerSession(server);
registerNavigate(server);
registerInteract(server);
registerObserve(server);
registerAssert(server);
registerApi(server);
registerMcpClient(server);
registerFlow(server);
registerRecord(server);
registerScenario(server);

const httpServer = createServer(async (req, res) => {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    // Liveness probe — always responds if the process is running
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    // Readiness probe — fails during shutdown drain
    if (req.method === "GET" && req.url === "/readiness") {
      const status = isReady ? 200 : 503;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ready: isReady,
          activeTransports: activeTransports.size,
        })
      );
      return;
    }

    // Reject new MCP connections during drain
    if (!isReady) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server is shutting down" }));
      return;
    }

    // MCP endpoint
    if (req.url === "/mcp") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      activeTransports.add(transport);

      // Request timeout — 5 minute deadline
      const timeout = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request timeout" }));
          transport.close();
        }
      }, REQUEST_TIMEOUT_MS);

      res.on("close", () => {
        clearTimeout(timeout);
        activeTransports.delete(transport);
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    console.error("Request error:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, starting graceful shutdown…`);

  // 1. Stop accepting new traffic
  isReady = false;

  // 2. Stop accepting new connections
  httpServer.close();

  // 3. Drain active transports (with timeout)
  if (activeTransports.size > 0) {
    console.log(`Draining ${activeTransports.size} active transport(s)…`);
    await Promise.race([
      Promise.all(
        [...activeTransports].map((t) =>
          t.close().catch((e: unknown) =>
            console.error("Error closing transport:", e)
          )
        )
      ),
      new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
    ]);
  }

  // 4. Shut down engine singletons
  console.log("Closing browser pool…");
  await browserPool.shutdown().catch((e: unknown) =>
    console.error("Error shutting down browser pool:", e)
  );

  console.log("Disconnecting MCP probe connections…");
  await mcpProbe.disconnectAll().catch((e: unknown) =>
    console.error("Error disconnecting MCP probe:", e)
  );

  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Start ─────────────────────────────────────────────────────────
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`UAT MCP server listening on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`Readiness probe: http://0.0.0.0:${PORT}/readiness`);
});
