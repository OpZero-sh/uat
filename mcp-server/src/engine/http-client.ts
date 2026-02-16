import type { ApiRequest, ApiResponse } from "../types.js";

/**
 * Send an HTTP request and return a structured ApiResponse with timing info.
 */
export async function sendRequest(req: ApiRequest): Promise<ApiResponse> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (req.timeout) {
    timeoutId = setTimeout(() => controller.abort(), req.timeout);
  }

  const fetchOpts: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: controller.signal,
  };

  if (req.body !== undefined) {
    fetchOpts.body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  const start = Date.now();

  try {
    const res = await fetch(req.url, fetchOpts);
    const timing = Date.now() - start;

    const bodyText = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let body: unknown = bodyText;

    if (contentType.includes("json") && bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Keep as text if JSON parse fails
      }
    }

    // Convert headers to a plain record
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      bodyText,
      timing,
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
