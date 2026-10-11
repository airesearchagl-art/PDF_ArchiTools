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
import type { DrawingSet, ProfileBasis, Sha256Hex, Sheet, Uuid } from './model';
import { isLive } from './model';

/** What this session knows about the File behind a Source. Runtime only; never stored. */
export type SourceBinding = 'MATCHED' | 'CHANGED' | 'MISSING';
export type RuntimeBindings = ReadonlyMap<Uuid, SourceBinding>;

/**
 * What one check of one Source's File found. `file` is the File that was
 * read -- null when there was none to read -- and `sha256` the fingerprint
 * its bytes were compared with. MATCHED only when the SHA-256 of exactly those
 * bytes equalled it; CHANGED when they did not; MISSING when the File could
 * not be had or read.
 */
export interface SourceFileCheck {
    file: Blob | null;
    sha256: Sha256Hex;
    binding: SourceBinding;
}

/** Why a check's result about one Source was not taken. */
export type BindingRefusal =
    /** The check, or the Drawing Set it was settled against, belongs to another session. */
    | 'SESSION_REPLACED'
    /** The Source is retired, or not in the Drawing Set. */
    | 'SOURCE_NOT_LIVE'
    /** The result is about a File this check did not hand out for that Source. */
    | 'NOT_HANDED_OUT'
    /** Another File was presented for the Source (or it was withdrawn) after this check took its own. */
    | 'FILE_REPLACED'
    /** A later check of the same File has already been taken. */
    | 'SUPERSEDED'
    /** The bytes were compared with a fingerprint that is not the Source's now. */
    | 'FINGERPRINT_DIFFERS';
export type BindingSettlement = 'APPLIED' | BindingRefusal;

/** Hands a checker the File held for a Source, and notes which one it was and when. */
export interface BindingCheck {
    fileFor(sourceId: Uuid): Blob | null;
}

interface Held {
    file: Blob | null;
    /** Which presentation of a File this is; every present() starts a new one. 0: none yet. */
    presentation: number;
    /** What the latest check taken for this presentation found; null: none taken yet. */
    binding: SourceBinding | null;
    /** The fingerprint that check compared with. */
    sha256: Sha256Hex | null;
    /** The order of that check (see `sequence`). */
    checkedAt: number;
}

interface HandedOut {
    file: Blob | null;
    presentation: number;
    order: number;
}

/**
 * The runtime bindings of one session (semantic contract §B): the File held
 * for each Source and what the latest check of it found. Never stored.
 *
 *  - A binding comes only from a check of the File, and MATCHED only from
 *    SHA-256 equality. Presenting a File binds nothing by itself: until a
 *    check of it is taken the Source stays UNBOUND, whatever its name or
 *    size, and nothing found about an earlier File carries over to it.
 *  - Nothing sticks. Each check taken replaces what the one before found, so
 *    the same Source -- not a new one -- goes from MISSING or CHANGED back to
 *    MATCHED once a File holding its bytes is checked again, and from
 *    MATCHED to CHANGED or MISSING when the File held stops holding them.
 *  - A result is taken only while it is still about what is held: this
 *    session's check, a live Source, the very File handed out for it and not
 *    since replaced, no later check of that File already taken, and -- for
 *    MATCHED or CHANGED -- compared with the Source's fingerprint now. Any
 *    other result is refused, never merged, so a report that arrives late
 *    cannot undo a newer one.
 *  - Each Source stands alone: nothing done for one touches another.
 *
 * It never accepts changed bytes as a Source's content and never chooses
 * between candidate files: that is rebinding (M7-P4).
 */
export class RuntimeBindingLedger {
    private readonly held = new Map<Uuid, Held>();
    private readonly checks = new WeakMap<BindingCheck, Map<Uuid, HandedOut>>();
    /** One counter for presentations and checks, so their order can be compared. */
    private sequence = 0;

    /** The Drawing Set this session holds; a check or a set of any other is refused. */
    readonly sessionId: Uuid;

    constructor(sessionId: Uuid) {
        this.sessionId = sessionId;
    }

    /**
     * A person presents a File for a Source, or withdraws it (null). The Source
     * is UNBOUND until a check of this File is taken.
     */
    present(set: DrawingSet, sourceId: Uuid, file: Blob | null): BindingSettlement {
        if (set.id !== this.sessionId) return 'SESSION_REPLACED';
        const source = set.sources.find((s) => s.id === sourceId);
        if (!source || !isLive(source)) return 'SOURCE_NOT_LIVE';
        this.sequence += 1;
        this.held.set(sourceId, { file, presentation: this.sequence, binding: null, sha256: null, checkedAt: 0 });
        return 'APPLIED';
    }

    /** The File held for a Source, without checking anything. */
    heldFile(sourceId: Uuid): Blob | null {
        return this.held.get(sourceId)?.file ?? null;
    }

    /** Begin one check; its `fileFor` is what the checker reads Files through. */
    beginCheck(): BindingCheck {
        const handedOut = new Map<Uuid, HandedOut>();
        const check: BindingCheck = {
            fileFor: (sourceId) => {
                const held = this.held.get(sourceId);
                this.sequence += 1;
                const file = held?.file ?? null;
                handedOut.set(sourceId, { file, presentation: held?.presentation ?? 0, order: this.sequence });
                return file;
            },
        };
        this.checks.set(check, handedOut);
        return check;
    }

    /** Take what a check found, Source by Source; each result is taken or refused on its own. */
    settle(set: DrawingSet, check: BindingCheck, results: ReadonlyMap<Uuid, SourceFileCheck>): Map<Uuid, BindingSettlement> {
        const handedOut = this.checks.get(check);
        const settled = new Map<Uuid, BindingSettlement>();
        for (const [sourceId, result] of results) settled.set(sourceId, this.take(set, handedOut, sourceId, result));
        return settled;
    }

    private take(set: DrawingSet, handedOut: Map<Uuid, HandedOut> | undefined, sourceId: Uuid, result: SourceFileCheck): BindingSettlement {
        if (!handedOut || set.id !== this.sessionId) return 'SESSION_REPLACED';
        const source = set.sources.find((s) => s.id === sourceId);
        if (!source || !isLive(source)) return 'SOURCE_NOT_LIVE';
        const taken = handedOut.get(sourceId);
        if (!taken || taken.file !== result.file || (result.file === null && result.binding !== 'MISSING')) return 'NOT_HANDED_OUT';
        const held = this.held.get(sourceId);
        if ((held?.presentation ?? 0) !== taken.presentation) return 'FILE_REPLACED';
        if (held && taken.order <= held.checkedAt) return 'SUPERSEDED';
        if (result.binding !== 'MISSING' && result.sha256 !== source.fingerprint.sha256) return 'FINGERPRINT_DIFFERS';
        this.held.set(sourceId, {
            file: taken.file, presentation: taken.presentation, binding: result.binding, sha256: result.sha256, checkedAt: taken.order,
        });
        return 'APPLIED';
    }

    /**
     * What this session knows now about the live Sources of the set. A Source
     * with no check taken is absent (UNBOUND), and so is one whose MATCHED or
     * CHANGED was found against a fingerprint it no longer has: that check
     * says nothing about the bytes it is to hold now.
     */
    bindings(set: DrawingSet): RuntimeBindings {
        const bindings = new Map<Uuid, SourceBinding>();
        if (set.id !== this.sessionId) return bindings;
        for (const source of set.sources) {
            const held = isLive(source) ? this.held.get(source.id) : undefined;
            if (!held?.binding) continue;
            if (held.binding !== 'MISSING' && held.sha256 !== source.fingerprint.sha256) continue;
            bindings.set(source.id, held.binding);
        }
        return bindings;
    }
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
    set: DrawingSet, sheet: Sheet, record: { sourceSha256: Sha256Hex; profile: ProfileBasis | null } | null, bindings: RuntimeBindings,
): RecordCurrency {
    const binding = bindings.get(sheet.sourceId) ?? 'UNBOUND';
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

/** Whether a Sheet's observation still stands. */
export const observationCurrency = (set: DrawingSet, sheet: Sheet, bindings: RuntimeBindings): RecordCurrency =>
    currencyOf(set, sheet, sheet.observation, bindings);

/** Whether a Sheet's confirmation still stands. */
export const confirmationCurrency = (set: DrawingSet, sheet: Sheet, bindings: RuntimeBindings): RecordCurrency =>
    currencyOf(set, sheet, sheet.confirmation, bindings);
