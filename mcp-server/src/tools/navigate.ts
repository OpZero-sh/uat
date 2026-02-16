import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionStore } from "../engine/session-store.js";
import { browserPool } from "../engine/browser.js";

function requirePage(sessionId: string) {
  sessionStore.require(sessionId); // validates session exists and is active
  const page = browserPool.getPage(sessionId);
  if (!page) throw new Error(`No page for session: ${sessionId}`);
  return page;
}

export function register(server: McpServer): void {
  server.tool(
    "uat_goto",
    "Navigate to a URL",
    {
      session_id: z.string().describe("Session ID"),
      url: z.string().describe("URL to navigate to"),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle", "commit"])
        .default("load")
        .describe("Wait strategy for navigation"),
    },
    async ({ session_id, url, wait_until }) => {
      const page = requirePage(session_id);
      const resolved = sessionStore.interpolate(session_id, url);
      const response = await page.goto(resolved, { waitUntil: wait_until });

      const session = sessionStore.update(session_id, {
        url: page.url(),
        title: await page.title(),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: session.url,
              title: session.title,
              status: response?.status() ?? null,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_back",
    "Navigate back in browser history",
    {
      session_id: z.string().describe("Session ID"),
    },
    async ({ session_id }) => {
      const page = requirePage(session_id);
      await page.goBack();

      const session = sessionStore.update(session_id, {
        url: page.url(),
        title: await page.title(),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ url: session.url, title: session.title }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_forward",
    "Navigate forward in browser history",
    {
      session_id: z.string().describe("Session ID"),
    },
    async ({ session_id }) => {
      const page = requirePage(session_id);
      await page.goForward();

      const session = sessionStore.update(session_id, {
        url: page.url(),
        title: await page.title(),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ url: session.url, title: session.title }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_reload",
    "Reload the current page",
    {
      session_id: z.string().describe("Session ID"),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle", "commit"])
        .default("load")
        .describe("Wait strategy for reload"),
    },
    async ({ session_id, wait_until }) => {
      const page = requirePage(session_id);
      await page.reload({ waitUntil: wait_until });

      const session = sessionStore.update(session_id, {
        url: page.url(),
        title: await page.title(),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ url: session.url, title: session.title }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_wait",
    "Wait for a condition: selector, url, networkidle, or timeout",
    {
      session_id: z.string().describe("Session ID"),
      condition: z
        .enum(["selector", "url", "networkidle", "timeout"])
        .describe("Type of wait condition"),
      value: z
        .string()
        .optional()
        .describe("Selector string, URL pattern, or timeout in ms"),
      timeout: z
        .number()
        .default(30_000)
        .describe("Maximum time to wait in ms"),
    },
    async ({ session_id, condition, value, timeout }) => {
      const page = requirePage(session_id);

      switch (condition) {
        case "selector":
          if (!value) throw new Error("value is required for selector wait");
          await page.waitForSelector(value, { timeout });
          break;
        case "url":
          if (!value) throw new Error("value is required for url wait");
          await page.waitForURL(value, { timeout });
          break;
        case "networkidle":
          await page.waitForLoadState("networkidle", { timeout });
          break;
        case "timeout": {
          const ms = value ? parseInt(value, 10) : timeout;
          await page.waitForTimeout(ms);
          break;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              waited: condition,
              value: value ?? null,
            }),
          },
        ],
      };
    },
  );
}
