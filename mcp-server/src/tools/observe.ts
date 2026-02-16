import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionStore } from "../engine/session-store.js";
import { browserPool } from "../engine/browser.js";
import type { Page } from "playwright";

function requirePage(sessionId: string): Page {
  sessionStore.require(sessionId);
  const page = browserPool.getPage(sessionId);
  if (!page) throw new Error(`No page for session: ${sessionId}`);
  return page;
}

export function register(server: McpServer): void {
  server.tool(
    "uat_screenshot",
    "Take a screenshot of the page or a specific element, returned as base64 PNG",
    {
      session_id: z.string().describe("Session ID"),
      full_page: z.boolean().default(false).describe("Capture the full scrollable page"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector to screenshot a specific element"),
    },
    async ({ session_id, full_page, selector }) => {
      const page = requirePage(session_id);

      let buffer: Buffer;
      if (selector) {
        buffer = await page.locator(selector).screenshot();
      } else {
        buffer = await page.screenshot({ fullPage: full_page });
      }

      const base64 = buffer.toString("base64");

      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: "image/png",
          },
        ],
      };
    },
  );

  server.tool(
    "uat_snapshot",
    "Get the accessibility tree snapshot of the current page",
    {
      session_id: z.string().describe("Session ID"),
    },
    async ({ session_id }) => {
      const page = requirePage(session_id);
      const snapshot = await page.evaluate(() => {
        function buildTree(el: Element): Record<string, unknown> {
          const role = el.getAttribute("role") || el.tagName.toLowerCase();
          const name = el.getAttribute("aria-label") || el.getAttribute("alt") || (el as HTMLElement).innerText?.slice(0, 80) || "";
          const children = Array.from(el.children).map(buildTree).filter(c => c !== null);
          const node: Record<string, unknown> = { role };
          if (name) node.name = name;
          if (children.length) node.children = children;
          return node;
        }
        return buildTree(document.body);
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_get_text",
    "Get the text content of an element",
    {
      session_id: z.string().describe("Session ID"),
      selector: z.string().describe("CSS selector for the element"),
    },
    async ({ session_id, selector }) => {
      const page = requirePage(session_id);
      const text = await page.locator(selector).textContent();
      return {
        content: [{ type: "text", text: text ?? "" }],
      };
    },
  );

  server.tool(
    "uat_get_attribute",
    "Get an attribute value from an element",
    {
      session_id: z.string().describe("Session ID"),
      selector: z.string().describe("CSS selector for the element"),
      name: z.string().describe("Attribute name to retrieve"),
    },
    async ({ session_id, selector, name }) => {
      const page = requirePage(session_id);
      const value = await page.locator(selector).getAttribute(name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ attribute: name, value }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_evaluate",
    "Execute JavaScript in the page context and return the result",
    {
      session_id: z.string().describe("Session ID"),
      script: z.string().describe("JavaScript expression or function body to evaluate"),
    },
    async ({ session_id, script }) => {
      const page = requirePage(session_id);
      const result = await page.evaluate(script);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ result }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_get_url",
    "Get the current page URL",
    {
      session_id: z.string().describe("Session ID"),
    },
    async ({ session_id }) => {
      const page = requirePage(session_id);
      const url = page.url();
      sessionStore.update(session_id, { url });
      return {
        content: [{ type: "text", text: url }],
      };
    },
  );

  server.tool(
    "uat_get_title",
    "Get the current page title",
    {
      session_id: z.string().describe("Session ID"),
    },
    async ({ session_id }) => {
      const page = requirePage(session_id);
      const title = await page.title();
      sessionStore.update(session_id, { title });
      return {
        content: [{ type: "text", text: title }],
      };
    },
  );
}
