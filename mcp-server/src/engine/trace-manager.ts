import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "playwright";
import type { TraceInfo, RecordingInfo } from "../types.js";

const TRACE_DIR = "/tmp/uat-traces";

/** Ensure the trace output directory exists. */
function ensureTraceDir(): void {
  mkdirSync(TRACE_DIR, { recursive: true });
}

/**
 * Manages Playwright tracing and recording artifacts.
 * Starts/stops traces on BrowserContexts, stores metadata,
 * and provides access to saved trace files.
 */
class TraceManager {
  private activeTraces = new Map<string, TraceInfo>();
  private recordings = new Map<string, RecordingInfo>();

  /** Start Playwright tracing on a browser context. */
  async startTrace(sessionId: string, context: BrowserContext): Promise<TraceInfo> {
    if (this.activeTraces.has(sessionId)) {
      throw new Error(`Trace already active for session: ${sessionId}`);
    }

    ensureTraceDir();

    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });

    const trace: TraceInfo = {
      sessionId,
      path: "",
      startedAt: Date.now(),
    };

    this.activeTraces.set(sessionId, trace);
    return trace;
  }

  /** Stop tracing and save the trace file. Returns the completed TraceInfo. */
  async stopTrace(
    sessionId: string,
    context: BrowserContext
  ): Promise<TraceInfo> {
    const trace = this.activeTraces.get(sessionId);
    if (!trace) {
      throw new Error(`No active trace for session: ${sessionId}`);
    }

    ensureTraceDir();

    const filename = `trace-${sessionId}-${Date.now()}.zip`;
    const tracePath = join(TRACE_DIR, filename);

    await context.tracing.stop({ path: tracePath });

    trace.path = tracePath;
    trace.stoppedAt = Date.now();

    try {
      const stat = statSync(tracePath);
      trace.size = stat.size;
    } catch {
      // File size unavailable
    }

    this.activeTraces.delete(sessionId);

    // Register as a recording
    const recordingId = randomUUID().slice(0, 8);
    this.recordings.set(recordingId, {
      id: recordingId,
      sessionId,
      type: "trace",
      path: tracePath,
      createdAt: Date.now(),
      size: trace.size ?? 0,
    });

    return trace;
  }

  /** Check if a session has an active trace. */
  isTracing(sessionId: string): boolean {
    return this.activeTraces.has(sessionId);
  }

  /** List all saved recordings. */
  listRecordings(): RecordingInfo[] {
    return Array.from(this.recordings.values());
  }

  /** Get a specific recording by ID. */
  getRecording(id: string): RecordingInfo {
    const recording = this.recordings.get(id);
    if (!recording) throw new Error(`Recording not found: ${id}`);
    return recording;
  }

  /** Return the file path for a recording (for download/export). */
  exportRecording(id: string): string {
    const recording = this.getRecording(id);
    return recording.path;
  }

  /** Register an external recording (screenshot, video, etc). */
  addRecording(
    sessionId: string,
    type: RecordingInfo["type"],
    path: string
  ): RecordingInfo {
    const id = randomUUID().slice(0, 8);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // File may not exist yet
    }

    const recording: RecordingInfo = {
      id,
      sessionId,
      type,
      path,
      createdAt: Date.now(),
      size,
    };

    this.recordings.set(id, recording);
    return recording;
  }

  /** Scan the trace directory for any trace files not already registered. */
  scanDirectory(): RecordingInfo[] {
    ensureTraceDir();
    const found: RecordingInfo[] = [];

    for (const file of readdirSync(TRACE_DIR)) {
      if (!file.endsWith(".zip")) continue;

      // Check if already registered
      const alreadyRegistered = Array.from(this.recordings.values()).some(
        (r) => r.path === join(TRACE_DIR, file)
      );
      if (alreadyRegistered) continue;

      const stat = statSync(join(TRACE_DIR, file));
      const recording = this.addRecording("unknown", "trace", join(TRACE_DIR, file));
      recording.size = stat.size;
      found.push(recording);
    }

    return found;
  }
}

export const traceManager = new TraceManager();
