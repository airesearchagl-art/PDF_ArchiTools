/**
 * A Processor job, as a PLAN and a RESULT, with one owner.
 *
 * Production runs every operation as `await process*(file)` inside a loop in
 * the component, catches whatever is thrown into a row string, and calls
 * `saveAs` for whatever came back — so an exception is the only way to say
 * "cannot", a run nobody owns any more still downloads, and a batch with a
 * failure in it still ships a ZIP.
 *
 * This prototype is the shape the research proposes, small enough to test:
 *
 *   PLAN    — decided before any output exists: READY, or a typed refusal.
 *   RESULT  — decided after: SUCCEEDED with an artifact, or FAILED/CANCELLED
 *             with none. An artifact exists only for SUCCEEDED.
 *   owner   — a generation token captured at the start. Every task boundary
 *             re-reads it, and the single publish re-reads it last.
 *
 * It wraps the existing per-file functions unchanged: a per-file function
 * cannot be interrupted mid-file (none of them yield), so a superseded file
 * finishes computing and its bytes are discarded at the boundary. That is the
 * honest contract available without changing them.
 *
 * Research code. Not part of the app.
 */

export const PLAN = Object.freeze({
    READY: 'READY',
    UNSUPPORTED_DOCUMENT: 'UNSUPPORTED_DOCUMENT',
    SIGNATURE_UNSAFE: 'SIGNATURE_UNSAFE',
    XFA_UNSAFE: 'XFA_UNSAFE',
    ENCRYPTED: 'ENCRYPTED',
    STRUCTURE_LOSS_REQUIRES_CONFIRMATION: 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION',
    OVER_MEMORY_BUDGET: 'OVER_MEMORY_BUDGET',
    OVER_RASTER_LIMIT: 'OVER_RASTER_LIMIT',
    CANCELLED: 'CANCELLED',
});

export const RESULT = Object.freeze({
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
});

/** A generation counter. `begin()` captures one; anything that moves it supersedes. */
export function createOwner() {
    let generation = 0;
    return {
        begin() {
            generation += 1;
            const mine = generation;
            return { isOwner: () => mine === generation };
        },
        supersede() { generation += 1; },
        get generation() { return generation; },
    };
}

/** A real task boundary: a timer, so anything the user did has been delivered. */
export const taskBoundary = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * One file: plan, run, publish — or nothing.
 * `plan(bytes)` returns { status, reason? }; `run(file)` returns bytes or throws.
 */
export async function runOne({ file, plan, run, ticket }) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decided = await plan(bytes);
    if (decided.status !== PLAN.READY) {
        return { name: file.name, plan: decided.status, result: RESULT.FAILED, reason: decided.reason, artifact: null };
    }
    await taskBoundary();
    if (!ticket.isOwner()) return { name: file.name, plan: PLAN.CANCELLED, result: RESULT.CANCELLED, artifact: null };
    let output;
    try {
        output = await run(file);
    } catch (error) {
        return { name: file.name, plan: decided.status, result: RESULT.FAILED, reason: String(error?.message ?? error), artifact: null };
    }
    await taskBoundary();
    if (!ticket.isOwner()) return { name: file.name, plan: decided.status, result: RESULT.CANCELLED, artifact: null };
    return { name: file.name, plan: decided.status, result: RESULT.SUCCEEDED, artifact: output };
}

/**
 * A batch, under one of the three policies the Human Gate has to choose from.
 *
 *   B1 fail-whole    — any failure: no artifact at all.
 *   B2 explicit-part — the successes ship, with a manifest naming every
 *                      failure and why, inside the archive and on screen.
 *   B3 independent   — no archive; each file is its own job and result.
 *
 * Whatever the policy, a superseded batch publishes nothing.
 */
export async function runBatch({ files, plan, run, owner, policy, publish }) {
    const ticket = owner.begin();
    const results = [];
    for (const file of files) {
        const r = await runOne({ file, plan, run, ticket });
        results.push(r);
        if (r.result === RESULT.CANCELLED) break;
        if (policy === 'B1' && r.result === RESULT.FAILED) break;
    }
    const succeeded = results.filter((r) => r.result === RESULT.SUCCEEDED);
    const failed = results.filter((r) => r.result === RESULT.FAILED);
    const cancelled = !ticket.isOwner() || results.some((r) => r.result === RESULT.CANCELLED);

    let outcome;
    if (cancelled) {
        outcome = { result: RESULT.CANCELLED, artifacts: [], manifest: null };
    } else if (policy === 'B1') {
        outcome = failed.length > 0
            ? { result: RESULT.FAILED, artifacts: [], manifest: null }
            : { result: RESULT.SUCCEEDED, artifacts: succeeded.map((r) => ({ name: r.name, bytes: r.artifact })), manifest: null };
    } else if (policy === 'B2') {
        outcome = {
            result: failed.length === 0 ? RESULT.SUCCEEDED : (succeeded.length === 0 ? RESULT.FAILED : 'PARTIAL'),
            artifacts: succeeded.map((r) => ({ name: r.name, bytes: r.artifact })),
            manifest: {
                succeeded: succeeded.length,
                failed: failed.length,
                failures: failed.map((r) => ({ name: r.name, plan: r.plan, reason: r.reason })),
            },
        };
    } else {
        outcome = {
            result: 'PER_FILE',
            artifacts: succeeded.map((r) => ({ name: r.name, bytes: r.artifact })),
            manifest: null,
        };
    }

    // The one place anything leaves: re-read ownership last, after a boundary.
    await taskBoundary();
    const published = ticket.isOwner() && outcome.artifacts.length > 0;
    if (published) await publish(outcome);
    return { ...outcome, results: results.map(({ artifact, ...r }) => r), published };
}
