/**
 * The title-block recogniser's OCR Workers, owned from the moment each is made
 * (M7-P2-B2, RV-39-02, HG-RV39-OCR-01).
 *
 * tesseract.js makes its Web Worker synchronously inside createWorker(), but
 * hands out the only way to end it -- the worker object's terminate() -- once
 * load, loadLanguage and initialize have all answered. A Worker still starting,
 * or one whose start failed or never settled, was beyond anyone's reach, so a
 * cancelled extraction let its lock go with the Worker still alive, and a
 * failed start left its Worker for good.
 *
 * Here each Worker is made with M7's own worker script
 * (public/ocr/m7/register-ocr-worker.js): it runs tesseract.js's worker script
 * unchanged and, before it, joins a BroadcastChannel named for that Worker
 * alone. From its first line the page can tell it to close itself, and it says
 * "closed" before it does. tesseract.js itself is called as it always is; only
 * the worker path, and an error handler that hears a start that failed, are
 * this recogniser's own. The other tools' OCR is not touched.
 *
 * A Worker is ended when either is known: its own terminate() completed (its
 * start had completed: Worker.terminate() ends it there and then), or it said
 * "closed" on its channel. Nothing else counts -- not a deadline, not a start
 * that failed, not a terminate() that threw, rejected or never settled, not
 * silence. One told to close that has done neither within
 * OCR_CLOSE_DEADLINE_MS, however its end was sought, leaves the registry
 * unconfirmed for good: no Worker is made again until the page is reloaded,
 * which is what ends every Worker. An end that comes later is recorded and
 * restores nothing.
 *
 * One live Worker on the page at a time: a new one is made only once every one
 * being closed is known to have ended.
 */
import { createWorker } from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';

/** M7's worker script; same origin, under the OCR assets. */
export const OCR_WORKER_PATH = '/ocr/m7/register-ocr-worker.js';

/**
 * How long a start may take before it is taken for failed. Failure detection
 * only: a start that runs out is closed like any other, and its end must
 * still be heard. With B' (`cacheMethod: 'none'`) and no HTTP cache every
 * start downloads the recogniser and both languages, about 10 MiB; the figures
 * this rests on (stage L, a slow line included) are in the PR's RV-39-02
 * section.
 */
export const OCR_START_DEADLINE_MS = 120_000;

/**
 * How long a Worker told to close may take to say so. It answers as soon as
 * its event loop is free: at once while it waits on a fetch (the language
 * data), but only after the step in hand while it is inside a synchronous one
 * -- importScripts of tesseract.js's worker script and, longest, of its 3.9 MB
 * core, which on a slow line with no HTTP cache is a download it cannot be
 * interrupted in; then initialising. Past this its end is unconfirmed, and
 * 図面管理 fails closed (no OCR until a reload), so it must outlast that step on
 * a slow but normal line; the measured figures are in the PR's RV-39-02
 * section. Independent of the PDF.js release deadline.
 */
export const OCR_CLOSE_DEADLINE_MS = 60_000;

/** Arms a deadline; returns its disarm. Production uses timers; tests fire them by hand. */
export type OcrDeadline = (ms: number, expire: () => void) => () => void;

/**
 * Calls a started Worker's own terminate() (`end`) and gives back what it gave. Production calls it as it is;
 * tests make it reject, throw, never settle, or settle late. Only its completing counts as the Worker's end.
 */
export type OcrTerminate = (end: () => Promise<unknown>) => Promise<unknown>;

export type OcrWorkerFactory = typeof createWorker;

export type OcrWorkerState = 'starting' | 'started' | 'closing' | 'ended' | 'unconfirmed';

/** What is known about one Worker, for the screen's counts and the tests. */
export interface OcrWorkerRecord {
    readonly n: number;
    readonly channel: string;
    state: OcrWorkerState;
    /** It said so on its channel. */
    alive: boolean;
    /** Why its start did not complete; null while starting or once started. */
    startFailure: 'REJECTED' | 'DEADLINE' | null;
    /** How its end is known; null until it is. */
    ended: 'TERMINATED' | 'CLOSED' | null;
    /** Its own terminate() was asked and did not complete: it threw, or rejected. Not an end; the channel or the deadline decides. */
    terminateFailure: 'THREW' | 'REJECTED' | null;
    /** From being made to started, when it did. */
    startMs: number | null;
    /** How the caller's start was answered: it always is, so nothing waits on a Worker that is gone. */
    startAnswered: 'STARTED' | 'FAILED' | 'CLOSED' | null;
    /** Given up as unconfirmed, and heard from or ended afterwards. Restores nothing. */
    lateEnd: 'TERMINATED' | 'CLOSED' | null;
}

export interface OcrWorkerCounts {
    made: number;
    started: number;
    startFailed: number;
    terminated: number;
    closed: number;
    terminateFailed: number;
    unconfirmed: number;
    refused: number;
    deadlinesArmed: number;
    deadlinesExpired: number;
    slowestStartMs: number;
    live: number;
    releaseUnconfirmed: boolean;
}

export class OcrUnavailableError extends Error {
    readonly reason: 'UNCONFIRMED' | 'CLOSED' | 'UNSUPPORTED';

    constructor(reason: 'UNCONFIRMED' | 'CLOSED' | 'UNSUPPORTED') {
        super(`OCR unavailable: ${reason}`);
        this.name = 'OcrUnavailableError';
        this.reason = reason;
    }
}

const timerDeadline: OcrDeadline = (ms, expire) => {
    const timer = setTimeout(expire, ms);
    return () => clearTimeout(timer);
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type Langs = Parameters<OcrWorkerFactory>[0];
type Oem = Parameters<OcrWorkerFactory>[1];
type Options = Parameters<OcrWorkerFactory>[2];
type Config = Parameters<OcrWorkerFactory>[3];

class OwnedWorker {
    readonly record: OcrWorkerRecord;
    /** Settles once the Worker is known ended, or given up as unconfirmed. */
    readonly settled: Promise<void>;
    private markSettled!: () => void;
    private readonly registry: OcrWorkerRegistry;
    private channel: BroadcastChannel | null = null;
    private terminateHandle: (() => Promise<unknown>) | null = null;
    private closing: Promise<void> | null = null;
    private disarmStart: (() => void) | null = null;
    private disarmClose: (() => void) | null = null;
    private heardEnd: (() => void) | null = null;
    private abandonStart: (() => void) | null = null;
    private terminateAsked = false;
    private readonly madeAt = now();

    constructor(registry: OcrWorkerRegistry, n: number) {
        this.registry = registry;
        this.record = {
            n, channel: `m7-ocr-${globalThis.crypto.randomUUID()}`, state: 'starting', alive: false,
            startFailure: null, ended: null, terminateFailure: null, startMs: null, startAnswered: null, lateEnd: null,
        };
        this.settled = new Promise((resolve) => { this.markSettled = resolve; });
    }

    /** Make the Worker through tesseract.js. Resolves with it once started; rejects if its start fails, or it is closed first. */
    start(langs: Langs, oem: Oem, options: Options, config: Config): Promise<TesseractWorker> {
        let channel: BroadcastChannel;
        try {
            channel = new BroadcastChannel(this.record.channel);
        } catch {
            // No Worker has been made: nothing to end.
            this.registry.discard(this);
            this.record.startAnswered = 'FAILED';
            return Promise.reject(new OcrUnavailableError('UNSUPPORTED'));
        }
        this.channel = channel;
        channel.onmessage = (event: MessageEvent) => this.heard(event.data);
        return new Promise((resolve, reject) => {
            let answered = false;
            const answer = (how: 'FAILED' | 'CLOSED', message: string): void => {
                if (answered) return;
                answered = true;
                this.disarmStart?.();
                this.record.startAnswered = how;
                reject(new Error(message));
            };
            const fail = (why: 'REJECTED' | 'DEADLINE'): void => {
                if (answered) return;
                if (this.record.state === 'starting') this.record.startFailure = why;
                answer('FAILED', why === 'DEADLINE' ? 'OCR worker did not start in time' : 'OCR worker could not start');
                void this.close();
            };
            // Told to close while it starts: the caller is answered at once -- the Worker it waited for will not be.
            this.abandonStart = () => answer('CLOSED', 'OCR worker closed');
            this.disarmStart = this.registry.arm(OCR_START_DEADLINE_MS, () => fail('DEADLINE'));
            const made = createWorker(langs, oem, {
                ...options,
                // The channel goes in the fragment, which is never sent: the worker script stays one cacheable file.
                // Never a blob URL: a Worker started from one has no fragment, so it could not join its channel.
                workerPath: `${OCR_WORKER_PATH}#channel=${encodeURIComponent(this.record.channel)}`,
                workerBlobURL: false,
                // Heard for any answer that is a refusal. Before the start completes that is the start failing --
                // tesseract.js settles its createWorker() only for `load` -- and afterwards the job's own promise says it.
                errorHandler: () => fail('REJECTED'),
            }, config);
            made.then((worker) => {
                this.adopt(worker);
                if (answered || this.record.state !== 'starting') {
                    // Started after all, but no longer wanted: its own terminate() ends it now.
                    answer('CLOSED', 'OCR worker closed');
                    void this.endWithHandle();
                    return;
                }
                answered = true;
                this.disarmStart?.();
                this.record.state = 'started';
                this.record.startAnswered = 'STARTED';
                this.record.startMs = Math.round(now() - this.madeAt);
                this.registry.noteStarted(this.record.startMs);
                resolve(worker);
            }, () => fail('REJECTED'));
        });
    }

    /** Keep the worker object's own terminate(), and route the caller's through close(). */
    private adopt(worker: TesseractWorker): void {
        if (this.terminateHandle) return;
        const own = worker.terminate.bind(worker);
        this.terminateHandle = () => own();
        (worker as unknown as { terminate: () => Promise<void> }).terminate = () => this.close();
    }

    /** End the Worker. Resolves once it is known ended, or given up as unconfirmed. Never rejects. */
    close(): Promise<void> {
        if (!this.closing) this.closing = this.closeNow();
        return this.closing;
    }

    private async closeNow(): Promise<void> {
        if (this.record.state === 'ended' || this.record.state === 'unconfirmed') return;
        this.record.state = 'closing';
        this.abandonStart?.();
        this.registry.changed();
        // One deadline, however the end is sought: past it the end is unconfirmed, and nothing here waits longer.
        await new Promise<void>((resolve) => {
            this.heardEnd = resolve;
            try {
                this.disarmClose = this.registry.arm(OCR_CLOSE_DEADLINE_MS, () => {
                    this.unconfirm();
                    resolve();
                });
                // Asked on its channel whichever way it is ended -- its "closed" is an end too -- and asked again
                // when it says it is alive, should this reach it before it has joined the channel.
                this.ask();
                if (this.terminateHandle) void this.endWithHandle();
            } catch {
                // Whatever went wrong, its end is not known. Its own terminate() is still tried: an end it brings is recorded, late.
                this.unconfirm();
                resolve();
                if (this.terminateHandle) void this.endWithHandle();
            }
        });
    }

    /**
     * The worker object's own terminate(): Worker.terminate(), which ends it there and then. Only its completing
     * counts as the end. One that throws or rejects is not an end: the Worker is still asked on its channel, and
     * its "closed", or the close deadline, decides. One that never settles is the deadline's.
     */
    private async endWithHandle(): Promise<void> {
        const own = this.terminateHandle;
        if (!own || this.terminateAsked) return;
        this.terminateAsked = true;
        let ending: Promise<unknown>;
        try {
            ending = this.registry.callTerminate(own);
        } catch {
            this.terminateFailed('THREW');
            return;
        }
        try {
            await ending;
        } catch {
            this.terminateFailed('REJECTED');
            return;
        }
        this.finish('TERMINATED');
    }

    /** Tell the Worker on its channel to close. Never throws: a channel already closed has no one to tell. */
    private ask(): void {
        try {
            this.channel?.postMessage({ type: 'close' });
        } catch {
            // Closed with its Worker's end, or given up on: nothing to ask.
        }
    }

    private terminateFailed(how: 'THREW' | 'REJECTED'): void {
        if (!this.record.terminateFailure) this.record.terminateFailure = how;
        this.registry.noteTerminateFailed();
        if (this.record.state === 'closing' || this.record.state === 'unconfirmed') this.ask();
    }

    private heard(data: unknown): void {
        const type = (data as { type?: unknown } | null)?.type;
        if (type === 'alive') {
            this.record.alive = true;
            // Told to close before it had joined (or given up on since): ask it now. Restores nothing if it answers.
            if (this.record.state === 'closing' || this.record.state === 'unconfirmed') this.ask();
            this.registry.changed();
        } else if (type === 'closed') {
            this.finish('CLOSED');
        }
    }

    private finish(how: 'TERMINATED' | 'CLOSED'): void {
        if (this.record.state === 'ended') return;
        this.disarmStart?.();
        this.disarmClose?.();
        if (this.record.state === 'unconfirmed') {
            // Too late to count: the page stays unconfirmed until it is reloaded.
            if (!this.record.lateEnd) this.record.lateEnd = how;
            this.channel?.close();
            this.registry.changed();
            return;
        }
        this.record.state = 'ended';
        this.record.ended = how;
        this.channel?.close();
        this.heardEnd?.();
        this.registry.noteEnded(this);
        this.markSettled();
    }

    private unconfirm(): void {
        if (this.record.state !== 'closing') return;
        this.record.state = 'unconfirmed';
        this.registry.noteUnconfirmed(this);
        this.markSettled();
    }
}

/** The Workers one recogniser made: what it closes when it is done. */
export class OcrRecogniserWorkers {
    private done = false;
    private readonly mine = new Set<OwnedWorker>();
    private readonly registry: OcrWorkerRegistry;

    constructor(registry: OcrWorkerRegistry) {
        this.registry = registry;
    }

    /** tesseract.js's createWorker, for this recogniser: the Worker is owned from the moment it is made. */
    readonly makeWorker: OcrWorkerFactory = async (langs, oem, options, config) => {
        if (this.done) throw new OcrUnavailableError('CLOSED');
        const worker = await this.registry.make();
        if (this.done) {
            this.registry.discard(worker);
            throw new OcrUnavailableError('CLOSED');
        }
        this.mine.add(worker);
        return worker.start(langs, oem, options, config);
    };

    /** Make no further Worker, and end every one made. Resolves once each is known ended or unconfirmed. Never rejects. */
    async closeAll(): Promise<void> {
        this.done = true;
        const ends = await Promise.allSettled([...this.mine].map((worker) => worker.close()));
        // close() does not reject; should one ever, that Worker's end is not known, and the page's OCR fails closed.
        if (ends.some((end) => end.status === 'rejected')) this.registry.failClosed();
    }

    counts(): { made: number; ended: number; unconfirmed: number; live: number } {
        const records = [...this.mine].map((w) => w.record);
        return {
            made: records.length,
            ended: records.filter((r) => r.state === 'ended').length,
            unconfirmed: records.filter((r) => r.state === 'unconfirmed').length,
            live: records.filter((r) => r.state !== 'ended' && r.state !== 'unconfirmed').length,
        };
    }
}

/** The page's OCR Workers for 図面管理. One per page (page-documents.ts); tests make their own. */
export class OcrWorkerRegistry {
    private unconfirmed = false;
    private counter = 0;
    private readonly owned = new Set<OwnedWorker>();
    private readonly all: OwnedWorker[] = [];
    private readonly listeners = new Set<() => void>();
    private readonly deadline: OcrDeadline;
    private readonly terminate: OcrTerminate | null;
    private readonly tally = { made: 0, started: 0, startFailed: 0, terminated: 0, closed: 0, terminateFailed: 0, unconfirmed: 0, refused: 0, deadlinesArmed: 0, deadlinesExpired: 0, slowestStartMs: 0 };

    /** Both seams are for tests; the page's registry is made with neither. */
    constructor(options: { deadline?: OcrDeadline; terminate?: OcrTerminate } = {}) {
        this.deadline = options.deadline ?? timerDeadline;
        this.terminate = options.terminate ?? null;
    }

    /** True once a Worker's end could not be confirmed. Stays true: only a reload ends what may be left. */
    get releaseUnconfirmed(): boolean {
        return this.unconfirmed;
    }

    /** Workers not known to have ended: starting, started or closing, and any given up as unconfirmed. */
    get live(): number {
        return this.all.filter((w) => w.record.state !== 'ended').length;
    }

    recogniser(): OcrRecogniserWorkers {
        return new OcrRecogniserWorkers(this);
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    counts(): OcrWorkerCounts {
        return { ...this.tally, live: this.live, releaseUnconfirmed: this.unconfirmed };
    }

    records(): OcrWorkerRecord[] {
        return this.all.map((w) => ({ ...w.record }));
    }

    /** A holder for a new Worker, once every Worker being closed is known ended. Refused once any could not be. */
    async make(): Promise<OwnedWorker> {
        for (; ;) {
            if (this.unconfirmed) {
                this.tally.refused += 1;
                throw new OcrUnavailableError('UNCONFIRMED');
            }
            const closing = [...this.owned].filter((w) => w.record.state === 'closing');
            if (closing.length === 0) break;
            await Promise.all(closing.map((w) => w.settled));
        }
        if (typeof BroadcastChannel !== 'function' || typeof globalThis.crypto?.randomUUID !== 'function') {
            this.tally.refused += 1;
            throw new OcrUnavailableError('UNSUPPORTED');
        }
        const worker = new OwnedWorker(this, ++this.counter);
        this.owned.add(worker);
        this.all.push(worker);
        if (this.all.length > 64) this.all.splice(0, this.all.length - 64);
        this.tally.made += 1;
        this.changed();
        return worker;
    }

    /** A holder whose Worker was never made (its recogniser closed while it waited its turn). */
    discard(worker: OwnedWorker): void {
        worker.record.state = 'ended';
        this.owned.delete(worker);
        this.changed();
    }

    arm(ms: number, expire: () => void): () => void {
        this.tally.deadlinesArmed += 1;
        let armed = true;
        const disarm = this.deadline(ms, () => {
            if (!armed) return;
            armed = false;
            this.tally.deadlinesExpired += 1;
            expire();
        });
        return () => {
            armed = false;
            disarm();
        };
    }

    /** A started Worker's own terminate(), called as production calls it unless a test says otherwise. May throw. */
    callTerminate(end: () => Promise<unknown>): Promise<unknown> {
        return this.terminate ? this.terminate(end) : end();
    }

    /** A Worker's end cannot be known in any other way: no Worker again until a reload. */
    failClosed(): void {
        if (!this.unconfirmed) this.tally.unconfirmed += 1;
        this.unconfirmed = true;
        this.changed();
    }

    noteTerminateFailed(): void {
        this.tally.terminateFailed += 1;
        this.changed();
    }

    noteStarted(ms: number): void {
        this.tally.started += 1;
        this.tally.slowestStartMs = Math.max(this.tally.slowestStartMs, ms);
        this.changed();
    }

    noteEnded(worker: OwnedWorker): void {
        if (worker.record.startFailure) this.tally.startFailed += 1;
        if (worker.record.ended === 'TERMINATED') this.tally.terminated += 1;
        else this.tally.closed += 1;
        this.owned.delete(worker);
        this.changed();
    }

    noteUnconfirmed(worker: OwnedWorker): void {
        if (worker.record.startFailure) this.tally.startFailed += 1;
        this.tally.unconfirmed += 1;
        this.unconfirmed = true;
        this.owned.delete(worker);
        this.changed();
    }

    changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                // A listener's failure is its own: the Workers' ends, deadlines and the lock do not wait on it.
            }
        }
    }
}

/**
 * The page's own, made once when the app loads -- like the PDF.js gate
 * (page-documents.ts): leaving 図面管理 or starting a new Drawing Set does not
 * forget a Worker whose end could not be confirmed. No test seam here.
 */
export const PAGE_OCR_WORKERS = new OcrWorkerRegistry();
