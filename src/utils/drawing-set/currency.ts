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
 *
 * M7-P2 cannot record new bytes for a Source (that is M7-P4's rebinding), so
 * in the app STALE_SOURCE only arises from a state built for a test; the rule
 * is still the contract's and is derived the same way.
 */
import type { DrawingSet, ProfileBasis, Sha256Hex, Sheet, Uuid } from './model';

/** What this session knows about the File behind a Source. Runtime only; never stored. */
export type SourceBinding = 'MATCHED' | 'CHANGED' | 'MISSING';
export type RuntimeBindings = ReadonlyMap<Uuid, SourceBinding>;

/**
 * A later report can only make a binding worse. Once a File is known not to
 * hold the fingerprinted bytes, or not to be readable, this session does not
 * vouch for it again; adding the file back makes a new Source.
 */
export function mergeBinding(previous: SourceBinding | undefined, next: SourceBinding): SourceBinding {
    if (previous === 'CHANGED' || next === 'CHANGED') return 'CHANGED';
    if (previous === 'MISSING' || next === 'MISSING') return 'MISSING';
    return 'MATCHED';
}

export type StaleReason = 'STALE_SOURCE' | 'STALE_PROFILE';
export type CurrencyState = 'NONE' | 'CURRENT' | 'UNVERIFIED' | 'STALE';

export interface RecordCurrency {
    state: CurrencyState;
    /** Both can hold at once. Empty unless state is STALE. */
    staleReasons: StaleReason[];
    /** UNBOUND: this session holds no File for the Source at all. */
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
