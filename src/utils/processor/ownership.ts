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

export interface RunToken {
    readonly generation: number;
    readonly snapshot: RunSnapshot;
    readonly key: string;
    /** False as soon as anything relevant changed, or the component went away. */
    isCurrent(): boolean;
    /** Throws `CANCELLED` unless this run is still the one that matters. */
    assertCurrent(): void;
}

/**
 * One owner per Processor instance.
 *
 * Generations are monotonic, so a token from an earlier run can never become
 * current again — which is what makes "check again before publishing" a real
 * guarantee rather than a hope about timing.
 */
export class RunOwnership {
    private generation = 0;

    private currentKey: string | null = null;

    /** Start a run and take a token for it. Any earlier token is now stale. */
    begin(snapshot: RunSnapshot): RunToken {
        this.generation += 1;
        this.currentKey = snapshotKey(snapshot);
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
                    throw new ProcessorError(
                        '設定またはファイルが変更されたため、この処理は中止しました。',
                        PLAN_STATUS.CANCELLED,
                    );
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
    matches(snapshot: RunSnapshot): boolean {
        return this.currentKey === snapshotKey(snapshot);
    }
}
