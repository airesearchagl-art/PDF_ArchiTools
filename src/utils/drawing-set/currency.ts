/**
 * Whether what was read, and what a person confirmed, still stands.
 *
 * Nothing in the model says "stale" (semantic contract §I). Every observation
 * and confirmation names the basis it was made under -- the Source's bytes and
 * the profile revision -- and is stale when that basis no longer equals what
 * is there now. This module derives that, as a pure function, every time it
 * is asked; the answer is never stored.
 *
 * Two different things can make a record untrustworthy, and they are kept
 * apart:
 *  - STALE: the model itself has moved. The Source's recorded fingerprint is
 *    not the one the record was made against (STALE_SOURCE), or the Sheet is
 *    no longer on that profile, or the profile's revision moved (STALE_PROFILE).
 *    A confirmation typed with no profile is untouched by profile changes.
 *  - UNVERIFIED: the model has not moved, but this session cannot vouch for
 *    the bytes -- the File behind the Source has gone missing or no longer
 *    holds the fingerprinted bytes. A missing file makes nothing stale.
 *    Vouching is runtime and can be regained (RuntimeBindingLedger below);
 *    staleness is the model's and no check of a File undoes it.
 *
 * M7-P2 cannot record new bytes for a Source (that is M7-P4's rebinding), so
 * in the app STALE_SOURCE only arises from a state built for a test; the rule
 * is still the contract's and is derived the same way.
 */
import type { FileDigest } from './file-evidence';
import { evidenceTick, readFileDigest, spendFileDigest } from './file-evidence';
import { IntakeStop } from './intake-policy';
import type { DrawingSet, ProfileBasis, Sha256Hex, Sheet, Source, Uuid } from './model';
import { isLive } from './model';

/** What this session knows about the File behind a Source. Runtime only; never stored. */
export type SourceBinding = 'MATCHED' | 'CHANGED' | 'MISSING';
/**
 * The bindings of a session's live Sources, for display. A snapshot: nothing
 * that decides anything takes one (currency and confirmation ask the ledger
 * itself, when they are asked), so a Map made by hand vouches for nothing.
 */
export type RuntimeBindings = ReadonlyMap<Uuid, SourceBinding>;

/** Why a check took no digest of a File. */
export type NotReadReason =
    /** No File was held for the Source. */
    | 'NO_FILE'
    /** The File's size is not the fingerprint's; nothing of it was read. */
    | 'SIZE_DIFFERS'
    /** The File changed while it was being read. */
    | 'CHANGED_WHILE_READ'
    /** The File could not be read. */
    | 'UNREADABLE';

/**
 * What one check of one Source's File found: the digest of a read of it
 * (file-evidence.ts), or why there is none. The verdict is the ledger's to
 * draw, not the checker's to state: a digest is MATCHED only if what it
 * attests equals the Source's fingerprint; it is CHANGED otherwise. A check
 * that read nothing can only lower what is known: NO_FILE and UNREADABLE are
 * MISSING, SIZE_DIFFERS and CHANGED_WHILE_READ are CHANGED.
 */
export type SourceFileCheck =
    | { kind: 'READ'; digest: FileDigest }
    | { kind: 'NOT_READ'; file: Blob | null; reason: NotReadReason };

const NOT_READ_BINDING: Record<NotReadReason, 'CHANGED' | 'MISSING'> = {
    NO_FILE: 'MISSING',
    UNREADABLE: 'MISSING',
    SIZE_DIFFERS: 'CHANGED',
    CHANGED_WHILE_READ: 'CHANGED',
};

/** Why a check's result about one Source was not taken. */
export type BindingRefusal =
    /** The check, the Drawing Set it was settled against, or the read behind it, belongs to another session. */
    | 'SESSION_REPLACED'
    /** The Source is retired, or not in the Drawing Set. */
    | 'SOURCE_NOT_LIVE'
    /** The result is about a File this check did not hand out for that Source. */
    | 'NOT_HANDED_OUT'
    /** The result is not evidence: a digest this session's reads did not issue, or a claim that contradicts the File. */
    | 'NOT_VERIFIED'
    /** Another File was presented for the Source (or it was withdrawn) after this check took its own. */
    | 'FILE_REPLACED'
    /** A later check of the same File has already been taken. */
    | 'SUPERSEDED'
    /** The check was handed its File against a fingerprint that is not the Source's now. */
    | 'FINGERPRINT_DIFFERS'
    /** The digest was offered before: one read vouches once. */
    | 'EVIDENCE_SPENT'
    /** The read began before the File was handed out to this check. */
    | 'EVIDENCE_OUTDATED';
export type BindingSettlement = 'APPLIED' | BindingRefusal;

/** Hands a checker the File held for a Source, and notes which one it was and when. */
export interface BindingCheck {
    fileFor(sourceId: Uuid): Blob | null;
}

/** The latest result taken for one presentation of a File. */
type Finding =
    | { kind: 'READ'; sha256: Sha256Hex; byteLength: number; against: Sha256Hex; checkedAt: number }
    | { kind: 'NOT_READ'; binding: 'CHANGED' | 'MISSING'; against: Sha256Hex; checkedAt: number };

interface Held {
    file: Blob | null;
    /** evidenceTick() of this presentation; 0: none yet. */
    presentedAt: number;
    finding: Finding | null;
}

interface HandedOut {
    file: Blob | null;
    presentedAt: number;
    /** evidenceTick() of the hand-out. */
    order: number;
    /** The Source's fingerprint in the set the check was begun against. */
    expected: { sha256: Sha256Hex; byteLength: number } | null;
}

interface LedgerState {
    sessionId: Uuid;
    held: Map<Uuid, Held>;
    checks: WeakMap<BindingCheck, Map<Uuid, HandedOut> | null>;
}

/**
 * Each ledger's state, reachable only from this module. A ledger is genuine
 * when it is in here: one made with Object.create, or any other object shaped
 * like a ledger, is not, and vouches for nothing.
 */
const states = new WeakMap<object, LedgerState>();

function stateOf(ledger: unknown): LedgerState | null {
    return ledger !== null && typeof ledger === 'object' ? states.get(ledger) ?? null : null;
}

function requireState(ledger: RuntimeBindingLedger): LedgerState {
    const state = stateOf(ledger);
    if (!state) throw new TypeError('not a RuntimeBindingLedger');
    return state;
}

const liveSource = (set: DrawingSet, sourceId: Uuid): Source | null => {
    const source = set.sources.find((s) => s.id === sourceId);
    return source && isLive(source) ? source : null;
};

/** What a finding says about a Source as it is now; UNBOUND when it says nothing about these bytes. */
function bindingFrom(finding: Finding | null, source: Source): SourceBinding | 'UNBOUND' {
    if (!finding) return 'UNBOUND';
    if (finding.kind === 'NOT_READ' && finding.binding === 'MISSING') return 'MISSING';
    if (finding.against !== source.fingerprint.sha256) return 'UNBOUND';
    if (finding.kind === 'NOT_READ') return finding.binding;
    return finding.sha256 === source.fingerprint.sha256 && finding.byteLength === source.fingerprint.byteLength ? 'MATCHED' : 'CHANGED';
}

/**
 * The runtime bindings of one session (semantic contract §B): the File held
 * for each Source and what the latest check of it found. Never stored.
 *
 *  - A binding comes only from a check of the File, and MATCHED only from
 *    SHA-256 equality, shown by a digest of a read of that very File
 *    (file-evidence.ts). Presenting a File binds nothing by itself: until a
 *    check of it is taken the Source stays UNBOUND, whatever its name or
 *    size, and nothing found about an earlier File carries over to it.
 *  - A verdict is never taken on anyone's word. A check reports what it read
 *    -- a digest -- or why it read nothing, and the ledger draws the verdict
 *    from what the digest's registry recorded, against the Source's
 *    fingerprint. A digest is about the one File object it was read from, for
 *    one session, from one moment; it is taken once.
 *  - Nothing sticks. Each check taken replaces what the one before found, so
 *    the same Source -- not a new one -- goes from MISSING or CHANGED back to
 *    MATCHED once a File holding its bytes is checked again, and from
 *    MATCHED to CHANGED or MISSING when the File held stops holding them.
 *  - A result is taken only while it is still about what is held: this
 *    session's check, a live Source, the very File handed out for it and not
 *    since replaced, no later check of that File already taken, handed out
 *    against the Source's fingerprint now, and a read that began after the
 *    hand-out. Any other result is refused, never merged, so a report that
 *    arrives late cannot undo a newer one.
 *  - Each Source stands alone: nothing done for one touches another.
 *
 * Intake reads every byte of a File to fingerprint it, so it does not read
 * them again: presentVerified() presents the File intake read together with
 * the digest of that read, and binds it only when the digest equals the
 * Source's fingerprint.
 *
 * It never accepts changed bytes as a Source's content and never chooses
 * between candidate files: that is rebinding (M7-P4).
 *
 * What decides -- currency and confirmation -- asks the ledger itself, through
 * verifiedBinding(), at the moment it decides. bindings() is a snapshot for
 * display and decides nothing.
 */
export class RuntimeBindingLedger {
    /** Makes the type nominal: an object of the same shape is not a ledger, for the compiler either. */
    readonly #sessionId: Uuid;

    constructor(sessionId: Uuid) {
        this.#sessionId = sessionId;
        states.set(this, { sessionId, held: new Map(), checks: new WeakMap() });
    }

    /** The Drawing Set this session holds; a check or a set of any other is refused. */
    get sessionId(): Uuid {
        return this.#sessionId;
    }

    /**
     * A person presents a File for a Source, or withdraws it (null). The Source
     * is UNBOUND until a check of this File is taken.
     */
    present(set: DrawingSet, sourceId: Uuid, file: Blob | null): BindingSettlement {
        const state = requireState(this);
        if (set.id !== state.sessionId) return 'SESSION_REPLACED';
        if (!liveSource(set, sourceId)) return 'SOURCE_NOT_LIVE';
        state.held.set(sourceId, { file, presentedAt: evidenceTick(), finding: null });
        return 'APPLIED';
    }

    /**
     * Present the File a read found, with the digest of that read: what intake
     * does once it has fingerprinted a File and found it is a Source's bytes.
     * Bound MATCHED only when the digest equals the Source's fingerprint;
     * otherwise refused, and nothing is presented -- changed bytes never
     * become a Source's File this way.
     */
    presentVerified(set: DrawingSet, sourceId: Uuid, digest: FileDigest): BindingSettlement {
        const state = requireState(this);
        const spent = spendFileDigest(digest);
        if (set.id !== state.sessionId) return 'SESSION_REPLACED';
        const source = liveSource(set, sourceId);
        if (!source) return 'SOURCE_NOT_LIVE';
        if (!spent) return 'NOT_VERIFIED';
        const { record, alreadySpent } = spent;
        if (record.scope !== state.sessionId) return 'SESSION_REPLACED';
        const held = state.held.get(sourceId);
        if (held && held.presentedAt >= record.readStartedAt) return 'FILE_REPLACED';
        if (record.sha256 !== source.fingerprint.sha256 || record.byteLength !== source.fingerprint.byteLength) return 'FINGERPRINT_DIFFERS';
        if (alreadySpent) return 'EVIDENCE_SPENT';
        const at = evidenceTick();
        state.held.set(sourceId, {
            file: record.file,
            presentedAt: at,
            finding: { kind: 'READ', sha256: record.sha256, byteLength: record.byteLength, against: source.fingerprint.sha256, checkedAt: at },
        });
        return 'APPLIED';
    }

    /** The File held for a Source, without checking anything. */
    heldFile(sourceId: Uuid): Blob | null {
        return requireState(this).held.get(sourceId)?.file ?? null;
    }

    /**
     * Which presentation of a File, and which check of it, this ledger holds
     * for a Source now (M7-P2-B2): two numbers, frozen, in a new object each
     * call -- never the File, the finding or anything that leads back into the
     * ledger. Every presentation, by any caller, gets a new `presentedAt`, and
     * every result the ledger takes gets a new `checkedAt`, so evidence that
     * remembers a stamp can tell that either has moved since. Null when
     * nothing is held. Changes nothing.
     */
    presentationStamp(sourceId: Uuid): Readonly<{ presentedAt: number; checkedAt: number | null }> | null {
        const held = requireState(this).held.get(sourceId);
        if (!held) return null;
        return Object.freeze({ presentedAt: held.presentedAt, checkedAt: held.finding?.checkedAt ?? null });
    }

    /**
     * Begin one check against the Drawing Set as it is now; its `fileFor` is
     * what the checker reads Files through. A check begun against another
     * session's set hands out nothing.
     */
    beginCheck(set: DrawingSet): BindingCheck {
        const state = requireState(this);
        const handedOut = set.id === state.sessionId ? new Map<Uuid, HandedOut>() : null;
        const check: BindingCheck = Object.freeze({
            fileFor: (sourceId: Uuid): Blob | null => {
                if (!handedOut) return null;
                const held = state.held.get(sourceId);
                const source = liveSource(set, sourceId);
                const file = held?.file ?? null;
                handedOut.set(sourceId, {
                    file,
                    presentedAt: held?.presentedAt ?? 0,
                    order: evidenceTick(),
                    expected: source ? { sha256: source.fingerprint.sha256, byteLength: source.fingerprint.byteLength } : null,
                });
                return file;
            },
        });
        state.checks.set(check, handedOut);
        return check;
    }

    /** Take what a check found, Source by Source; each result is taken or refused on its own. */
    settle(set: DrawingSet, check: BindingCheck, results: ReadonlyMap<Uuid, SourceFileCheck>): Map<Uuid, BindingSettlement> {
        const state = requireState(this);
        const handedOut = state.checks.get(check) ?? null;
        const settled = new Map<Uuid, BindingSettlement>();
        for (const [sourceId, result] of results) settled.set(sourceId, take(state, set, handedOut, sourceId, result));
        return settled;
    }

    /** Let go of the Files held for Sources that are no longer live. */
    releaseRetired(set: DrawingSet): void {
        const state = requireState(this);
        if (set.id !== state.sessionId) return;
        for (const sourceId of [...state.held.keys()]) {
            if (!liveSource(set, sourceId)) state.held.delete(sourceId);
        }
    }

    /**
     * What this session knows now about the live Sources of the set, for
     * display. A Source with no check taken is absent (UNBOUND), and so is
     * one whose MATCHED or CHANGED was found against a fingerprint it no
     * longer has: that check says nothing about the bytes it is to hold now.
     */
    bindings(set: DrawingSet): RuntimeBindings {
        const state = requireState(this);
        const bindings = new Map<Uuid, SourceBinding>();
        if (set.id !== state.sessionId) return bindings;
        for (const source of set.sources) {
            if (!isLive(source)) continue;
            const binding = bindingFrom(state.held.get(source.id)?.finding ?? null, source);
            if (binding !== 'UNBOUND') bindings.set(source.id, binding);
        }
        return bindings;
    }
}

const NOT_READ_REASONS: ReadonlyMap<unknown, NotReadReason> = new Map(
    (Object.keys(NOT_READ_BINDING) as NotReadReason[]).map((reason) => [reason, reason]),
);

function take(state: LedgerState, set: DrawingSet, handedOut: Map<Uuid, HandedOut> | null, sourceId: Uuid, result: SourceFileCheck): BindingSettlement {
    // Each field of the result is read once: what is checked is what is used.
    const raw = result !== null && typeof result === 'object' ? (result as { kind?: unknown; digest?: unknown; file?: unknown; reason?: unknown }) : {};
    const kind = raw.kind;
    // A digest is spent the first time it is offered, whatever the answer.
    const spent = kind === 'READ' ? spendFileDigest(raw.digest) : null;
    if (!handedOut || set.id !== state.sessionId) return 'SESSION_REPLACED';
    const source = liveSource(set, sourceId);
    if (!source) return 'SOURCE_NOT_LIVE';
    const taken = handedOut.get(sourceId);
    if (!taken) return 'NOT_HANDED_OUT';

    let finding: Finding;
    if (kind === 'READ') {
        if (!spent) return 'NOT_VERIFIED';
        if (spent.record.scope !== state.sessionId) return 'SESSION_REPLACED';
        if (taken.file === null || spent.record.file !== taken.file) return 'NOT_HANDED_OUT';
        finding = { kind: 'READ', sha256: spent.record.sha256, byteLength: spent.record.byteLength, against: source.fingerprint.sha256, checkedAt: taken.order };
    } else if (kind === 'NOT_READ' && NOT_READ_REASONS.has(raw.reason)) {
        const reason = NOT_READ_REASONS.get(raw.reason)!;
        const file = raw.file;
        if (file !== taken.file || (reason === 'NO_FILE') !== (taken.file === null)) return 'NOT_HANDED_OUT';
        // A size difference is a fact anyone can see; one that is not there is not taken.
        if (reason === 'SIZE_DIFFERS' && taken.file !== null && taken.expected !== null && taken.file.size === taken.expected.byteLength) return 'NOT_VERIFIED';
        finding = { kind: 'NOT_READ', binding: NOT_READ_BINDING[reason], against: source.fingerprint.sha256, checkedAt: taken.order };
    } else {
        return 'NOT_VERIFIED';
    }

    const held = state.held.get(sourceId);
    if ((held?.presentedAt ?? 0) !== taken.presentedAt) return 'FILE_REPLACED';
    if (held?.finding && taken.order <= held.finding.checkedAt) return 'SUPERSEDED';
    const aboutBytes = finding.kind === 'READ' || finding.binding === 'CHANGED';
    if (aboutBytes && (taken.expected === null || taken.expected.sha256 !== source.fingerprint.sha256 || taken.expected.byteLength !== source.fingerprint.byteLength)) {
        return 'FINGERPRINT_DIFFERS';
    }
    if (spent) {
        if (spent.alreadySpent) return 'EVIDENCE_SPENT';
        if (spent.record.readStartedAt <= taken.order) return 'EVIDENCE_OUTDATED';
    }
    state.held.set(sourceId, { file: taken.file, presentedAt: taken.presentedAt, finding });
    return 'APPLIED';
}

/**
 * What the ledger knows about one Source's File now, against the Drawing Set
 * as it is now. This is what currency and confirmation decide by. Anything
 * that is not a genuine ledger of this session -- a Map, an object shaped
 * like a ledger, one built with Object.create, another session's -- knows
 * nothing: UNBOUND.
 */
export function verifiedBinding(ledger: RuntimeBindingLedger, set: DrawingSet, sourceId: Uuid): SourceBinding | 'UNBOUND' {
    const state = stateOf(ledger);
    if (!state || set.id !== state.sessionId) return 'UNBOUND';
    const source = liveSource(set, sourceId);
    if (!source) return 'UNBOUND';
    return bindingFrom(state.held.get(sourceId)?.finding ?? null, source);
}

/**
 * Check the File held for one Source now: the verification-only path. Reads
 * the File through the fingerprint Worker (without keeping its bytes) and
 * settles what it found into the ledger. CANCELLED: the signal aborted, and
 * nothing was settled.
 */
export async function verifyHeldFile(
    ledger: RuntimeBindingLedger,
    current: () => DrawingSet,
    sourceId: Uuid,
    options: { signal?: AbortSignal; chunkBytes?: number } = {},
): Promise<BindingSettlement | 'CANCELLED'> {
    const set = current();
    const check = ledger.beginCheck(set);
    const file = check.fileFor(sourceId);
    const source = liveSource(set, sourceId);
    if (!source) return 'SOURCE_NOT_LIVE';
    const signal = options.signal ?? new AbortController().signal;
    let result: SourceFileCheck;
    if (!file) {
        result = { kind: 'NOT_READ', file: null, reason: 'NO_FILE' };
    } else if (file.size !== source.fingerprint.byteLength) {
        result = { kind: 'NOT_READ', file, reason: 'SIZE_DIFFERS' };
    } else {
        try {
            result = { kind: 'READ', digest: await readFileDigest(file, null, { signal, chunkBytes: options.chunkBytes, scope: set.id }) };
        } catch (error) {
            if (signal.aborted || (error instanceof IntakeStop && error.refusal === null)) return 'CANCELLED';
            result = { kind: 'NOT_READ', file, reason: error instanceof IntakeStop && error.refusal?.code === 'FILE_CHANGED' ? 'CHANGED_WHILE_READ' : 'UNREADABLE' };
        }
    }
    return ledger.settle(current(), check, new Map([[sourceId, result]])).get(sourceId) ?? 'NOT_HANDED_OUT';
}

export type StaleReason = 'STALE_SOURCE' | 'STALE_PROFILE';
export type CurrencyState = 'NONE' | 'CURRENT' | 'UNVERIFIED' | 'STALE';

export interface RecordCurrency {
    state: CurrencyState;
    /** Both can hold at once. Empty unless state is STALE. */
    staleReasons: StaleReason[];
    /** UNBOUND: this session has taken no check of a File held for the Source (none held, or not yet checked). */
    binding: SourceBinding | 'UNBOUND';
}

/** The one-word reading of a currency, for display and for tests. */
export function currencyLabel(currency: RecordCurrency): 'NONE' | 'CURRENT' | 'UNVERIFIED' | 'STALE_SOURCE' | 'STALE_PROFILE' | 'STALE_SOURCE_AND_PROFILE' {
    if (currency.state !== 'STALE') return currency.state;
    const source = currency.staleReasons.includes('STALE_SOURCE');
    const profile = currency.staleReasons.includes('STALE_PROFILE');
    return source && profile ? 'STALE_SOURCE_AND_PROFILE' : source ? 'STALE_SOURCE' : 'STALE_PROFILE';
}

function currencyOf(
    set: DrawingSet, sheet: Sheet, record: { sourceSha256: Sha256Hex; profile: ProfileBasis | null } | null, ledger: RuntimeBindingLedger,
): RecordCurrency {
    const binding = verifiedBinding(ledger, set, sheet.sourceId);
    if (!record) return { state: 'NONE', staleReasons: [], binding };
    const staleReasons: StaleReason[] = [];
    const source = set.sources.find((s) => s.id === sheet.sourceId);
    if (!source || source.fingerprint.sha256 !== record.sourceSha256) staleReasons.push('STALE_SOURCE');
    if (record.profile) {
        const basis = record.profile;
        const profile = set.titleBlockProfiles.find((p) => p.id === basis.profileId);
        const stillAssigned = sheet.profileAssignment?.profileId === basis.profileId;
        if (!stillAssigned || !profile || profile.retiredAt !== null || profile.revision !== basis.profileRevision) {
            staleReasons.push('STALE_PROFILE');
        }
    }
    if (staleReasons.length > 0) return { state: 'STALE', staleReasons, binding };
    if (binding !== 'MATCHED') return { state: 'UNVERIFIED', staleReasons, binding };
    return { state: 'CURRENT', staleReasons, binding };
}

/** Whether a Sheet's observation still stands, as the ledger knows its Source's File now. */
export const observationCurrency = (set: DrawingSet, sheet: Sheet, ledger: RuntimeBindingLedger): RecordCurrency =>
    currencyOf(set, sheet, sheet.observation, ledger);

/** Whether a Sheet's confirmation still stands, as the ledger knows its Source's File now. */
export const confirmationCurrency = (set: DrawingSet, sheet: Sheet, ledger: RuntimeBindingLedger): RecordCurrency =>
    currencyOf(set, sheet, sheet.confirmation, ledger);
