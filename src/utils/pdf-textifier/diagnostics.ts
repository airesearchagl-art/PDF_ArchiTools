/**
 * TEMPORARY diagnostic tracing for the Preview OCR stall.
 *
 * The Textifier reaches "文字認識中" on the Vercel Preview and never returns,
 * while the identical production bundle completes locally in under a second.
 * Every component checks out in isolation on that deployment -- assets, the
 * PDF.js worker, and Tesseract itself recognising in 237 ms -- so the stall is
 * somewhere in the integration path we cannot observe from outside the bundle.
 *
 * This records timestamps for exactly three things: PDF.js page.render, OCR
 * input preparation, and the recognise call. Nothing else.
 *
 * DELETE THIS FILE once the root cause is known, along with its call sites.
 */

export interface TraceEvent {
    /** Milliseconds since the run started. */
    t: number;
    event: string;
    data?: Record<string, unknown>;
}

let startedAt = 0;
let events: TraceEvent[] = [];
let listener: ((event: TraceEvent) => void) | null = null;

declare global {
    interface Window {
        __textifierTrace?: TraceEvent[];
    }
}

export function resetTrace(onEvent?: (event: TraceEvent) => void): void {
    startedAt = performance.now();
    events = [];
    listener = onEvent ?? null;
    if (typeof window !== 'undefined') window.__textifierTrace = events;
}

export function trace(event: string, data?: Record<string, unknown>): void {
    const entry: TraceEvent = { t: Math.round(performance.now() - startedAt), event, data };
    events.push(entry);
    listener?.(entry);
}

export function getTrace(): TraceEvent[] {
    return events;
}
