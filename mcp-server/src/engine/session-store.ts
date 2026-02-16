import type { Session } from "../types.js";
import { randomUUID } from "node:crypto";

/**
 * In-memory session store. Tracks active browser/API/MCP sessions
 * and their context (saved values from step results).
 */
class SessionStore {
  private sessions = new Map<string, Session>();

  create(type: Session["type"], overrides?: Partial<Session>): Session {
    const id = randomUUID().slice(0, 8);
    const session: Session = {
      id,
      type,
      createdAt: Date.now(),
      status: "active",
      context: {},
      artifacts: [],
      ...overrides,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (session.status === "closed") throw new Error(`Session is closed: ${id}`);
    return session;
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  listActive(): Session[] {
    return this.list().filter((s) => s.status === "active");
  }

  update(id: string, patch: Partial<Session>): Session {
    const session = this.require(id);
    Object.assign(session, patch);
    return session;
  }

  /** Save a value to the session context (used by save_as in flows) */
  saveContext(id: string, key: string, value: unknown): void {
    const session = this.require(id);
    session.context[key] = value;
  }

  /** Get a value from session context */
  getContext(id: string, key: string): unknown {
    const session = this.require(id);
    return session.context[key];
  }

  /** Resolve ${var} references against session context and env vars */
  interpolate(id: string, template: string): string {
    const session = this.require(id);
    return template.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
      // Try dotted path in session context first: ${deploy.body.url}
      const value = resolvePath(session.context, expr);
      if (value !== undefined) return String(value);
      // Fall back to env vars
      const envVal = process.env[expr];
      if (envVal !== undefined) return envVal;
      // Return original placeholder if unresolved
      return match;
    });
  }

  /** Add an artifact path to the session */
  addArtifact(id: string, path: string): void {
    const session = this.require(id);
    session.artifacts.push(path);
  }

  close(id: string): Session {
    const session = this.require(id);
    session.status = "closed";
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }
}

/** Resolve a dotted path like "deploy.body.url" against an object */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export const sessionStore = new SessionStore();
