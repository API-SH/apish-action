/**
 * One GET to api.sh, with the same retry rules as the official SDKs: 502/503/504 and network errors are retried
 * with backoff (failed calls are never charged). Kept small on purpose: the action bundles its code into dist/.
 */
export class ApishError extends Error {
  constructor(status, message, requestId) {
    super(message);
    this.name = "ApishError";
    this.status = status;
    this.requestId = requestId;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callApi({ baseUrl, apiKey, route, params, fetch = globalThis.fetch, retries = 2, timeoutMs = 120_000, backoffMs = 1000, userAgent = "apish-action" }) {
  if (!route.startsWith("/")) route = "/" + route;
  const url = new URL(baseUrl.replace(/\/+$/, "") + route);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "x-api-key": apiKey, accept: "application/json", "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoffMs * 2 ** attempt);
      continue;
    }
    const meta = {
      requestId: res.headers.get("x-request-id") || "",
      credits: res.headers.get("x-credits-used") ?? "",
      creditsRemaining: res.headers.get("x-credits-remaining") ?? "",
      contentType: res.headers.get("content-type") || "",
    };
    const text = await res.text();
    if (res.ok) return { text, meta };
    let message = `api.sh answered HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      message = body.error || body.message || message;
    } catch {
      // not JSON
    }
    if (![502, 503, 504].includes(res.status) || attempt >= retries) throw new ApishError(res.status, message, meta.requestId);
    const after = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : backoffMs * 2 ** attempt);
  }
}
