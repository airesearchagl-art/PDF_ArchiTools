/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The handful of operations that change a Project, written out so the lifecycle
 * rules can be tested rather than described.
 *
 * The in-memory model has the same shape as the Portable Project JSON. That is
 * a deliberate simplification for a research prototype -- it means "what would
 * be saved" is never a separate question -- and it holds only because runtime
 * state (which File a Source is bound to, pdf.js documents, canvases) is kept
 * outside the model entirely. The writer's allow-list would drop it anyway; not
 * putting it here means nothing depends on that.
 *
 * Nothing in this file deletes. A Source or Sheet a person removes is retired;
 * a confirmation that is replaced moves to history; a fingerprint that is
 * replaced moves to history. The record of what was once believed is part of
 * what a Project is.
 */

import { toTimestamp } from './ids.mjs';
import { sha256HexOfText } from './sha256-stream.mjs';

export const FIELD_NAMES = Object.freeze(['drawingNumber', 'drawingTitle', 'revision', 'issueDate']);

/** How the existing Drawing Register engine names the same four fields. */
export const REGISTER_FIELD_BY_NAME = Object.freeze({
    drawingNumber: 'drawing_number',
    drawingTitle: 'drawing_title',
    revision: 'revision',
    issueDate: 'revision_date',
});

const FORBIDDEN_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
const FORBIDDEN_MULTI_LINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
const LONE_SURROGATE = /\p{Surrogate}/gu;

/**
 * Bring text read from a PDF into the domain the schema accepts.
 *
 * A PDF's text layer can hold anything, and the writer refuses a document its
 * own reader would refuse. Without this the first sheet whose title block
 * carries a control character would make the whole Project unsaveable. The
 * transformation is fixed and lossy in one direction only: forbidden characters
 * become a space, the result is cut to the field's bound. It is applied where
 * machine text enters the model and nowhere else.
 */
export function sanitizeSingleLine(text, maxLength) {
    const cleaned = String(text).replace(LONE_SURROGATE, '\uFFFD').replace(FORBIDDEN_SINGLE_LINE, ' ').trim();
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

export function sanitizeMultiLine(text, maxLength) {
    const cleaned = String(text).replace(/\r\n?/g, '\n').replace(LONE_SURROGATE, '\uFFFD').replace(FORBIDDEN_MULTI_LINE, ' ');
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * A display label from `File.name`.
 *
 * `File.name` is a bare name in every browser, but a name that is legal on one
 * system can contain another system's separator. Whatever arrives, what is
 * stored cannot be read as a path: separators and the drive colon become `_`.
 * The label is a hint for a person and for rebinding, never identity, so losing
 * a character here loses nothing that is relied on.
 */
export function sanitizeDisplayName(name, maxLength = 255) {
    let cleaned = sanitizeSingleLine(name, 4 * maxLength).replace(/[/\\:]/g, '_');
    if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
    if (cleaned === '' || cleaned === '.' || cleaned === '..') cleaned = '_';
    return cleaned;
}

export function newProject({ name, drawingSetName = name, toolVersion = '0.0.0-research', now, newId }) {
    const at = toTimestamp(now);
    return {
        format: 'pdf-architools/drawing-set-project',
        schemaVersion: 1,
        projectFileId: null,
        lineage: null,
        savedAt: null,
        writer: { app: 'PDF_ArchiTools', toolVersion },
        project: { id: newId(), name, createdAt: at },
        drawingSet: {
            id: newId(), name: drawingSetName, createdAt: at,
            sources: [], titleBlockProfiles: [], sheets: [], analysisRuns: [], findings: [], decisions: [],
        },
    };
}

export const liveSources = (model) => model.drawingSet.sources.filter((s) => s.retiredAt === null);
export const liveSheets = (model) => model.drawingSet.sheets.filter((s) => s.retiredAt === null);

function newSheet(sourceId, pageNumber, now, newId) {
    return {
        id: newId(), sourceId, pageNumber, createdAt: toTimestamp(now), retiredAt: null,
        pageFacts: null, profileAssignment: null, observation: null, confirmation: null, confirmationHistory: [],
    };
}

/**
 * Add a Source and one Sheet per page.
 *
 * Content already in the set is refused, by fingerprint. The same bytes twice
 * is one document, and admitting it as two would manufacture a duplicate for
 * every sheet and leave rebinding nothing to tell the two slots apart by.
 */
export function addSource(model, { displayName, sha256, byteLength, pageCount, now, newId }) {
    const existing = liveSources(model).find((s) => s.fingerprint.sha256 === sha256);
    if (existing) return { ok: false, code: 'DUPLICATE_CONTENT', existingSourceId: existing.id };
    const at = toTimestamp(now);
    const source = {
        id: newId(), displayName: sanitizeDisplayName(displayName), addedAt: at, retiredAt: null,
        fingerprint: { algorithm: 'SHA-256', sha256, byteLength, pageCount, recordedAt: at },
        fingerprintHistory: [],
    };
    model.drawingSet.sources.push(source);
    const sheets = [];
    for (let page = 1; page <= pageCount; page += 1) {
        const sheet = newSheet(source.id, page, now, newId);
        model.drawingSet.sheets.push(sheet);
        sheets.push(sheet);
    }
    return { ok: true, source, sheets };
}

/**
 * Accept different bytes as the new content of an existing Source.
 *
 * This is a decision only a person makes (rebinding-state-machine.md, CHANGED).
 * It moves the old fingerprint to history and installs the new one. It does not
 * touch a single sheet's data: every observation, confirmation and finding that
 * was read from the old bytes still says so, and from this moment the mismatch
 * is what makes it stale. Pages the new file adds get new Sheets; Sheets whose
 * page no longer exists are left for a person, and QA09 reports them.
 */
export function replaceSourceFingerprint(model, sourceId, { sha256, byteLength, pageCount, now, newId }) {
    const source = model.drawingSet.sources.find((s) => s.id === sourceId);
    if (!source || source.retiredAt !== null) return { ok: false, code: 'NO_SUCH_SOURCE' };
    if (source.fingerprint.sha256 === sha256) return { ok: false, code: 'SAME_CONTENT' };
    const clash = liveSources(model).find((s) => s.id !== sourceId && s.fingerprint.sha256 === sha256);
    if (clash) return { ok: false, code: 'DUPLICATE_CONTENT', existingSourceId: clash.id };
    const at = toTimestamp(now);
    source.fingerprintHistory.push({ fingerprint: source.fingerprint, retiredAt: at, reason: 'REPLACED_BY_HUMAN' });
    source.fingerprint = { algorithm: 'SHA-256', sha256, byteLength, pageCount, recordedAt: at };
    const present = new Set(liveSheets(model).filter((s) => s.sourceId === sourceId).map((s) => s.pageNumber));
    const added = [];
    for (let page = 1; page <= pageCount; page += 1) {
        if (present.has(page)) continue;
        const sheet = newSheet(sourceId, page, now, newId);
        model.drawingSet.sheets.push(sheet);
        added.push(sheet);
    }
    return { ok: true, source, addedSheets: added };
}

export function retireSource(model, sourceId, now) {
    const source = model.drawingSet.sources.find((s) => s.id === sourceId);
    if (!source || source.retiredAt !== null) return { ok: false, code: 'NO_SUCH_SOURCE' };
    const at = toTimestamp(now);
    source.retiredAt = at;
    for (const sheet of model.drawingSet.sheets) {
        if (sheet.sourceId === sourceId && sheet.retiredAt === null) sheet.retiredAt = at;
    }
    return { ok: true };
}

export function retireSheet(model, sheetId, now) {
    const sheet = model.drawingSet.sheets.find((s) => s.id === sheetId);
    if (!sheet || sheet.retiredAt !== null) return { ok: false, code: 'NO_SUCH_SHEET' };
    sheet.retiredAt = toTimestamp(now);
    return { ok: true };
}

export function addProfile(model, { name, transferModel, referencePage, fields, now, newId }) {
    const at = toTimestamp(now);
    const profile = {
        id: newId(), name, revision: 1, transferModel,
        referencePage: { ...referencePage },
        fields: Object.fromEntries(FIELD_NAMES.map((f) => [f, { ...fields[f] }])),
        createdAt: at, updatedAt: at, retiredAt: null,
    };
    model.drawingSet.titleBlockProfiles.push(profile);
    return profile;
}

/** Any change to what a profile reads counts: the revision is the arrangement. */
export function updateProfile(model, profileId, changes, now) {
    const profile = model.drawingSet.titleBlockProfiles.find((p) => p.id === profileId);
    if (!profile) return { ok: false, code: 'NO_SUCH_PROFILE' };
    if (changes.transferModel) profile.transferModel = changes.transferModel;
    if (changes.referencePage) profile.referencePage = { ...changes.referencePage };
    if (changes.fields) for (const f of FIELD_NAMES) if (changes.fields[f]) profile.fields[f] = { ...changes.fields[f] };
    if (changes.name) profile.name = changes.name;
    const geometryChanged = !!(changes.transferModel || changes.referencePage || changes.fields);
    if (geometryChanged) profile.revision += 1;
    profile.updatedAt = toTimestamp(now);
    return { ok: true, profile, geometryChanged };
}

/**
 * Retire a profile.
 *
 * Its sheets lose their assignment -- which makes what was read under it stale,
 * exactly as moving them to another profile would -- and the profile itself
 * stays in the file, because observations, confirmations and their history
 * still say they were made under it.
 */
export function retireProfile(model, profileId, now) {
    const profile = model.drawingSet.titleBlockProfiles.find((p) => p.id === profileId);
    if (!profile || profile.retiredAt !== null) return { ok: false, code: 'NO_SUCH_PROFILE' };
    profile.retiredAt = toTimestamp(now);
    const unassigned = [];
    for (const sheet of model.drawingSet.sheets) {
        if (sheet.profileAssignment?.profileId === profileId) { sheet.profileAssignment = null; unassigned.push(sheet.id); }
    }
    return { ok: true, unassignedSheetIds: unassigned };
}

export function assignProfile(model, sheetIds, profileId, now) {
    const wanted = new Set(sheetIds);
    const at = toTimestamp(now);
    for (const sheet of model.drawingSet.sheets) {
        if (wanted.has(sheet.id)) sheet.profileAssignment = profileId === null ? null : { profileId, confirmedAt: at };
    }
}

/**
 * One digest for the whole live manifest.
 *
 * A run has to be bound to the bytes it saw, and listing every Source's
 * fingerprint on every run does not scale: with one PDF per sheet a 5000-sheet
 * set would add ~650 KB to the file per run. The digest binds a run to exactly
 * that set of bytes in 64 characters; the per-record bases say which bytes each
 * individual result cites.
 */
export function manifestDigest(model) {
    const pairs = liveSources(model).map((s) => [s.id, s.fingerprint.sha256]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    return sha256HexOfText(JSON.stringify(pairs));
}

function startRun(model, kind, engineVersion, now, newId, coverage) {
    const at = toTimestamp(now);
    const run = {
        id: newId(), kind, startedAt: at, completedAt: at, outcome: 'COMPLETED',
        engine: { name: kind === 'QA' ? 'drawing-set-qa' : 'register-extraction', version: engineVersion },
        manifestDigest: manifestDigest(model),
        coverage,
    };
    return run;
}

/** Build a QA run record. It joins the model only if a finding comes to refer to it. */
export const draftQaRun = (model, { engineVersion, now, newId, coverage }) => startRun(model, 'QA', engineVersion, now, newId, coverage);

/**
 * Drop runs nothing refers to any more.
 *
 * A run exists in the file to say where a result came from. Once the last
 * observation or finding that names it is gone it explains nothing, and keeping
 * it only grows the file. Human history is untouched: decisions and retired
 * confirmations do not hang off runs.
 */
export function pruneUnreferencedRuns(model) {
    const referenced = new Set();
    for (const sheet of model.drawingSet.sheets) if (sheet.observation) referenced.add(sheet.observation.runId);
    for (const finding of model.drawingSet.findings) {
        referenced.add(finding.runId);
        if (finding.lifecycle.closedByRunId) referenced.add(finding.lifecycle.closedByRunId);
    }
    const before = model.drawingSet.analysisRuns.length;
    model.drawingSet.analysisRuns = model.drawingSet.analysisRuns.filter((run) => referenced.has(run.id));
    return before - model.drawingSet.analysisRuns.length;
}

/**
 * Record what an extraction run read.
 *
 * `results` is what an adapter over the existing register engine would hand
 * over: per sheet, the page facts and the four fields. Each observation is
 * stamped with the bytes and the profile revision it was read under, at the
 * moment it is recorded -- that stamp is the only thing that later says whether
 * it can still be believed.
 */
export function recordExtraction(model, { results, engineVersion, now, newId }) {
    const run = startRun(model, 'EXTRACTION', engineVersion, now, newId, { sheetsEvaluated: results.length, sheetsExcluded: 0 });
    model.drawingSet.analysisRuns.push(run);
    const sheets = new Map(model.drawingSet.sheets.map((s) => [s.id, s]));
    const sources = new Map(model.drawingSet.sources.map((s) => [s.id, s]));
    const profiles = new Map(model.drawingSet.titleBlockProfiles.map((p) => [p.id, p]));
    for (const result of results) {
        const sheet = sheets.get(result.sheetId);
        const sha = sources.get(sheet.sourceId).fingerprint.sha256;
        if (result.pageFacts) sheet.pageFacts = { sourceSha256: sha, ...result.pageFacts };
        if (!result.fields || !sheet.profileAssignment) continue;
        const profile = profiles.get(sheet.profileAssignment.profileId);
        if (!profile) continue;
        sheet.observation = {
            runId: run.id,
            sourceSha256: sha,
            profile: { profileId: profile.id, profileRevision: profile.revision },
            status: result.status ?? 'READ',
            fields: Object.fromEntries(FIELD_NAMES.map((f) => {
                const field = result.fields[f] ?? {};
                return [f, {
                    value: sanitizeSingleLine(field.value ?? '', 300),
                    rawText: sanitizeMultiLine(field.rawText ?? '', 1000),
                    source: field.source ?? 'none',
                    ocrScore: field.ocrScore ?? null,
                }];
            })),
        };
    }
    return run;
}

/**
 * A person confirms a sheet's four values.
 *
 * The confirmation records the bytes and the profile arrangement in force when
 * it was made. An earlier confirmation is not overwritten; it moves to history.
 */
export function confirmSheet(model, sheetId, values, now) {
    const sheet = model.drawingSet.sheets.find((s) => s.id === sheetId);
    if (!sheet || sheet.retiredAt !== null) return { ok: false, code: 'NO_SUCH_SHEET' };
    const source = model.drawingSet.sources.find((s) => s.id === sheet.sourceId);
    const at = toTimestamp(now);
    if (sheet.confirmation) sheet.confirmationHistory.push({ confirmation: sheet.confirmation, retiredAt: at, reason: 'RECONFIRMED' });

    const proposed = sheet.observation ? Object.fromEntries(FIELD_NAMES.map((f) => [f, sheet.observation.fields[f].value])) : null;
    const final = Object.fromEntries(FIELD_NAMES.map((f) => [f, sanitizeSingleLine(values[f] ?? proposed?.[f] ?? '', 300)]));
    let profile = null;
    if (sheet.profileAssignment) {
        const current = model.drawingSet.titleBlockProfiles.find((p) => p.id === sheet.profileAssignment.profileId);
        if (current) profile = { profileId: current.id, profileRevision: current.revision };
    }
    sheet.confirmation = {
        confirmedAt: at,
        sourceSha256: source.fingerprint.sha256,
        profile,
        values: final,
        editedFields: FIELD_NAMES.filter((f) => proposed === null || proposed[f] !== final[f]),
    };
    return { ok: true, sheet };
}

/** A person withdraws a confirmation. It goes to history like any other. */
export function withdrawConfirmation(model, sheetId, now) {
    const sheet = model.drawingSet.sheets.find((s) => s.id === sheetId);
    if (!sheet || !sheet.confirmation) return { ok: false, code: 'NOTHING_TO_WITHDRAW' };
    sheet.confirmationHistory.push({ confirmation: sheet.confirmation, retiredAt: toTimestamp(now), reason: 'WITHDRAWN' });
    sheet.confirmation = null;
    return { ok: true };
}

/**
 * Record a Human decision about one finding.
 *
 * Append-only. The decision carries the evidence digest of the finding it is
 * about, so it is tied to that exact statement and to no later one.
 */
export function decide(model, findingId, { outcome, comment = '', now, newId }) {
    const finding = model.drawingSet.findings.find((f) => f.id === findingId);
    if (!finding) return { ok: false, code: 'NO_SUCH_FINDING' };
    const earlier = model.drawingSet.decisions.filter((d) => d.findingId === findingId).length;
    const decision = {
        id: newId(), findingId, sequence: earlier + 1, outcome,
        comment: sanitizeMultiLine(comment, 4000),
        decidedAt: toTimestamp(now),
        evidenceDigest: finding.evidenceDigest,
    };
    model.drawingSet.decisions.push(decision);
    return { ok: true, decision };
}

/** The decision in force for each finding: the one with the highest sequence. */
export function effectiveDecisions(model) {
    const byFinding = new Map();
    for (const decision of model.drawingSet.decisions) {
        const current = byFinding.get(decision.findingId);
        if (!current || decision.sequence > current.sequence) byFinding.set(decision.findingId, decision);
    }
    return byFinding;
}
