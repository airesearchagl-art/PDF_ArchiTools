/**
 * A Processor job, as a PLAN and a RESULT, with owners — and three batch
 * policies that are what their names say.
 *
 * Production runs every operation as `await process*(file)` inside a loop in
 * the component, catches whatever is thrown into a row string, and calls
 * `saveAs` for whatever came back — so an exception is the only way to say
 * "cannot", a run nobody owns any more still downloads, and a batch with a
 * failure in it still ships a ZIP.
 *
 * Two result vocabularies, never mixed:
 *
 *   FileResult   SUCCEEDED | FAILED | CANCELLED      one file, one outcome
 *   BatchResult  SUCCEEDED | PARTIAL | FAILED | CANCELLED
 *
 * An artifact exists only for a SUCCEEDED file, and leaves only through a
 * publish that re-reads its owner last. The per-file functions are wrapped
 * unchanged: none of them yields, so a superseded file finishes computing and
 * is discarded at the next boundary — the honest contract available without
 * changing them.
 *
 * Research code. Not part of the app.
 */

export const PLAN = Object.freeze({
    READY: 'READY',
    UNSUPPORTED_DOCUMENT: 'UNSUPPORTED_DOCUMENT',
    SIGNATURE_UNSAFE: 'SIGNATURE_UNSAFE',
    XFA_UNSAFE: 'XFA_UNSAFE',
    ENCRYPTED: 'ENCRYPTED',
    UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
    STRUCTURE_LOSS_REQUIRES_CONFIRMATION: 'STRUCTURE_LOSS_REQUIRES_CONFIRMATION',
    OVER_RASTER_LIMIT: 'OVER_RASTER_LIMIT',
    OVER_MEMORY_BUDGET: 'OVER_MEMORY_BUDGET',
    OVER_OUTPUT_BUDGET: 'OVER_OUTPUT_BUDGET',
    CANCELLED: 'CANCELLED',
});

export const FILE_RESULT = Object.freeze({ SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' });
export const BATCH_RESULT = Object.freeze({
    SUCCEEDED: 'SUCCEEDED', PARTIAL: 'PARTIAL', FAILED: 'FAILED', CANCELLED: 'CANCELLED',
});

/**
 * The three policies, defined before they are implemented. The prototype
 * below follows these, and the gate checks it against them.
 */
export const BATCH_POLICIES = Object.freeze({
    B1: {
        name: 'fail whole',
        ownership: 'one batch owner',
        publication: 'one archive of every file, or nothing',
        downloadTiming: 'once, after the last file',
        cancellation: 'the whole batch',
        failurePropagation: 'the first FAILED file stops the batch; files after it are CANCELLED unrun; nothing is published',
        manifest: 'none: nothing is published when anything fails',
        earlyPublish: false,
    },
    B2: {
        name: 'explicit partial',
        ownership: 'one batch owner',
        publication: 'one archive of the SUCCEEDED files plus a manifest',
        downloadTiming: 'once, after the last file',
        cancellation: 'the whole batch',
        failurePropagation: 'none: a FAILED file is recorded and the batch continues',
        manifest: 'always, in the archive and on screen: every file, its PLAN, its FileResult, and why',
        earlyPublish: false,
    },
    B3: {
        name: 'independent jobs',
        ownership: 'one owner per file, under a batch owner that can cancel every file not yet published',
        publication: 'one artifact per SUCCEEDED file, no archive',
        downloadTiming: 'as soon as each file succeeds',
        cancellation: 'per file; cancelling the batch cancels the files not yet published',
        failurePropagation: 'none: each file stands alone',
        manifest: 'none: each file carries its own state',
        earlyPublish: true,
    },
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
    };
}

/** A real task boundary: a timer, so anything the user did has been delivered. */
export const taskBoundary = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** One file: plan, run, and a FileResult. Publishes nothing itself. */
async function runFile({ file, plan, run, isOwner, log }) {
    log('start', file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decided = await plan(bytes);
    const done = (result, extra = {}) => {
        log('finish', file.name, result);
        return { name: file.name, plan: decided.status, result, artifact: null, ...extra };
    };
    if (decided.status !== PLAN.READY) return done(FILE_RESULT.FAILED, { reason: decided.reason });
    await taskBoundary();
    if (!isOwner()) return done(FILE_RESULT.CANCELLED);
    let output;
    try {
        output = await run(file);
    } catch (error) {
        return done(FILE_RESULT.FAILED, { reason: String(error?.message ?? error) });
    }
    await taskBoundary();
    if (!isOwner()) return done(FILE_RESULT.CANCELLED);
    return done(FILE_RESULT.SUCCEEDED, { artifact: output });
}

function batchOutcome(records, batchCancelled) {
    const n = (r) => records.filter((x) => x.result === r).length;
    if (batchCancelled) return BATCH_RESULT.CANCELLED;
    if (n(FILE_RESULT.SUCCEEDED) === records.length) return BATCH_RESULT.SUCCEEDED;
    if (n(FILE_RESULT.SUCCEEDED) === 0) return BATCH_RESULT.FAILED;
    return BATCH_RESULT.PARTIAL;
}

const strip = (records) => records.map(({ artifact, ...r }) => r);

/**
 * @param {{ files: File[], plan: Function, run: Function, owner: object,
 *   publish: Function, onFileStart?: Function, log?: Function }} args
 * `publish(unit)` receives either an archive `{ kind:'archive', files, manifest }`
 * (B1/B2) or one file `{ kind:'file', name, bytes }` (B3).
 */
export async function runBatch(policy, args) {
    const events = [];
    let seq = 0;
    const log = (type, name, result) => events.push({ seq: seq++, type, name, result: result ?? null });
    const { files, plan, run, owner, publish, onFileStart } = args;
    const batch = owner.begin();
    const records = [];

    if (policy === 'B1' || policy === 'B2') {
        let failed = false;
        for (const file of files) {
            if (policy === 'B1' && failed) {
                records.push({ name: file.name, plan: null, result: FILE_RESULT.CANCELLED, reason: 'an earlier file failed', artifact: null });
                continue;
            }
            if (!batch.isOwner()) {
                records.push({ name: file.name, plan: null, result: FILE_RESULT.CANCELLED, artifact: null });
                continue;
            }
            onFileStart?.(file.name, null);
            const r = await runFile({ file, plan, run, isOwner: batch.isOwner, log });
            records.push(r);
            if (r.result === FILE_RESULT.FAILED) failed = true;
        }
        const cancelled = !batch.isOwner() || records.some((r) => r.result === FILE_RESULT.CANCELLED && r.reason !== 'an earlier file failed');
        const result = policy === 'B1' && failed ? BATCH_RESULT.FAILED : batchOutcome(records, cancelled);
        const succeeded = records.filter((r) => r.result === FILE_RESULT.SUCCEEDED);
        const manifest = policy === 'B2' ? {
            succeeded: succeeded.length,
            failed: records.filter((r) => r.result === FILE_RESULT.FAILED).length,
            files: records.map((r) => ({ name: r.name, plan: r.plan, result: r.result, reason: r.reason ?? null })),
        } : null;
        const publishable = policy === 'B1'
            ? result === BATCH_RESULT.SUCCEEDED
            : (result === BATCH_RESULT.SUCCEEDED || result === BATCH_RESULT.PARTIAL);
        // The one place anything leaves: re-read ownership last, after a boundary.
        await taskBoundary();
        let published = 0;
        if (publishable && batch.isOwner()) {
            await publish({ kind: 'archive', files: succeeded.map((r) => ({ name: r.name, bytes: r.artifact })), manifest });
            log('publish', 'archive');
            published = 1;
        }
        return { policy, result, manifest, published, records: strip(records), events };
    }

    // B3: every file its own job. Its owner is its own and the batch's.
    let published = 0;
    for (const file of files) {
        if (!batch.isOwner()) {
            records.push({ name: file.name, plan: null, result: FILE_RESULT.CANCELLED, artifact: null });
            continue;
        }
        const own = createOwner();
        const ticket = own.begin();
        onFileStart?.(file.name, own);
        const isOwner = () => ticket.isOwner() && batch.isOwner();
        const r = await runFile({ file, plan, run, isOwner, log });
        records.push(r);
        if (r.result === FILE_RESULT.SUCCEEDED) {
            await taskBoundary();
            if (isOwner()) {
                await publish({ kind: 'file', name: r.name, bytes: r.artifact });
                log('publish', r.name);
                published += 1;
                r.published = true;
            } else {
                r.result = FILE_RESULT.CANCELLED;
            }
        }
    }
    const result = batchOutcome(records, !batch.isOwner());
    return { policy, result, manifest: null, published, records: strip(records), events };
}

/**
 * Does a run behave like B3? Written against the definition, so an
 * implementation that runs everything and publishes once at the end cannot
 * pass by calling itself B3.
 */
export function conformsToB3(outcome) {
    const problems = [];
    const succeeded = outcome.records.filter((r) => r.result === FILE_RESULT.SUCCEEDED);
    const publishes = outcome.events.filter((e) => e.type === 'publish');
    if (publishes.length !== succeeded.length) problems.push(`${publishes.length} publishes for ${succeeded.length} successes`);
    if (publishes.some((p) => p.name === 'archive')) problems.push('publishes an archive');
    for (const p of publishes) {
        const finish = outcome.events.find((e) => e.type === 'finish' && e.name === p.name);
        const laterStart = outcome.events.find((e) => e.type === 'start' && e.seq > (finish?.seq ?? Infinity));
        if (laterStart && p.seq > laterStart.seq) problems.push(`${p.name} published only after ${laterStart.name} had started`);
    }
    return { conforms: problems.length === 0, problems };
}

/**
 * The shape a B3 must not be mistaken for: every file run, one aggregate
 * publish at the end. The gate feeds it to `conformsToB3` and requires a no.
 */
export async function aggregateMasqueradingAsB3(args) {
    const outcome = await runBatch('B2', args);
    return { ...outcome, policy: 'B3?' };
}
