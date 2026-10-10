/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Whether a piece of derived data can still be believed -- computed, not stored.
 *
 * Nothing in a Portable Project JSON says "stale". Every derived record says
 * what it was derived *from* (which bytes, which profile revision), and
 * staleness is the answer to one comparison: is that still what is there now?
 *
 * That choice does three things at once.
 *
 *   - A change cannot forget to mark something. Replacing a Source's
 *     fingerprint is one assignment, and every observation, confirmation and
 *     finding read from the old bytes is stale the moment it happens.
 *   - The scope is exact. What goes stale is what names the changed thing in
 *     its basis, and nothing else in the Project.
 *   - A file cannot claim freshness. There is no flag to set to `false`.
 *
 * Runtime binding is the second input. A basis that matches the manifest says
 * the record agrees with the *recorded* fingerprint; only a Source that is
 * bound and MATCHED this session says the bytes in hand are those bytes. Until
 * then the record is not wrong, it is UNVERIFIED.
 */

import { effectiveDecisions as effectiveDecisionsOf } from './model-ops.mjs';

export const BINDING = Object.freeze({
    UNBOUND: 'UNBOUND',
    MATCHED: 'MATCHED',
    CHANGED: 'CHANGED',
    MISSING: 'MISSING',
    AMBIGUOUS: 'AMBIGUOUS',
});

export const DATA_CURRENCY = Object.freeze({
    NONE: 'NONE',
    CURRENT: 'CURRENT',
    STALE_SOURCE: 'STALE_SOURCE',
    STALE_PROFILE: 'STALE_PROFILE',
});

export const FINDING_CURRENCY = Object.freeze({
    /** Not the latest statement any more: SUPERSEDED or NOT_REPRODUCED. */
    HISTORICAL: 'HISTORICAL',
    /** Stated about bytes that are no longer the Source's content. */
    STALE: 'STALE',
    /** Consistent with the manifest, but not checked against bytes in hand. */
    UNVERIFIED: 'UNVERIFIED',
    CURRENT: 'CURRENT',
});

/** Rules whose answer depends on which sheets are in the set, not only on the ones they cite. */
export const SET_GLOBAL_RULES = new Set(['QA03_NUMBER_GAP', 'QA07_SHEET_SIZE_OUTLIER', 'QA08_ORIENTATION_OUTLIER']);

const profileBasisCurrent = (basis, sheet, profiles) => {
    if (!sheet.profileAssignment || sheet.profileAssignment.profileId !== basis.profileId) return false;
    const profile = profiles.get(basis.profileId);
    return !!profile && profile.revision === basis.profileRevision;
};

/**
 * Everything derived for one sheet, judged against what is there now.
 *
 * `effective` is what a QA rule may read: the confirmed values if the
 * confirmation still stands, else the observed values if the observation still
 * stands, else nothing. A sheet with nothing is not evaluated by the metadata
 * rules; it is reported by QA02 instead of being guessed at.
 */
export function sheetCurrency(sheet, source, profiles) {
    const sha = source.fingerprint.sha256;

    let pageFacts = DATA_CURRENCY.NONE;
    if (sheet.pageFacts) pageFacts = sheet.pageFacts.sourceSha256 === sha ? DATA_CURRENCY.CURRENT : DATA_CURRENCY.STALE_SOURCE;

    let observation = DATA_CURRENCY.NONE;
    if (sheet.observation) {
        if (sheet.observation.sourceSha256 !== sha) observation = DATA_CURRENCY.STALE_SOURCE;
        else if (!profileBasisCurrent(sheet.observation.profile, sheet, profiles)) observation = DATA_CURRENCY.STALE_PROFILE;
        else observation = DATA_CURRENCY.CURRENT;
    }

    let confirmation = DATA_CURRENCY.NONE;
    if (sheet.confirmation) {
        if (sheet.confirmation.sourceSha256 !== sha) confirmation = DATA_CURRENCY.STALE_SOURCE;
        // A confirmation made with no profile involved is a person's own reading
        // of the sheet; no profile change can reach it.
        else if (sheet.confirmation.profile && !profileBasisCurrent(sheet.confirmation.profile, sheet, profiles)) confirmation = DATA_CURRENCY.STALE_PROFILE;
        else confirmation = DATA_CURRENCY.CURRENT;
    }

    let effective = null;
    if (confirmation === DATA_CURRENCY.CURRENT) effective = { values: sheet.confirmation.values, basis: 'CONFIRMED' };
    else if (observation === DATA_CURRENCY.CURRENT && sheet.observation.status === 'READ') {
        const fields = sheet.observation.fields;
        effective = {
            values: {
                drawingNumber: fields.drawingNumber.value, drawingTitle: fields.drawingTitle.value,
                revision: fields.revision.value, issueDate: fields.issueDate.value,
            },
            basis: 'OBSERVED',
        };
    }
    return { pageFacts, observation, confirmation, effective };
}

/** Index a model once; every function below wants the same maps. */
export function indexModel(model) {
    const set = model.drawingSet;
    return {
        sources: new Map(set.sources.map((s) => [s.id, s])),
        profiles: new Map(set.titleBlockProfiles.map((p) => [p.id, p])),
        sheets: new Map(set.sheets.map((s) => [s.id, s])),
        runs: new Map(set.analysisRuns.map((r) => [r.id, r])),
        registerEntries: new Map(set.drawingRegisterReferences.flatMap((reference) => reference.entries.map((entry) => [entry.id, { entry, reference }]))),
        findings: new Map(set.findings.map((f) => [f.id, f])),
    };
}

export const REGISTER_STATUS = Object.freeze({
    /** No register has been declared (or every one was withdrawn). QA09 has nothing to compare with. */
    NOT_DESIGNATED: 'NOT_DESIGNATED',
    /** A declared register was read from bytes its Source no longer has. */
    STALE: 'STALE',
    CURRENT: 'CURRENT',
});

/**
 * The declared Drawing Register, judged against what is there now.
 *
 * A register is declared from one page of one Source, and it is bound to those
 * bytes exactly as an observation is. Replace the Source and nobody has declared
 * what the list on the new bytes says: the register is STALE, QA09 cannot be
 * evaluated, and a person declares it again. One stale reference makes the
 * whole declared list incomplete, so the status is that of the worst.
 */
export function registerCurrency(model, index = indexModel(model)) {
    const references = model.drawingSet.drawingRegisterReferences.filter((r) => r.retiredAt === null);
    const stale = references.filter((reference) => {
        const source = index.sources.get(reference.sourceId);
        return !source || source.retiredAt !== null || source.fingerprint.sha256 !== reference.sourceSha256;
    });
    const liveEntries = references.flatMap((reference) => reference.entries.filter((e) => e.retiredAt === null).map((entry) => ({ entry, reference })));
    let status = REGISTER_STATUS.CURRENT;
    if (references.length === 0) status = REGISTER_STATUS.NOT_DESIGNATED;
    else if (stale.length > 0) status = REGISTER_STATUS.STALE;
    return { status, references, staleReferences: stale, liveEntries };
}

/** Currency of every live sheet, and whether the whole set could be evaluated. */
export function setCurrency(model, index = indexModel(model)) {
    const bySheet = new Map();
    let metadataComplete = true;
    let factsComplete = true;
    for (const sheet of model.drawingSet.sheets) {
        if (sheet.retiredAt !== null) continue;
        const currency = sheetCurrency(sheet, index.sources.get(sheet.sourceId), index.profiles);
        bySheet.set(sheet.id, currency);
        if (!currency.effective) metadataComplete = false;
        if (currency.pageFacts !== DATA_CURRENCY.CURRENT) factsComplete = false;
    }
    return { bySheet, metadataComplete, factsComplete, register: registerCurrency(model, index) };
}

const bindingOf = (bindings, sourceId) => bindings?.get(sourceId) ?? BINDING.UNBOUND;

/**
 * The currency of one finding, with the reasons.
 *
 * A stale finding is not a resolved finding and not a wrong one. It is a
 * statement about bytes the Source no longer has; the next QA run that can
 * evaluate its subject either states it again with new evidence (superseding
 * it) or does not (NOT_REPRODUCED). Its decisions stay attached to it either
 * way and become history.
 */
export function findingCurrency(finding, index, bindings, coverage) {
    if (finding.lifecycle.state !== 'ACTIVE') return { currency: FINDING_CURRENCY.HISTORICAL, reasons: [finding.lifecycle.state] };
    const reasons = [];
    for (const basis of finding.basis) {
        const source = index.sources.get(basis.sourceId);
        if (!source || source.retiredAt !== null) reasons.push('SOURCE_RETIRED');
        else if (source.fingerprint.sha256 !== basis.sha256) reasons.push('SOURCE_REPLACED');
    }
    for (const sheetId of finding.sheetIds) {
        const sheet = index.sheets.get(sheetId);
        if (!sheet || sheet.retiredAt !== null) reasons.push('SHEET_RETIRED');
    }
    for (const entryId of finding.registerEntryIds) {
        const item = index.registerEntries.get(entryId);
        if (!item || item.entry.retiredAt !== null || item.reference.retiredAt !== null) reasons.push('REGISTER_ENTRY_RETIRED');
    }
    // QA09 is a statement against the declared register as a whole. If that is
    // withdrawn or no longer current, the statement is about a list nobody stands behind.
    if (finding.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && coverage && coverage.register.status !== REGISTER_STATUS.CURRENT) {
        reasons.push(coverage.register.status === REGISTER_STATUS.STALE ? 'REGISTER_NOT_CURRENT' : 'REGISTER_NOT_DESIGNATED');
    }
    if (reasons.length > 0) return { currency: FINDING_CURRENCY.STALE, reasons: [...new Set(reasons)] };

    if (SET_GLOBAL_RULES.has(finding.ruleId) && coverage) {
        const complete = finding.ruleId === 'QA03_NUMBER_GAP' ? coverage.metadataComplete : coverage.factsComplete;
        if (!complete) reasons.push('SET_NOT_FULLY_EVALUATED');
    }
    // "Listed but missing" is true only if NO sheet carries the number, so a sheet
    // that could not be read leaves it open.
    if (finding.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && finding.scope === 'REGISTER_ENTRY' && coverage && !coverage.metadataComplete) {
        reasons.push('SET_NOT_FULLY_EVALUATED');
    }
    for (const basis of finding.basis) {
        if (bindingOf(bindings, basis.sourceId) !== BINDING.MATCHED) { reasons.push('SOURCE_NOT_MATCHED'); break; }
    }
    if (reasons.length > 0) return { currency: FINDING_CURRENCY.UNVERIFIED, reasons };
    return { currency: FINDING_CURRENCY.CURRENT, reasons: [] };
}

export const FINAL_BLOCKER = Object.freeze({
    SOURCES_NOT_MATCHED: 'SOURCES_NOT_MATCHED',
    METADATA_NOT_CONFIRMED: 'METADATA_NOT_CONFIRMED',
    FINDINGS_NOT_CURRENT: 'FINDINGS_NOT_CURRENT',
    FINDINGS_UNREVIEWED: 'FINDINGS_UNREVIEWED',
    FINDINGS_ON_HOLD: 'FINDINGS_ON_HOLD',
    REGISTER_NOT_CURRENT: 'REGISTER_NOT_CURRENT',
});

/**
 * The one decision that lifts the metadata-confirmation requirement from a sheet.
 *
 * QA02 states a fact: nobody has confirmed this sheet's metadata. INTENTIONAL is
 * a person saying the metadata is deliberately not applicable here (a cover
 * sheet with no title block), and that is an answer to the requirement.
 * FALSE_POSITIVE is not: it says the finding is wrong, and if it really is wrong
 * the thing to do is confirm the sheet, after which the next run does not state
 * the finding at all. Letting FALSE_POSITIVE clear the blocker would let a Final
 * report go out over metadata nobody confirmed and nobody declared unnecessary.
 * ACTION_REQUIRED and HOLD say the work is still to do.
 */
const EXEMPTS_FROM_METADATA_CONFIRMATION = new Set(['INTENTIONAL']);

/**
 * Whether a QA Report may be called Final.
 *
 * Completion is not "no findings". It is: every Source is the bytes the review
 * was about, every sheet's metadata has been confirmed by a person (or a person
 * has said, on the record, that it is intentionally not), and no current
 * finding is waiting for a decision.
 *
 * A QA02 finding lifts the metadata requirement from its sheet only when a
 * person has decided it INTENTIONAL (see EXEMPTS_FROM_METADATA_CONFIRMATION).
 *
 * `holdBlocksFinal` is a question for the Human Gate, not something this
 * research decides: the adopted contract lists HOLD among the Human outcomes,
 * so by its letter a HOLD is a review. The default follows the letter.
 */
export function finalReadiness(model, bindings, { holdBlocksFinal = false, effectiveDecisions } = {}) {
    const index = indexModel(model);
    const coverage = setCurrency(model, index);
    const decisions = effectiveDecisions ?? effectiveDecisionsOf(model);
    const blockers = new Map();
    const block = (code) => blockers.set(code, (blockers.get(code) ?? 0) + 1);

    for (const source of model.drawingSet.sources) {
        if (source.retiredAt === null && bindingOf(bindings, source.id) !== BINDING.MATCHED) block(FINAL_BLOCKER.SOURCES_NOT_MATCHED);
    }

    // A sheet a person has deliberately left unconfirmed is exempt, and the
    // exemption is itself a recorded decision on that sheet's QA02 finding.
    const exemptSheets = new Set();
    for (const finding of model.drawingSet.findings) {
        if (finding.lifecycle.state !== 'ACTIVE') continue;
        const state = findingCurrency(finding, index, bindings, coverage);
        const decision = decisions.get(finding.id);
        if (finding.ruleId === 'QA02_METADATA_UNCONFIRMED' && state.currency === FINDING_CURRENCY.CURRENT
            && decision && EXEMPTS_FROM_METADATA_CONFIRMATION.has(decision.outcome)) exemptSheets.add(finding.sheetIds[0]);
        if (state.currency !== FINDING_CURRENCY.CURRENT) { block(FINAL_BLOCKER.FINDINGS_NOT_CURRENT); continue; }
        if (!decision) block(FINAL_BLOCKER.FINDINGS_UNREVIEWED);
        else if (holdBlocksFinal && decision.outcome === 'HOLD') block(FINAL_BLOCKER.FINDINGS_ON_HOLD);
    }

    for (const [sheetId, currency] of coverage.bySheet) {
        if (currency.confirmation !== DATA_CURRENCY.CURRENT && !exemptSheets.has(sheetId)) block(FINAL_BLOCKER.METADATA_NOT_CONFIRMED);
    }

    // A declared register that is no longer current blocks: a person asked for
    // this comparison and it cannot be made. No declared register does not block
    // -- it is optional -- but QA09 is then NOT EVALUABLE, and a report must say
    // so rather than count the absence of findings as a pass.
    for (const reference of coverage.register.staleReferences) { void reference; block(FINAL_BLOCKER.REGISTER_NOT_CURRENT); }
    const notEvaluable = [];
    if (coverage.register.status !== REGISTER_STATUS.CURRENT) {
        notEvaluable.push({
            ruleId: 'QA09_REGISTER_SHEET_MISMATCH',
            reason: coverage.register.status === REGISTER_STATUS.STALE ? 'DECLARED_REGISTER_NOT_CURRENT' : 'NO_DECLARED_REGISTER',
        });
    }

    return {
        final: blockers.size === 0,
        blockers: [...blockers].map(([code, count]) => ({ code, count })),
        notEvaluable,
    };
}

/**
 * Which classes of derived data a given change makes stale, and how far.
 *
 * This is the matrix of rebinding-state-machine.md / data-model.proposed.md as
 * data, so tests/stale.test.mjs can hold the prototype to it row by row.
 * `scope` is how far the effect reaches: the sheets of ONE source, the sheets
 * assigned to ONE profile, ONE sheet, or the set-wide results.
 */
export const STALE_MATRIX = Object.freeze({
    SOURCE_CONTENT_REPLACED: {
        scope: 'SHEETS_OF_THAT_SOURCE',
        pageFacts: 'STALE', observation: 'STALE', confirmation: 'RECONFIRM',
        findingsCitingThoseSheets: 'STALE', setGlobalFindings: 'UNVERIFIED_UNTIL_REEVALUATED',
        otherSources: 'UNAFFECTED', decisions: 'KEPT_AS_HISTORY',
        declaredRegister: 'STALE_IF_DECLARED_FROM_THAT_SOURCE',
    },
    SOURCE_RENAMED_SAME_CONTENT: {
        scope: 'NONE',
        pageFacts: 'UNAFFECTED', observation: 'UNAFFECTED', confirmation: 'UNAFFECTED',
        findingsCitingThoseSheets: 'UNAFFECTED', setGlobalFindings: 'UNAFFECTED',
        otherSources: 'UNAFFECTED', decisions: 'UNAFFECTED',
        declaredRegister: 'UNAFFECTED',
    },
    SOURCE_NOT_PROVIDED: {
        scope: 'SHEETS_OF_THAT_SOURCE',
        pageFacts: 'UNVERIFIED', observation: 'UNVERIFIED', confirmation: 'UNVERIFIED',
        findingsCitingThoseSheets: 'UNVERIFIED', setGlobalFindings: 'UNAFFECTED',
        otherSources: 'UNAFFECTED', decisions: 'KEPT_IN_FORCE_BUT_UNVERIFIED',
        declaredRegister: 'UNVERIFIED_IF_DECLARED_FROM_THAT_SOURCE',
    },
    PROFILE_GEOMETRY_CHANGED: {
        scope: 'SHEETS_ASSIGNED_TO_THAT_PROFILE',
        pageFacts: 'UNAFFECTED', observation: 'STALE', confirmation: 'RECONFIRM_UNLESS_MADE_WITHOUT_PROFILE',
        findingsCitingThoseSheets: 'REEVALUATED', setGlobalFindings: 'REEVALUATED',
        otherSources: 'UNAFFECTED', decisions: 'KEPT_IF_EVIDENCE_UNCHANGED',
        declaredRegister: 'UNAFFECTED',
    },
    SHEET_REASSIGNED_TO_ANOTHER_PROFILE: {
        scope: 'THAT_SHEET',
        pageFacts: 'UNAFFECTED', observation: 'STALE', confirmation: 'RECONFIRM_UNLESS_MADE_WITHOUT_PROFILE',
        findingsCitingThoseSheets: 'REEVALUATED', setGlobalFindings: 'REEVALUATED',
        otherSources: 'UNAFFECTED', decisions: 'KEPT_IF_EVIDENCE_UNCHANGED',
        declaredRegister: 'UNAFFECTED',
    },
    SHEET_METADATA_CONFIRMED_OR_EDITED: {
        scope: 'THAT_SHEET',
        pageFacts: 'UNAFFECTED', observation: 'UNAFFECTED', confirmation: 'REPLACED_WITH_HISTORY',
        findingsCitingThoseSheets: 'REEVALUATED', setGlobalFindings: 'REEVALUATED',
        otherSources: 'UNAFFECTED', decisions: 'KEPT_IF_EVIDENCE_UNCHANGED',
        declaredRegister: 'UNAFFECTED',
    },
    SOURCE_ADDED_OR_RETIRED: {
        scope: 'SET_WIDE_RESULTS',
        pageFacts: 'UNAFFECTED', observation: 'UNAFFECTED', confirmation: 'UNAFFECTED',
        findingsCitingThoseSheets: 'REEVALUATED', setGlobalFindings: 'REEVALUATED',
        otherSources: 'UNAFFECTED', decisions: 'KEPT_IF_EVIDENCE_UNCHANGED',
        declaredRegister: 'RETIRED_WITH_ITS_SOURCE',
    },
    DECLARED_REGISTER_DECLARED_EDITED_OR_WITHDRAWN: {
        scope: 'QA09_ONLY',
        pageFacts: 'UNAFFECTED', observation: 'UNAFFECTED', confirmation: 'UNAFFECTED',
        findingsCitingThoseSheets: 'QA09_REEVALUATED', setGlobalFindings: 'UNAFFECTED',
        otherSources: 'UNAFFECTED', decisions: 'KEPT_IF_EVIDENCE_UNCHANGED',
        declaredRegister: 'REPLACED_BY_A_NEW_REFERENCE_OR_RETIRED',
    },
});
