import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionStore } from "../engine/session-store.js";
import { browserPool } from "../engine/browser.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const STATE_DIR = process.env.UAT_STATE_DIR ?? "/tmp/uat-state";

export function register(server: McpServer): void {
  server.tool(
    "uat_session_create",
    "Create a new browser session with a Playwright context and page",
    {
      headless: z.boolean().default(true).describe("Run browser in headless mode"),
      viewport: z
        .object({ width: z.number(), height: z.number() })
        .default({ width: 1280, height: 720 })
        .describe("Browser viewport dimensions"),
      device: z.string().optional().describe("Device emulation name (e.g. 'iPhone 13')"),
      timeout: z.number().default(30_000).describe("Default timeout for actions in ms"),
    },
    async ({ headless, viewport, device, timeout }) => {
      const session = sessionStore.create("browser", {
        viewport,
        device,
      });

      const context = await browserPool.newContext(session.id, {
        headless,
        viewport,
        device,
        timeout,
      });
      await browserPool.newPage(session.id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              session_id: session.id,
              status: session.status,
              viewport,
              device: device ?? null,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_session_list",
    "List all active UAT sessions",
    {},
    async () => {
      const sessions = sessionStore.listActive().map((s) => ({
        id: s.id,
        type: s.type,
        status: s.status,
        url: s.url,
        title: s.title,
        createdAt: s.createdAt,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }],
      };
    },
  );

  server.tool(
    "uat_session_get",
    "Get details for a specific session including URL, title, viewport, and context keys",
    {
      session_id: z.string().describe("Session ID"),
    },
    async ({ session_id }) => {
      const session = sessionStore.require(session_id);
      const page = browserPool.getPage(session_id);

      // Sync live page state back to session
      if (page) {
        session.url = page.url();
        session.title = await page.title();
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: session.id,
              type: session.type,
              status: session.status,
              url: session.url,
              title: session.title,
              viewport: session.viewport,
              device: session.device,
              contextKeys: Object.keys(session.context),
              artifacts: session.artifacts,
              createdAt: session.createdAt,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_session_close",
    "Close a session and its browser context",
    {
      session_id: z.string().describe("Session ID to close"),
    },
    async ({ session_id }) => {
      await browserPool.closeContext(session_id);
      const session = sessionStore.close(session_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              session_id: session.id,
              status: session.status,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_session_save_state",
    "Save session cookies and storage to a file for later reuse",
    {
      session_id: z.string().describe("Session ID"),
      name: z.string().describe("Name for the saved state file"),
    },
    async ({ session_id, name }) => {
      const context = browserPool.getContext(session_id);
      if (!context) throw new Error(`No browser context for session: ${session_id}`);

      const state = await context.storageState();
      const filePath = join(STATE_DIR, `${name}.json`);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(state, null, 2));

      sessionStore.addArtifact(session_id, filePath);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ saved: filePath }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_session_load_state",
    "Load previously saved cookies and storage into a session's browser context",
    {
      session_id: z.string().describe("Session ID"),
      name: z.string().describe("Name of the saved state file to load"),
    },
    async ({ session_id, name }) => {
      const filePath = join(STATE_DIR, `${name}.json`);
      const raw = await readFile(filePath, "utf-8");
      const state = JSON.parse(raw);

      const context = browserPool.getContext(session_id);
      if (!context) throw new Error(`No browser context for session: ${session_id}`);

      // Add cookies from saved state
      if (state.cookies?.length) {
        await context.addCookies(state.cookies);
      }

      // Set storage state on the current page if there's origin storage
      if (state.origins?.length) {
        const page = browserPool.getPage(session_id);
        if (page) {
          for (const origin of state.origins) {
            if (origin.localStorage?.length) {
              await page.evaluate(
                ({ items }: { items: Array<{ name: string; value: string }> }) => {
                  for (const { name, value } of items) {
                    localStorage.setItem(name, value);
                  }
                },
                { items: origin.localStorage },
              );
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ loaded: filePath }),
          },
        ],
      };
    },
  );
}
