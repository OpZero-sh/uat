import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { SessionCreateOptions } from "../types.js";

interface ContextEntry {
  context: BrowserContext;
  pages: Map<string, Page>;
}

/**
 * Singleton browser pool. Manages a single Chromium instance with
 * isolated BrowserContexts per session.
 */
class BrowserPool {
  private browser: Browser | null = null;
  private contexts = new Map<string, ContextEntry>();

  /** Launch the browser if not already running. */
  async launch(): Promise<void> {
    if (this.browser?.isConnected()) return;
    this.browser = await chromium.launch({ headless: true });
  }

  /** Ensure browser is launched, then return it. */
  private async getBrowser(): Promise<Browser> {
    await this.launch();
    return this.browser!;
  }

  /** Create an isolated BrowserContext for a session. */
  async newContext(
    sessionId: string,
    opts: SessionCreateOptions
  ): Promise<BrowserContext> {
    const browser = await this.getBrowser();

    const contextOpts: Record<string, unknown> = {
      viewport: opts.viewport,
    };

    if (opts.device) {
      // Playwright devices are available as a top-level import
      const { devices } = await import("playwright");
      const device = devices[opts.device];
      if (device) Object.assign(contextOpts, device);
    }

    if (opts.proxy) {
      contextOpts.proxy = {
        server: opts.proxy.server,
        username: opts.proxy.username,
        password: opts.proxy.password,
      };
    }

    const context = await browser.newContext(contextOpts);
    context.setDefaultTimeout(opts.timeout);

    this.contexts.set(sessionId, { context, pages: new Map() });
    return context;
  }

  /** Create a new page in the session's context. Returns the page and a generated page ID. */
  async newPage(sessionId: string): Promise<{ page: Page; pageId: string }> {
    const entry = this.contexts.get(sessionId);
    if (!entry) throw new Error(`No browser context for session: ${sessionId}`);

    const page = await entry.context.newPage();
    const pageId = `page-${entry.pages.size}`;
    entry.pages.set(pageId, page);
    return { page, pageId };
  }

  /** Get the context entry for a session. */
  getContext(sessionId: string): BrowserContext | undefined {
    return this.contexts.get(sessionId)?.context;
  }

  /** Get the first (or only) page for a session. */
  getPage(sessionId: string): Page | undefined {
    const entry = this.contexts.get(sessionId);
    if (!entry) return undefined;
    // Return the first page
    const first = entry.pages.values().next();
    return first.done ? undefined : first.value;
  }

  /** Get a specific page by ID. */
  getPageById(sessionId: string, pageId: string): Page | undefined {
    return this.contexts.get(sessionId)?.pages.get(pageId);
  }

  /** Close a session's context and all its pages. */
  async closeContext(sessionId: string): Promise<void> {
    const entry = this.contexts.get(sessionId);
    if (!entry) return;
    await entry.context.close();
    this.contexts.delete(sessionId);
  }

  /** Shut down the browser entirely. */
  async shutdown(): Promise<void> {
    // Close all contexts first
    for (const [sessionId] of this.contexts) {
      await this.closeContext(sessionId);
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /** Check if the browser is running. */
  isRunning(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  /** Get count of active contexts. */
  get activeContexts(): number {
    return this.contexts.size;
  }
}

export const browserPool = new BrowserPool();
