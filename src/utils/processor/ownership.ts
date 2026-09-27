/**
 * Who a run belongs to, and whether it still does.
 *
 * The measured failure this exists to stop: a batch the user navigated away
 * from still downloaded its ZIP, and a DPI changed mid-run produced a file at
 * the old setting whose row said done. Both are the same bug — work that
 * outlived the intent that started it — and neither is caught by a try/catch,
 * because nothing threw.
 *
 * So a run is owned. The owner is captured when the run starts, re-checked at
 * every boundary where control came back from an `await`, and checked once more
 * immediately before anything is published. A superseded run produces no
 * download, no archive and no success.
 *
 * Adopted: H10.
 */
import { PLAN_STATUS, ProcessorError, snapshotKey } from './contracts';
import type { RunSnapshot } from './contracts';

export interface RunToken<S = RunSnapshot> {
    readonly generation: number;
    readonly snapshot: S;
    readonly key: string;
    /** False as soon as anything relevant changed, or the component went away. */
    isCurrent(): boolean;
    /** Throws `CANCELLED` unless this run is still the one that matters. */
    assertCurrent(): void;
}

/**
 * How a superseded run is reported. One per owner, so a feature can raise its
 * own typed failure without this module knowing about it.
 */
export type CancellationFactory = () => Error;

const processorCancellation: CancellationFactory = () => new ProcessorError(
    '設定またはファイルが変更されたため、この処理は中止しました。',
    PLAN_STATUS.CANCELLED,
);

/**
 * One owner per feature instance.
 *
 * Generations are monotonic, so a token from an earlier run can never become
 * current again — which is what makes "check again before publishing" a real
 * guarantee rather than a hope about timing.
 *
 * **Generalized for M6-H13**, which adopted extending this beyond the Processor
 * rather than writing a second copy of it. The two things that were Processor-
 * specific are now injected: how a snapshot becomes a key, and which typed error
 * a superseded run raises. Both default to exactly what the Processor passed
 * implicitly before, so `new RunOwnership()` in `PdfTools.tsx` keeps its meaning
 * and its behaviour unchanged.
 */
export class RunOwnership<S = RunSnapshot> {
    private generation = 0;

    private currentKey: string | null = null;

    private readonly keyOf: (snapshot: S) => string;

    private readonly cancellation: CancellationFactory;

    constructor(
        keyOf: (snapshot: S) => string = snapshotKey as unknown as (snapshot: S) => string,
        cancellation: CancellationFactory = processorCancellation,
    ) {
        this.keyOf = keyOf;
        this.cancellation = cancellation;
    }

    /** Start a run and take a token for it. Any earlier token is now stale. */
    begin(snapshot: S): RunToken<S> {
        this.generation += 1;
        this.currentKey = this.keyOf(snapshot);
        const mine = this.generation;
        const key = this.currentKey;
        // Arrow functions capture `this` lexically, so the token stays bound to
        // the owner that issued it without aliasing.
        return {
            generation: mine,
            snapshot,
            key,
            isCurrent: () => this.generation === mine && this.currentKey === key,
            assertCurrent: () => {
                if (this.generation !== mine || this.currentKey !== key) {
                    throw this.cancellation();
                }
            },
        };
    }

    /**
     * Invalidate whatever is running: the file list changed, the tool changed,
     * a setting changed, or the component unmounted.
     */
    supersede(): void {
        this.generation += 1;
        this.currentKey = null;
    }

    /** Whether the snapshot a confirmation was given for is still the live one. */
    matches(snapshot: S): boolean {
        return this.currentKey === this.keyOf(snapshot);
    }
}
