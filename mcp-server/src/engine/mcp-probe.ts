import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { McpConnection, McpCallResult } from "../types.js";

interface ConnectionEntry {
  client: Client;
  transport: StreamableHTTPClientTransport;
  connection: McpConnection;
}

/**
 * MCP probe for testing MCP servers. Connects via StreamableHTTP transport,
 * lists tools, and calls tools with timing measurement.
 */
class McpProbe {
  private connections = new Map<string, ConnectionEntry>();

  /** Connect to an MCP server and return connection info. */
  async connect(url: string, auth?: string): Promise<McpConnection> {
    const id = randomUUID().slice(0, 8);

    const headers: Record<string, string> = {};
    if (auth) {
      headers["Authorization"] = auth.startsWith("Bearer ")
        ? auth
        : `Bearer ${auth}`;
    }

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
    });

    const client = new Client({
      name: "uat-mcp-probe",
      version: "1.0.0",
    });

    await client.connect(transport);

    const connection: McpConnection = {
      id,
      url,
      status: "connected",
    };

    this.connections.set(id, { client, transport, connection });
    return connection;
  }

  /** List available tools on a connection. */
  async listTools(connectionId: string): Promise<string[]> {
    const entry = this.requireConnection(connectionId);
    const result = await entry.client.listTools();
    const tools = result.tools.map((t) => t.name);
    entry.connection.tools = tools;
    return tools;
  }

  /** Call a tool on a connection and measure timing. */
  async callTool(
    connectionId: string,
    tool: string,
    params: Record<string, unknown> = {}
  ): Promise<McpCallResult> {
    const entry = this.requireConnection(connectionId);

    const start = Date.now();
    const result = await entry.client.callTool({
      name: tool,
      arguments: params,
    });
    const timing = Date.now() - start;

    return {
      tool,
      result: result.content,
      isError: Boolean(result.isError),
      timing,
    };
  }

  /** Disconnect from an MCP server. */
  async disconnect(connectionId: string): Promise<void> {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    entry.connection.status = "disconnected";
    await entry.client.close();
    this.connections.delete(connectionId);
  }

  /** Get connection info. */
  getConnection(connectionId: string): McpConnection | undefined {
    return this.connections.get(connectionId)?.connection;
  }

  /** Disconnect all connections. */
  async disconnectAll(): Promise<void> {
    for (const [id] of this.connections) {
      await this.disconnect(id);
    }
  }

  private requireConnection(connectionId: string): ConnectionEntry {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`MCP connection not found: ${connectionId}`);
    if (entry.connection.status === "disconnected") {
      throw new Error(`MCP connection is disconnected: ${connectionId}`);
    }
    return entry;
  }
}

export const mcpProbe = new McpProbe();
