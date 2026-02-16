import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "playwright";
import { z } from "zod";
import { browserPool } from "../engine/browser.js";
import type { AssertionResult, MatchMode } from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function requirePage(sessionId: string): Page {
  const page = browserPool.getPage(sessionId);
  if (!page) throw new Error(`No page found for session: ${sessionId}`);
  return page;
}

function textMatch(actual: string, expected: string, mode: MatchMode): boolean {
  switch (mode) {
    case "exact":
      return actual === expected;
    case "contains":
      return actual.includes(expected);
    case "regex":
      return new RegExp(expected).test(actual);
  }
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

// ─── Registration ───────────────────────────────────────────────────────────

export function register(server: McpServer): void {
  server.tool(
    "uat_assert_visible",
    "Assert that an element matching the selector is visible on the page",
    {
      session_id: z.string().describe("Browser session ID"),
      selector: z.string().describe("CSS or Playwright selector"),
      visible: z.boolean().default(true).describe("Expected visibility (true=visible, false=hidden)"),
      timeout: z.number().optional().describe("Timeout in ms to wait for visibility"),
    },
    async ({ session_id, selector, visible, timeout }) => {
      const page = requirePage(session_id);
      const locator = page.locator(selector);

      let isVisible: boolean;
      try {
        if (timeout) {
          await locator.waitFor({ state: visible ? "visible" : "hidden", timeout });
        }
        isVisible = await locator.isVisible();
      } catch {
        isVisible = false;
      }

      const passed = isVisible === visible;
      const result: AssertionResult = {
        passed,
        message: passed
          ? `Element "${selector}" is ${visible ? "visible" : "hidden"} as expected`
          : `Element "${selector}" expected ${visible ? "visible" : "hidden"}, but was ${isVisible ? "visible" : "hidden"}`,
        expected: visible,
        actual: isVisible,
      };
      return json(result);
    },
  );

  server.tool(
    "uat_assert_text",
    "Assert that an element's text content matches an expected value",
    {
      session_id: z.string().describe("Browser session ID"),
      selector: z.string().describe("CSS or Playwright selector"),
      expected: z.string().describe("Expected text value"),
      mode: z.enum(["exact", "contains", "regex"]).default("contains")
        .describe("Match mode"),
    },
    async ({ session_id, selector, expected, mode }) => {
      const page = requirePage(session_id);
      const actual = await page.locator(selector).textContent() ?? "";

      const passed = textMatch(actual, expected, mode);
      const result: AssertionResult = {
        passed,
        message: passed
          ? `Text assertion passed (${mode}): "${actual}" matches "${expected}"`
          : `Text assertion failed (${mode}): "${actual}" does not match "${expected}"`,
        expected,
        actual,
      };
      return json(result);
    },
  );

  server.tool(
    "uat_assert_url",
    "Assert that the current page URL matches an expected pattern",
    {
      session_id: z.string().describe("Browser session ID"),
      expected: z.string().describe("Expected URL or pattern"),
      mode: z.enum(["exact", "contains", "regex"]).default("contains")
        .describe("Match mode"),
    },
    async ({ session_id, expected, mode }) => {
      const page = requirePage(session_id);
      const actual = page.url();

      const passed = textMatch(actual, expected, mode);
      const result: AssertionResult = {
        passed,
        message: passed
          ? `URL assertion passed (${mode}): "${actual}" matches "${expected}"`
          : `URL assertion failed (${mode}): "${actual}" does not match "${expected}"`,
        expected,
        actual,
      };
      return json(result);
    },
  );

  server.tool(
    "uat_assert_title",
    "Assert that the page title matches an expected value",
    {
      session_id: z.string().describe("Browser session ID"),
      expected: z.string().describe("Expected page title"),
      mode: z.enum(["exact", "contains", "regex"]).default("contains")
        .describe("Match mode"),
    },
    async ({ session_id, expected, mode }) => {
      const page = requirePage(session_id);
      const actual = await page.title();

      const passed = textMatch(actual, expected, mode);
      const result: AssertionResult = {
        passed,
        message: passed
          ? `Title assertion passed (${mode}): "${actual}" matches "${expected}"`
          : `Title assertion failed (${mode}): "${actual}" does not match "${expected}"`,
        expected,
        actual,
      };
      return json(result);
    },
  );

  server.tool(
    "uat_assert_count",
    "Assert that the number of elements matching a selector equals the expected count",
    {
      session_id: z.string().describe("Browser session ID"),
      selector: z.string().describe("CSS or Playwright selector"),
      expected: z.number().describe("Expected element count"),
      operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]).default("eq")
        .describe("Comparison operator"),
    },
    async ({ session_id, selector, expected, operator }) => {
      const page = requirePage(session_id);
      const actual = await page.locator(selector).count();

      let passed: boolean;
      switch (operator) {
        case "eq": passed = actual === expected; break;
        case "neq": passed = actual !== expected; break;
        case "gt": passed = actual > expected; break;
        case "gte": passed = actual >= expected; break;
        case "lt": passed = actual < expected; break;
        case "lte": passed = actual <= expected; break;
      }

      const result: AssertionResult = {
        passed,
        message: passed
          ? `Count assertion passed: ${actual} ${operator} ${expected}`
          : `Count assertion failed: ${actual} is not ${operator} ${expected}`,
        expected,
        actual,
      };
      return json(result);
    },
  );

  server.tool(
    "uat_assert_value",
    "Assert the value of an input element",
    {
      session_id: z.string().describe("Browser session ID"),
      selector: z.string().describe("CSS or Playwright selector for the input"),
      expected: z.string().describe("Expected input value"),
      mode: z.enum(["exact", "contains", "regex"]).default("exact")
        .describe("Match mode"),
    },
    async ({ session_id, selector, expected, mode }) => {
      const page = requirePage(session_id);
      const actual = await page.locator(selector).inputValue();

      const passed = textMatch(actual, expected, mode);
      const result: AssertionResult = {
        passed,
        message: passed
          ? `Value assertion passed (${mode}): "${actual}" matches "${expected}"`
          : `Value assertion failed (${mode}): "${actual}" does not match "${expected}"`,
        expected,
        actual,
      };
      return json(result);
    },
  );

  server.tool(
    "uat_assert_accessible",
    "Run a basic accessibility check on the page or a specific element",
    {
      session_id: z.string().describe("Browser session ID"),
      selector: z.string().optional()
        .describe("Optional selector to scope the check to a specific element"),
    },
    async ({ session_id, selector }) => {
      const page = requirePage(session_id);

      // Basic accessibility checks without external dependencies
      const checks = await page.evaluate((sel?: string) => {
        const scope = sel ? document.querySelector(sel) : document.body;
        if (!scope) return { error: `Element not found: ${sel}` };

        const issues: string[] = [];

        // Check images without alt text
        const images = scope.querySelectorAll("img:not([alt])");
        if (images.length > 0) {
          issues.push(`${images.length} image(s) missing alt text`);
        }

        // Check buttons/links without accessible text
        const interactives = scope.querySelectorAll("button, a, [role='button']");
        let emptyInteractives = 0;
        interactives.forEach((el) => {
          const text = el.textContent?.trim();
          const ariaLabel = el.getAttribute("aria-label");
          const ariaLabelledBy = el.getAttribute("aria-labelledby");
          const title = el.getAttribute("title");
          if (!text && !ariaLabel && !ariaLabelledBy && !title) {
            emptyInteractives++;
          }
        });
        if (emptyInteractives > 0) {
          issues.push(`${emptyInteractives} interactive element(s) without accessible text`);
        }

        // Check form inputs without labels
        const inputs = scope.querySelectorAll("input, select, textarea");
        let unlabeledInputs = 0;
        inputs.forEach((el) => {
          const id = el.getAttribute("id");
          const ariaLabel = el.getAttribute("aria-label");
          const ariaLabelledBy = el.getAttribute("aria-labelledby");
          const hasLabel = id ? !!document.querySelector(`label[for='${id}']`) : false;
          const parentLabel = el.closest("label");
          if (!ariaLabel && !ariaLabelledBy && !hasLabel && !parentLabel) {
            unlabeledInputs++;
          }
        });
        if (unlabeledInputs > 0) {
          issues.push(`${unlabeledInputs} form input(s) without associated labels`);
        }

        // Check for heading hierarchy
        const headings = scope.querySelectorAll("h1, h2, h3, h4, h5, h6");
        let prevLevel = 0;
        let skippedLevels = 0;
        headings.forEach((h) => {
          const level = Number(h.tagName[1]);
          if (prevLevel > 0 && level > prevLevel + 1) {
            skippedLevels++;
          }
          prevLevel = level;
        });
        if (skippedLevels > 0) {
          issues.push(`${skippedLevels} heading level skip(s) detected`);
        }

        return { issues, totalChecked: interactives.length + images.length + inputs.length + headings.length };
      }, selector);

      if ("error" in checks) {
        return json({ passed: false, message: checks.error });
      }

      const passed = checks.issues.length === 0;
      const result: AssertionResult = {
        passed,
        message: passed
          ? `Basic accessibility checks passed (${checks.totalChecked} elements checked)`
          : `Accessibility issues found:\n- ${checks.issues.join("\n- ")}`,
      };
      return json(result);
    },
  );
}
