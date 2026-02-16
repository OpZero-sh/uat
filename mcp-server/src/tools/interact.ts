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

/**
 * Resolve a locator from flexible selector options.
 * Supports CSS/XPath selectors, or role/text/testid-based locators.
 */
function resolveLocator(
  page: Page,
  opts: { selector?: string; role?: string; text?: string; test_id?: string },
) {
  if (opts.test_id) return page.getByTestId(opts.test_id);
  if (opts.role) {
    return page.getByRole(opts.role as Parameters<Page["getByRole"]>[0], {
      name: opts.text,
    });
  }
  if (opts.text) return page.getByText(opts.text);
  if (opts.selector) return page.locator(opts.selector);
  throw new Error("One of selector, role, text, or test_id is required");
}

const locatorParams = {
  selector: z.string().optional().describe("CSS or XPath selector"),
  role: z.string().optional().describe("ARIA role (e.g. 'button', 'link')"),
  text: z.string().optional().describe("Text content to match (or name for role)"),
  test_id: z.string().optional().describe("data-testid value"),
};

export function register(server: McpServer): void {
  server.tool(
    "uat_click",
    "Click an element by selector, role, text, or test ID",
    {
      session_id: z.string().describe("Session ID"),
      ...locatorParams,
      button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button"),
      click_count: z.number().default(1).describe("Number of clicks"),
      timeout: z.number().optional().describe("Timeout in ms"),
    },
    async ({ session_id, selector, role, text, test_id, button, click_count, timeout }) => {
      const page = requirePage(session_id);
      const locator = resolveLocator(page, { selector, role, text, test_id });
      await locator.click({ button, clickCount: click_count, timeout });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ clicked: selector ?? role ?? text ?? test_id }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_fill",
    "Fill a text input with a value",
    {
      session_id: z.string().describe("Session ID"),
      ...locatorParams,
      value: z.string().describe("Value to fill"),
      timeout: z.number().optional().describe("Timeout in ms"),
    },
    async ({ session_id, selector, role, text, test_id, value, timeout }) => {
      const page = requirePage(session_id);
      const resolved = sessionStore.interpolate(session_id, value);
      const locator = resolveLocator(page, { selector, role, text, test_id });
      await locator.fill(resolved, { timeout });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              filled: selector ?? role ?? text ?? test_id,
              value: resolved,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_select",
    "Select an option from a dropdown",
    {
      session_id: z.string().describe("Session ID"),
      selector: z.string().describe("CSS selector for the <select> element"),
      value: z.string().describe("Option value to select"),
      timeout: z.number().optional().describe("Timeout in ms"),
    },
    async ({ session_id, selector, value, timeout }) => {
      const page = requirePage(session_id);
      const resolved = sessionStore.interpolate(session_id, value);
      await page.selectOption(selector, resolved, { timeout });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ selected: resolved, selector }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_check",
    "Check or uncheck a checkbox",
    {
      session_id: z.string().describe("Session ID"),
      ...locatorParams,
      checked: z.boolean().default(true).describe("true to check, false to uncheck"),
      timeout: z.number().optional().describe("Timeout in ms"),
    },
    async ({ session_id, selector, role, text, test_id, checked, timeout }) => {
      const page = requirePage(session_id);
      const locator = resolveLocator(page, { selector, role, text, test_id });
      if (checked) {
        await locator.check({ timeout });
      } else {
        await locator.uncheck({ timeout });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              target: selector ?? role ?? text ?? test_id,
              checked,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_press",
    "Press a keyboard key or key combination (e.g. 'Enter', 'Control+a')",
    {
      session_id: z.string().describe("Session ID"),
      key: z.string().describe("Key or key combination to press"),
    },
    async ({ session_id, key }) => {
      const page = requirePage(session_id);
      await page.keyboard.press(key);
      return {
        content: [{ type: "text", text: JSON.stringify({ pressed: key }) }],
      };
    },
  );

  server.tool(
    "uat_scroll",
    "Scroll the page or an element",
    {
      session_id: z.string().describe("Session ID"),
      direction: z
        .enum(["up", "down", "left", "right"])
        .default("down")
        .describe("Scroll direction"),
      amount: z.number().default(500).describe("Scroll amount in pixels"),
      selector: z.string().optional().describe("Element to scroll (defaults to page)"),
    },
    async ({ session_id, direction, amount, selector }) => {
      const page = requirePage(session_id);

      const deltaX =
        direction === "left" ? -amount : direction === "right" ? amount : 0;
      const deltaY =
        direction === "up" ? -amount : direction === "down" ? amount : 0;

      if (selector) {
        await page.locator(selector).evaluate(
          (el, { dx, dy }) => {
            el.scrollBy(dx, dy);
          },
          { dx: deltaX, dy: deltaY },
        );
      } else {
        await page.evaluate(
          ({ dx, dy }) => {
            window.scrollBy(dx, dy);
          },
          { dx: deltaX, dy: deltaY },
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ scrolled: direction, amount, selector: selector ?? "page" }),
          },
        ],
      };
    },
  );

  server.tool(
    "uat_upload",
    "Upload a file to a file input element",
    {
      session_id: z.string().describe("Session ID"),
      selector: z.string().describe("CSS selector for the file input"),
      path: z.string().describe("Absolute path to the file to upload"),
    },
    async ({ session_id, selector, path }) => {
      const page = requirePage(session_id);
      await page.setInputFiles(selector, path);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ uploaded: path, selector }),
          },
        ],
      };
    },
  );
}
