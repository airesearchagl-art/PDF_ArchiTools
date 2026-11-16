/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Binding the PDFs a person selects to the Sources a Project remembers.
 *
 * A Portable Project JSON holds no bytes and no paths, so on resume every
 * Source is a description waiting for a file. This is the function that decides
 * which file is which, and it is a pure one: manifest and candidates in, one
 * state per Source out, nothing read and nothing changed.
 *
 * It has one rule and one hint.
 *
 *   The rule: SHA-256 equality. A file whose fingerprint equals a Source's is
 *   that Source's content, whatever it is called and wherever it came from.
 *   Nothing else produces MATCHED.
 *
 *   The hint: the file name. It can only *nominate* a file as the changed
 *   version of a Source -- which is a question for a person, never an answer.
 *   A name match with a different fingerprint is CHANGED, not MATCHED, and two
 *   plausible nominations are AMBIGUOUS, not a guess.
 *
 * The states:
 *
 *   UNBOUND    nobody has looked yet. The state of every Source on resume.
 *   MATCHED    a selected file has this Source's fingerprint.
 *   CHANGED    no selected file has it, and exactly one is nominated by name.
 *   AMBIGUOUS  no selected file has it, and the nomination is not unique.
 *   MISSING    a pass was made and nothing matched or was nominated.
 *
 * UNBOUND and MISSING both mean "no bytes", and the difference is whether that
 * is known: UNBOUND is the absence of an attempt, MISSING is its result.
 */

import { BINDING } from './currency.mjs';

export const REBIND_NOTICE = Object.freeze({
    /** Matched by content under a different name than the manifest remembers. */
    RENAMED: 'RENAMED',
    /** More than one selected file has this Source's exact content. */
    REDUNDANT_COPY: 'REDUNDANT_COPY',
});

/**
 * The comparison a name hint is made under.
 *
 * NFC because macOS hands out decomposed names and Windows composed ones for
 * the same file; case-folded because the file systems most of these files live
 * on do not distinguish case. It is a hint, so erring towards "these might be
 * the same" costs a question and erring the other way costs a missed one.
 */
export const nameKey = (name) => name.normalize('NFC').toLowerCase();

/**
 * Decide every Source's binding from the files selected so far.
 *
 * `sources` are the live manifest entries. `candidates` are
 * `{ candidateId, name, byteLength, sha256 }` -- one per selected file, already
 * fingerprinted. `assignments` are a person's explicit "this file is that
 * Source" choices, `{ sourceId, candidateId }`, which resolve an AMBIGUOUS or
 * MISSING Source into CHANGED (never into MATCHED: only the fingerprint does
 * that).
 *
 * An empty candidate list means no pass has been made, and everything stays
 * UNBOUND.
 */
export function planRebind(sources, candidates, assignments = []) {
    const result = new Map();
    const notices = [];

    if (candidates.length === 0) {
        for (const source of sources) result.set(source.id, { state: BINDING.UNBOUND, candidateId: null, nominees: [] });
        return { bindings: result, notices, unassignedCandidates: [] };
    }

    const bySha = new Map();
    for (const candidate of candidates) {
        if (!bySha.has(candidate.sha256)) bySha.set(candidate.sha256, []);
        bySha.get(candidate.sha256).push(candidate);
    }

    // Pass 1 -- the rule. Fingerprint equality, and nothing else.
    const used = new Set();
    const unmatched = [];
    for (const source of sources) {
        const same = bySha.get(source.fingerprint.sha256);
        if (!same) { unmatched.push(source); continue; }
        // Identical bytes are interchangeable, so which copy is bound cannot
        // matter; the first is taken and the rest are reported, not bound twice.
        const chosen = same[0];
        for (const copy of same) used.add(copy.candidateId);
        result.set(source.id, { state: BINDING.MATCHED, candidateId: chosen.candidateId, nominees: [] });
        if (nameKey(chosen.name) !== nameKey(source.displayName)) {
            notices.push({ code: REBIND_NOTICE.RENAMED, sourceId: source.id, candidateId: chosen.candidateId });
        }
        if (same.length > 1) {
            notices.push({ code: REBIND_NOTICE.REDUNDANT_COPY, sourceId: source.id, candidateIds: same.map((c) => c.candidateId) });
        }
    }

    // A person's explicit assignments come before any hint.
    const free = new Map(candidates.filter((c) => !used.has(c.candidateId)).map((c) => [c.candidateId, c]));
    const stillUnmatched = [];
    const assignedTo = new Map(assignments.map((a) => [a.sourceId, a.candidateId]));
    for (const source of unmatched) {
        const candidateId = assignedTo.get(source.id);
        if (candidateId !== undefined && free.has(candidateId)) {
            result.set(source.id, { state: BINDING.CHANGED, candidateId, nominees: [candidateId], nominatedBy: 'HUMAN' });
            free.delete(candidateId);
        } else stillUnmatched.push(source);
    }

    // Pass 2 -- the hint. A nomination counts only if it is unique both ways:
    // one free file with this Source's name, and no other unmatched Source
    // that the same file could equally be nominated for.
    const filesByName = new Map();
    for (const candidate of free.values()) {
        const key = nameKey(candidate.name);
        if (!filesByName.has(key)) filesByName.set(key, []);
        filesByName.get(key).push(candidate);
    }
    const sourcesByName = new Map();
    for (const source of stillUnmatched) {
        const key = nameKey(source.displayName);
        if (!sourcesByName.has(key)) sourcesByName.set(key, []);
        sourcesByName.get(key).push(source);
    }
    const nominated = new Set();
    for (const source of stillUnmatched) {
        const key = nameKey(source.displayName);
        const files = filesByName.get(key) ?? [];
        const rivals = sourcesByName.get(key);
        if (files.length === 0) {
            result.set(source.id, { state: BINDING.MISSING, candidateId: null, nominees: [] });
        } else if (files.length === 1 && rivals.length === 1) {
            result.set(source.id, { state: BINDING.CHANGED, candidateId: files[0].candidateId, nominees: [files[0].candidateId], nominatedBy: 'NAME' });
            nominated.add(files[0].candidateId);
        } else {
            result.set(source.id, { state: BINDING.AMBIGUOUS, candidateId: null, nominees: files.map((f) => f.candidateId) });
            for (const file of files) nominated.add(file.candidateId);
        }
    }

    // Files that are neither a Source's content nor nominated for one. They
    // are not errors: a person may add one as a new Source or assign it.
    const unassignedCandidates = [...free.values()].filter((c) => !nominated.has(c.candidateId)).map((c) => c.candidateId);
    return { bindings: result, notices, unassignedCandidates };
}

/** Just the states, in the shape `currency.mjs` and `qa-rules.mjs` read. */
export const bindingStates = (plan) => new Map([...plan.bindings].map(([sourceId, binding]) => [sourceId, binding.state]));

/**
 * Which selected files have to be fingerprinted at all.
 *
 * A file whose size no Source has cannot have a Source's fingerprint, so it
 * cannot be MATCHED and its bytes need not be read to know that. It may still
 * be nominated by name, and it is fingerprinted then -- when a person accepts
 * it -- rather than up front.
 */
export function candidatesWorthHashing(sources, files) {
    const sizes = new Set(sources.map((s) => s.fingerprint.byteLength));
    return files.filter((file) => sizes.has(file.byteLength));
}
