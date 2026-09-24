/**
 * What a walk over a graph of actions has already read, so it is not read again.
 * Round 12B.
 *
 * Both readers of an action's structure — the JavaScript scan in `javascript.ts`
 * and the page-reference walk in `destinations.ts` — follow `/Next` from one
 * action to the next, and a `/Next` may be a list. They used to follow it **path
 * by path**. A list that names the same action twice makes two paths, the action
 * after it makes four, and the one after that eight: a document with a few dozen
 * objects can hold more paths than there are seconds in the age of the universe
 * while holding only a few dozen actions. The result of reading an action does
 * not depend on which path reached it, so a path is the wrong unit of work. An
 * action is.
 *
 * This holds the two facts a walk needs, and nothing that is about *what* an
 * action means — the readers keep their own predicates and their own meaning of
 * "unreadable". It knows tags, and depths.
 *
 * **Active: the actions being read now.** An indirect action or list that is
 * reached while it is still being read is a cycle. That test comes first, before
 * anything is skipped for having been read: a graph with a cycle in it must not
 * turn into a graph without one because its nodes had been visited. Cycles are
 * refused exactly as they were.
 *
 * **Read: how deep each finished action was read.** Reading an action reads
 * everything that follows it, and what follows is refused when it is more than
 * `MECHANISM_BOUNDS.maxActionDepth` hops below the start. So the same action read
 * at two depths is read twice under two different limits, and it is the
 * **deeper** reading that can find something the shallower one did not — a chain
 * that fits under the bound from depth 3 and does not from depth 30.
 *
 * That is why the state kept is the greatest depth an action has been read at,
 * and an arrival is skipped only when it is no deeper than that. An arrival that
 * is deeper is read again, under its own, tighter limit. Keeping the *shallowest*
 * reading instead — the intuition that a shallower path has "more budget" — is
 * wrong for a bound that **refuses**: it would skip the deeper arrival. If one
 * route reaches an action at depth 3 and another at depth 30, and 27 hops follow
 * it, the first fits (30) and the second does not (57); read shallowest-first, the
 * document is accepted, and read deepest-first it is refused — the verdict would
 * depend on which path the walk happened to try first. What a shallower arrival
 * reads is contained in what a deeper one reads, and sites, positions and pages
 * are found by the first reading whatever the depth.
 *
 * An action is read at most once per distinct depth, and depths run from 0 to the
 * bound, so no action is read more than `maxActionDepth + 1` times however many
 * paths reach it. The work is bounded by the number of actions and `/Next`
 * entries, not by the number of paths.
 *
 * Identity is the object's reference. Two indirect actions with identical bytes
 * are two actions. A direct dictionary has no identity of its own and is read
 * whenever whatever holds it is read; a document that holds exponentially many
 * distinct direct dictionaries is exponentially large, which is a different
 * bound.
 */

/** Which reader a traversal belongs to, so a test can count each one's work. */
export type ActionTraversalChannel = 'javascript' | 'destinations';

/**
 * How much reading the walks have done, for a test to measure the shape of the
 * work rather than the clock: `expanded` is the number of times an action or list
 * was read, `suppressed` the number of arrivals that were not, because it had
 * already been read that deep. Not part of the module's public surface — the
 * index does not export it.
 */
export const actionTraversalCounts: Record<ActionTraversalChannel, { expanded: number; suppressed: number }> = {
    javascript: { expanded: 0, suppressed: 0 },
    destinations: { expanded: 0, suppressed: 0 },
};

export const resetActionTraversalCounts = (): void => {
    for (const channel of Object.values(actionTraversalCounts)) {
        channel.expanded = 0;
        channel.suppressed = 0;
    }
};

export class ActionTraversal {
    /** The actions and lists being read right now, on the current path. */
    private readonly active = new Set<string>();
    /** The greatest depth each finished action or list was read at. */
    private readonly read = new Map<string, number>();
    /** Objects whose own findings have been taken already. */
    private readonly taken = new Set<object>();
    private readonly channel: ActionTraversalChannel;

    constructor(channel: ActionTraversalChannel) {
        this.channel = channel;
    }

    /** Whether reaching `tag` now would be reaching it again while it is being read. */
    isActive(tag: string): boolean {
        return this.active.has(tag);
    }

    /**
     * Start reading `tag`, reached at `depth`. False means it has already been read
     * at least this deep and there is nothing more to learn; true means read it, and
     * call {@link end} when done.
     *
     * The caller has asked {@link isActive} first and refused a cycle. Being handed
     * an active tag here is a bug in the caller, and is an error rather than a skip:
     * a cycle must never look like something already read.
     */
    begin(tag: string, depth: number): boolean {
        if (this.active.has(tag)) {
            throw new Error(`action ${tag} was entered again while it was being read`);
        }
        const readAt = this.read.get(tag);
        if (readAt !== undefined && readAt >= depth) {
            actionTraversalCounts[this.channel].suppressed += 1;
            return false;
        }
        this.active.add(tag);
        actionTraversalCounts[this.channel].expanded += 1;
        return true;
    }

    /**
     * Stop reading `tag`. Only a reading that finished is remembered: one that was
     * refused part of the way down did not read what was below it, and is not a
     * reason to skip the next arrival.
     */
    end(tag: string, depth: number, finished: boolean): void {
        this.active.delete(tag);
        if (!finished) return;
        const readAt = this.read.get(tag);
        if (readAt === undefined || depth > readAt) this.read.set(tag, depth);
    }

    /** True the first time it is asked about `object`, false after: take a finding once. */
    firstTime(object: object): boolean {
        if (this.taken.has(object)) return false;
        this.taken.add(object);
        return true;
    }
}
