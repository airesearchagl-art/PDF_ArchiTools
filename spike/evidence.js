/**
 * Shared evidence helpers for the research harness.
 *
 * Plain ESM with no Node built-ins, so the same code runs in the Vite-bundled
 * browser harness and in the Node drivers. One implementation means an error
 * captured in the page and an error captured in the driver have the same shape
 * in the artifact.
 */

/**
 * Turn a thrown value into something an artifact can actually be diagnosed from.
 *
 * `String(error.stack)` is not enough, and that is precisely how the previous
 * evidence run lost its own root cause. PDF.js exceptions derive from
 * BaseException, which puts the real reason on `message` and often `details`,
 * while the stack can bottom out at `BaseExceptionClosure` and name neither the
 * failing operation nor the reason. Capture the fields separately and never
 * collapse them into one string.
 */
export function describeError(error, stage = null) {
  if (error === null || error === undefined) return null;

  if (typeof error !== 'object') {
    return { stage, name: typeof error, message: String(error), details: null, stack: null };
  }

  const out = {
    stage,
    name: error.name ?? error.constructor?.name ?? null,
    message: typeof error.message === 'string' ? error.message : null,
    // PDF.js BaseException subclasses put the underlying reason here.
    details: error.details ?? null,
    stack: typeof error.stack === 'string' ? error.stack : null,
  };

  // Errors from workers and WASM glue often hang the useful part off a
  // non-standard property, so keep whatever else the object owns.
  const known = new Set(['name', 'message', 'details', 'stack']);
  const extra = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    if (known.has(key)) continue;
    let value;
    try {
      value = error[key];
      if (typeof value === 'function') continue;
      if (typeof value === 'object' && value !== null) value = safeShallow(value);
    } catch (readError) {
      value = `<unreadable: ${readError?.message ?? 'unknown'}>`;
    }
    extra[key] = value;
  }
  if (Object.keys(extra).length) out.extra = extra;

  if (error.cause !== undefined && error.cause !== null) {
    out.cause = describeError(error.cause, `${stage ?? 'unknown'} > cause`);
  }

  return out;
}

/** One level deep, so a nested object cannot drag in something unserializable. */
function safeShallow(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  } catch {
    return `<unserializable ${Object.prototype.toString.call(value)}>`;
  }
}

/**
 * Does this request actually leave the machine?
 *
 * Only http(s) to a non-loopback host counts. `data:` and `blob:` URLs never
 * touch the network -- they are how bundlers inline WASM -- and counting them as
 * external both overstated the number and, because the whole base64 payload was
 * kept as evidence, inflated one artifact to about 10 MB.
 */
export function isExternalRequest(url) {
  if (typeof url !== 'string' || url.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost'));
}

/** Keep a URL identifiable in evidence without letting a data: URI bloat it. */
export function summarizeUrl(url, max = 200) {
  if (typeof url !== 'string') return String(url);
  if (url.length <= max) return url;
  return `${url.slice(0, max)}... [truncated, ${url.length} chars total]`;
}

/** Group observed responses into external vs local, without storing payloads. */
export function networkEvidence(responses, failedRequests = [], consoleErrors = []) {
  const external = [];
  const nonNetworkSchemeCounts = {};
  let localhostRequestCount = 0;

  for (const entry of responses) {
    const url = entry?.url ?? '';
    if (isExternalRequest(url)) {
      external.push({
        url: summarizeUrl(url),
        status: entry.status ?? null,
        contentLength: Number.isFinite(entry.contentLength) ? entry.contentLength : null,
        contentType: entry.contentType ?? null,
      });
      continue;
    }
    let scheme = 'unknown:';
    try { scheme = new URL(url).protocol; } catch { /* relative or malformed */ }
    if (scheme === 'http:' || scheme === 'https:') localhostRequestCount++;
    else nonNetworkSchemeCounts[scheme] = (nonNetworkSchemeCounts[scheme] ?? 0) + 1;
  }

  return {
    externalRequestCount: external.length,
    externalKnownContentLengthBytes: external.reduce(
      (sum, r) => sum + (Number.isFinite(r.contentLength) ? r.contentLength : 0),
      0,
    ),
    external,
    localhostRequestCount,
    // Counted, not listed: inlined assets are not network traffic.
    nonNetworkSchemeCounts,
    failedRequests: failedRequests.map((f) =>
      (typeof f === 'string' ? summarizeUrl(f) : { ...f, url: summarizeUrl(f?.url ?? '') })),
    consoleErrors: consoleErrors.map((e) => summarizeUrl(String(e), 500)),
  };
}
