/**
 * M7 Architecture v1 -- CANONICAL semantic relation / lifecycle contract of the
 * Portable Project JSON. Human Architecture Adopted 2026-10-09; published by
 * M7-CAN-01 as a canonical PRE-RELEASE contract (schemaVersion 1; no
 * user-writable format is released until M7-P4).
 *
 * It validates an already structurally valid model: run it only on a value
 * portable-project.schema.json has accepted. It is NOT wired into the
 * Production app -- nothing under src/ imports it -- and runtime integration
 * belongs to later M7 phases, each authorized separately. A change to this file
 * is a canonical contract change and is reviewed before any implementation that
 * depends on it. Everything below this comment is the code reviewed at PR #33
 * exact head e541d1d43db3a73acceb3f8241ef914d59dc77d7, unchanged; provenance and
 * the parity evidence are in README.md and contract-manifest.json.
 *
 * What a schema cannot say about a Portable Project JSON.
 *
 * The schema proves every value has the right shape. This proves the document
 * means something: every identity is unique, every reference lands, and the
 * lifecycle fields tell one consistent story. It runs only on a value the
 * schema has already accepted, so nothing here has to defend against a wrong
 * type or an unbounded collection -- that work is done, once, upstream.
 *
 * One rule shapes the split between a *problem* and a *warning*:
 *
 *   A problem is a state the app could never have written. The file is refused.
 *   A warning is a state the app could have written under an odd circumstance
 *   -- a clock set wrong, most of all. The file is accepted and the oddity is
 *   surfaced as a project-integrity finding (QA10), not swallowed.
 *
 * A file is never repaired. There is no "skip the bad entry" path: an import
 * that quietly drops a dangling decision has changed a review record without
 * anyone deciding to.
 */

export const RELATION_PROBLEM = Object.freeze({
    DUPLICATE_ID: 'REL_DUPLICATE_ID',
    TIMESTAMP_INVALID: 'REL_TIMESTAMP_INVALID',
    LINEAGE: 'REL_LINEAGE',
    FILE_NAME: 'REL_FILE_NAME',
    DUPLICATE_SOURCE_CONTENT: 'REL_DUPLICATE_SOURCE_CONTENT',
    RECT_INVALID: 'REL_RECT_INVALID',
    DANGLING_SOURCE: 'REL_DANGLING_SOURCE',
    DANGLING_SHEET: 'REL_DANGLING_SHEET',
    DANGLING_PROFILE: 'REL_DANGLING_PROFILE',
    DANGLING_RUN: 'REL_DANGLING_RUN',
    DANGLING_FINDING: 'REL_DANGLING_FINDING',
    DANGLING_REGISTER_ENTRY: 'REL_DANGLING_REGISTER_ENTRY',
    REGISTER: 'REL_REGISTER',
    RUN_KIND: 'REL_RUN_KIND',
    RUN_STATE: 'REL_RUN_STATE',
    PROFILE_REVISION: 'REL_PROFILE_REVISION',
    DUPLICATE_SHEET_PAGE: 'REL_DUPLICATE_SHEET_PAGE',
    RETIRED_STATE: 'REL_RETIRED_STATE',
    FINDING_SUBJECT: 'REL_FINDING_SUBJECT',
    FINDING_LIFECYCLE: 'REL_FINDING_LIFECYCLE',
    FINDING_KEY_NOT_UNIQUE: 'REL_FINDING_KEY_NOT_UNIQUE',
    SUPERSEDE_CHAIN: 'REL_SUPERSEDE_CHAIN',
    DECISION_SEQUENCE: 'REL_DECISION_SEQUENCE',
    DECISION_EVIDENCE: 'REL_DECISION_EVIDENCE',
});

export const RELATION_WARNING = Object.freeze({
    TIMESTAMP_IN_FUTURE: 'WARN_TIMESTAMP_IN_FUTURE',
    TIMESTAMP_ORDER: 'WARN_TIMESTAMP_ORDER',
});

/** Clocks differ between machines; this much lead is not worth a warning. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const MIN_YEAR = 2000;
const MAX_YEAR = 2199;
const GEOMETRY_EPSILON_PT = 0.01;

class Report {
    constructor(maxProblems) {
        this.maxProblems = maxProblems;
        this.problems = [];
        this.warnings = [];
    }

    get full() { return this.problems.length >= this.maxProblems; }

    problem(code, path, message) {
        if (!this.full) this.problems.push({ code, path, message });
    }

    warn(code, path, message) {
        // Warnings are bounded too: a hostile file must not buy an unbounded list.
        if (this.warnings.length < this.maxProblems) this.warnings.push({ code, path, message });
    }
}

/**
 * Check everything relational about an already schema-valid project.
 *
 * `now` is injected (epoch ms). Nothing in validation reads the clock itself,
 * so the same file gives the same verdict in a test and in a browser.
 */
export function checkRelations(project, { now, maxProblems = 20 } = {}) {
    if (!Number.isFinite(now)) throw new TypeError('checkRelations needs now (epoch ms)');
    const report = new Report(maxProblems);
    const set = project.drawingSet;

    // -- timestamps ---------------------------------------------------------
    let latest = -Infinity;
    const timestamp = (value, path) => {
        const ms = Date.parse(value);
        // The pattern admits 2026-13-45; only a round trip proves a real instant.
        if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
            report.problem(RELATION_PROBLEM.TIMESTAMP_INVALID, path, 'not a real UTC instant');
            return NaN;
        }
        const year = new Date(ms).getUTCFullYear();
        if (year < MIN_YEAR || year > MAX_YEAR) {
            report.problem(RELATION_PROBLEM.TIMESTAMP_INVALID, path, `year outside ${MIN_YEAR}..${MAX_YEAR}`);
            return NaN;
        }
        if (ms > now + CLOCK_SKEW_MS) report.warn(RELATION_WARNING.TIMESTAMP_IN_FUTURE, path, 'later than this machine\'s clock');
        if (ms > latest) latest = ms;
        return ms;
    };
    const optionalTimestamp = (value, path) => (value === null ? NaN : timestamp(value, path));
    const ordered = (earlier, later, path, what) => {
        if (Number.isFinite(earlier) && Number.isFinite(later) && later < earlier) {
            report.warn(RELATION_WARNING.TIMESTAMP_ORDER, path, what);
        }
    };

    // -- identities: one namespace across every entity ---------------------
    const owners = new Map();
    const claim = (id, path) => {
        if (owners.has(id)) report.problem(RELATION_PROBLEM.DUPLICATE_ID, path, `id already used at ${owners.get(id)}`);
        else owners.set(id, path);
    };

    claim(project.projectFileId, '/projectFileId');
    claim(project.project.id, '/project/id');
    claim(set.id, '/drawingSet/id');

    // -- envelope -----------------------------------------------------------
    const savedAt = timestamp(project.savedAt, '/savedAt');
    timestamp(project.project.createdAt, '/project/createdAt');
    timestamp(set.createdAt, '/drawingSet/createdAt');

    const { lineage } = project;
    if ((lineage.saveSequence === 1) !== (lineage.previousProjectFileId === null)) {
        report.problem(RELATION_PROBLEM.LINEAGE, '/lineage', 'the first save, and only the first, has no previous file');
    }
    if (lineage.previousProjectFileId === project.projectFileId) {
        report.problem(RELATION_PROBLEM.LINEAGE, '/lineage/previousProjectFileId', 'a file cannot be saved from itself');
    }
    if (lineage.migratedFrom) {
        timestamp(lineage.migratedFrom.migratedAt, '/lineage/migratedFrom/migratedAt');
        if (lineage.migratedFrom.schemaVersion >= project.schemaVersion) {
            report.problem(RELATION_PROBLEM.LINEAGE, '/lineage/migratedFrom/schemaVersion', 'a migration only moves forward');
        }
    }

    // -- sources ------------------------------------------------------------
    const sources = new Map();
    const contentOwners = new Map();
    set.sources.forEach((source, i) => {
        const path = `/drawingSet/sources/${i}`;
        claim(source.id, `${path}/id`);
        sources.set(source.id, source);
        timestamp(source.addedAt, `${path}/addedAt`);
        optionalTimestamp(source.retiredAt, `${path}/retiredAt`);
        timestamp(source.fingerprint.recordedAt, `${path}/fingerprint/recordedAt`);
        if (source.displayName === '.' || source.displayName === '..' || source.displayName.trim() === '') {
            report.problem(RELATION_PROBLEM.FILE_NAME, `${path}/displayName`, 'not a file name');
        }
        // Two live slots for one byte sequence would make every sheet of it a
        // duplicate of itself and leave rebinding nothing to tell them apart by.
        if (source.retiredAt === null) {
            const sha = source.fingerprint.sha256;
            if (contentOwners.has(sha)) {
                report.problem(RELATION_PROBLEM.DUPLICATE_SOURCE_CONTENT, `${path}/fingerprint/sha256`, `same content as ${contentOwners.get(sha)}`);
            } else contentOwners.set(sha, path);
        }
        source.fingerprintHistory.forEach((retired, j) => {
            timestamp(retired.retiredAt, `${path}/fingerprintHistory/${j}/retiredAt`);
            timestamp(retired.fingerprint.recordedAt, `${path}/fingerprintHistory/${j}/fingerprint/recordedAt`);
        });
    });

    // -- profiles -----------------------------------------------------------
    const profiles = new Map();
    set.titleBlockProfiles.forEach((profile, i) => {
        const path = `/drawingSet/titleBlockProfiles/${i}`;
        claim(profile.id, `${path}/id`);
        profiles.set(profile.id, profile);
        const createdAt = timestamp(profile.createdAt, `${path}/createdAt`);
        const updatedAt = timestamp(profile.updatedAt, `${path}/updatedAt`);
        optionalTimestamp(profile.retiredAt, `${path}/retiredAt`);
        ordered(createdAt, updatedAt, `${path}/updatedAt`, 'updated before it was created');
        const { uprightWidthPt: width, uprightHeightPt: height } = profile.referencePage;
        if (!(width > 0) || !(height > 0)) {
            report.problem(RELATION_PROBLEM.RECT_INVALID, `${path}/referencePage`, 'a reference page has a positive size');
        }
        for (const name of Object.keys(profile.fields)) {
            const rect = profile.fields[name];
            const inside = rect.left >= 0 && rect.top >= 0
                && rect.right <= width + GEOMETRY_EPSILON_PT && rect.bottom <= height + GEOMETRY_EPSILON_PT;
            if (!(rect.left < rect.right) || !(rect.top < rect.bottom) || !inside) {
                report.problem(RELATION_PROBLEM.RECT_INVALID, `${path}/fields/${name}`, 'a field rectangle is non-empty and lies on its reference page');
            }
        }
    });

    // -- runs ---------------------------------------------------------------
    const runs = new Map();
    set.analysisRuns.forEach((run, i) => {
        const path = `/drawingSet/analysisRuns/${i}`;
        claim(run.id, `${path}/id`);
        runs.set(run.id, run);
        const startedAt = timestamp(run.startedAt, `${path}/startedAt`);
        const completedAt = optionalTimestamp(run.completedAt, `${path}/completedAt`);
        ordered(startedAt, completedAt, `${path}/completedAt`, 'completed before it started');
        if (run.outcome === 'COMPLETED' && run.completedAt === null) {
            report.problem(RELATION_PROBLEM.RUN_STATE, path, 'a completed run records when it completed');
        }
        const expected = run.kind === 'QA' ? 'drawing-set-qa' : 'register-extraction';
        if (run.engine.name !== expected) report.problem(RELATION_PROBLEM.RUN_KIND, `${path}/engine/name`, `a ${run.kind} run is produced by ${expected}`);
    });

    const profileBasis = (basis, path) => {
        const profile = profiles.get(basis.profileId);
        if (!profile) { report.problem(RELATION_PROBLEM.DANGLING_PROFILE, `${path}/profileId`, 'no such profile'); return; }
        if (basis.profileRevision > profile.revision) {
            report.problem(RELATION_PROBLEM.PROFILE_REVISION, `${path}/profileRevision`, 'read under a profile revision that does not exist yet');
        }
    };

    // -- sheets -------------------------------------------------------------
    const sheets = new Map();
    const livePages = new Set();
    set.sheets.forEach((sheet, i) => {
        if (report.full) return;
        const path = `/drawingSet/sheets/${i}`;
        claim(sheet.id, `${path}/id`);
        sheets.set(sheet.id, sheet);
        timestamp(sheet.createdAt, `${path}/createdAt`);
        optionalTimestamp(sheet.retiredAt, `${path}/retiredAt`);

        const source = sources.get(sheet.sourceId);
        if (!source) report.problem(RELATION_PROBLEM.DANGLING_SOURCE, `${path}/sourceId`, 'no such source');
        else if (source.retiredAt !== null && sheet.retiredAt === null) {
            report.problem(RELATION_PROBLEM.RETIRED_STATE, `${path}/retiredAt`, 'a sheet of a retired source is retired');
        }
        if (sheet.retiredAt === null) {
            const page = `${sheet.sourceId}#${sheet.pageNumber}`;
            if (livePages.has(page)) report.problem(RELATION_PROBLEM.DUPLICATE_SHEET_PAGE, `${path}/pageNumber`, 'another live sheet is already this page');
            livePages.add(page);
        }

        if (sheet.profileAssignment) {
            const assigned = profiles.get(sheet.profileAssignment.profileId);
            if (!assigned) {
                report.problem(RELATION_PROBLEM.DANGLING_PROFILE, `${path}/profileAssignment/profileId`, 'no such profile');
            } else if (assigned.retiredAt !== null && sheet.retiredAt === null) {
                report.problem(RELATION_PROBLEM.RETIRED_STATE, `${path}/profileAssignment/profileId`, 'a live sheet is not assigned to a retired profile');
            }
            timestamp(sheet.profileAssignment.confirmedAt, `${path}/profileAssignment/confirmedAt`);
        }
        if (sheet.observation) {
            const run = runs.get(sheet.observation.runId);
            if (!run) report.problem(RELATION_PROBLEM.DANGLING_RUN, `${path}/observation/runId`, 'no such run');
            else if (run.kind !== 'EXTRACTION') report.problem(RELATION_PROBLEM.RUN_KIND, `${path}/observation/runId`, 'an observation comes from an extraction run');
            profileBasis(sheet.observation.profile, `${path}/observation/profile`);
        }
        if (sheet.confirmation) {
            timestamp(sheet.confirmation.confirmedAt, `${path}/confirmation/confirmedAt`);
            if (sheet.confirmation.profile) profileBasis(sheet.confirmation.profile, `${path}/confirmation/profile`);
        }
        sheet.confirmationHistory.forEach((retired, j) => {
            const at = `${path}/confirmationHistory/${j}`;
            timestamp(retired.retiredAt, `${at}/retiredAt`);
            timestamp(retired.confirmation.confirmedAt, `${at}/confirmation/confirmedAt`);
            if (retired.confirmation.profile) profileBasis(retired.confirmation.profile, `${at}/confirmation/profile`);
        });
    });

    // -- declared Drawing Registers -----------------------------------------
    const registerEntries = new Map();
    set.drawingRegisterReferences.forEach((reference, i) => {
        if (report.full) return;
        const path = `/drawingSet/drawingRegisterReferences/${i}`;
        claim(reference.id, `${path}/id`);
        const declaredAt = timestamp(reference.declaredAt, `${path}/declaredAt`);
        const updatedAt = timestamp(reference.updatedAt, `${path}/updatedAt`);
        ordered(declaredAt, updatedAt, `${path}/updatedAt`, 'updated before it was declared');
        optionalTimestamp(reference.retiredAt, `${path}/retiredAt`);
        const source = sources.get(reference.sourceId);
        if (!source) report.problem(RELATION_PROBLEM.DANGLING_SOURCE, `${path}/sourceId`, 'no such source');
        else if (source.retiredAt !== null && reference.retiredAt === null) {
            report.problem(RELATION_PROBLEM.RETIRED_STATE, `${path}/retiredAt`, 'a register declared from a retired source is retired');
        }
        // A register read from a table says where the table was; one a person typed need not.
        if (reference.method === 'TABLE_NATIVE' && reference.region === null) {
            report.problem(RELATION_PROBLEM.REGISTER, `${path}/region`, 'a register read from a table records where the table was');
        }
        if (reference.region && (!(reference.region.left < reference.region.right) || !(reference.region.top < reference.region.bottom))) {
            report.problem(RELATION_PROBLEM.RECT_INVALID, `${path}/region`, 'a region is a non-empty rectangle');
        }
        const rows = new Set();
        reference.entries.forEach((entry, j) => {
            const at = `${path}/entries/${j}`;
            claim(entry.id, `${at}/id`);
            registerEntries.set(entry.id, entry);
            optionalTimestamp(entry.retiredAt, `${at}/retiredAt`);
            if (entry.drawingNumber.trim() === '') report.problem(RELATION_PROBLEM.REGISTER, `${at}/drawingNumber`, 'a register entry names a drawing');
            if (rows.has(entry.row)) report.problem(RELATION_PROBLEM.REGISTER, `${at}/row`, 'two entries of one register share a row');
            rows.add(entry.row);
        });
    });

    // -- findings -----------------------------------------------------------
    const findings = new Map();
    const activeKeys = new Map();
    const findingCreated = new Map();
    set.findings.forEach((finding, i) => {
        if (report.full) return;
        const path = `/drawingSet/findings/${i}`;
        claim(finding.id, `${path}/id`);
        findings.set(finding.id, finding);
        findingCreated.set(finding.id, timestamp(finding.createdAt, `${path}/createdAt`));

        const run = runs.get(finding.runId);
        if (!run) report.problem(RELATION_PROBLEM.DANGLING_RUN, `${path}/runId`, 'no such run');
        else if (run.kind !== 'QA') report.problem(RELATION_PROBLEM.RUN_KIND, `${path}/runId`, 'a finding comes from a QA run');

        const unique = (ids, at, exists, code) => {
            const seen = new Set();
            ids.forEach((id, j) => {
                if (!exists(id)) report.problem(code, `${path}/${at}/${j}`, 'no such entity');
                if (seen.has(id)) report.problem(RELATION_PROBLEM.FINDING_SUBJECT, `${path}/${at}/${j}`, 'listed twice');
                seen.add(id);
            });
        };
        unique(finding.sheetIds, 'sheetIds', (id) => sheets.has(id), RELATION_PROBLEM.DANGLING_SHEET);
        unique(finding.sourceIds, 'sourceIds', (id) => sources.has(id), RELATION_PROBLEM.DANGLING_SOURCE);
        unique(finding.registerEntryIds, 'registerEntryIds', (id) => registerEntries.has(id), RELATION_PROBLEM.DANGLING_REGISTER_ENTRY);
        unique(finding.basis.map((b) => b.sourceId), 'basis', (id) => sources.has(id), RELATION_PROBLEM.DANGLING_SOURCE);

        const sheetCount = finding.sheetIds.length;
        const subjectOk = {
            SHEET: sheetCount === 1,
            SHEET_GROUP: sheetCount >= 1,
            SET: true,
            SOURCE: finding.sourceIds.length >= 1,
            REGISTER_ENTRY: finding.registerEntryIds.length >= 1,
            PROJECT: true,
        }[finding.scope];
        if (!subjectOk) report.problem(RELATION_PROBLEM.FINDING_SUBJECT, `${path}/scope`, 'the subjects do not fit the scope');

        const life = finding.lifecycle;
        optionalTimestamp(life.closedAt, `${path}/lifecycle/closedAt`);
        const closed = life.closedByRunId !== null && life.closedAt !== null;
        const open = life.closedByRunId === null && life.closedAt === null;
        const consistent = {
            ACTIVE: open && life.supersededByFindingId === null,
            SUPERSEDED: closed && life.supersededByFindingId !== null,
            NOT_REPRODUCED: closed && life.supersededByFindingId === null,
        }[life.state];
        if (!consistent) report.problem(RELATION_PROBLEM.FINDING_LIFECYCLE, `${path}/lifecycle`, 'the lifecycle fields contradict the state');
        if (life.closedByRunId !== null) {
            const closer = runs.get(life.closedByRunId);
            if (!closer) report.problem(RELATION_PROBLEM.DANGLING_RUN, `${path}/lifecycle/closedByRunId`, 'no such run');
            else if (closer.kind !== 'QA') report.problem(RELATION_PROBLEM.RUN_KIND, `${path}/lifecycle/closedByRunId`, 'only a QA run closes a finding');
        }
        if (life.state === 'ACTIVE') {
            // One live statement per key. Two would be two answers to one question.
            if (activeKeys.has(finding.findingKey)) {
                report.problem(RELATION_PROBLEM.FINDING_KEY_NOT_UNIQUE, `${path}/findingKey`, `already active at ${activeKeys.get(finding.findingKey)}`);
            } else activeKeys.set(finding.findingKey, path);
        }
    });

    // A superseded finding points at a later statement of the same question,
    // and following the pointers always ends.
    set.findings.forEach((finding, i) => {
        if (report.full) return;
        const nextId = finding.lifecycle.supersededByFindingId;
        if (nextId === null) return;
        const path = `/drawingSet/findings/${i}/lifecycle/supersededByFindingId`;
        const next = findings.get(nextId);
        if (!next) { report.problem(RELATION_PROBLEM.DANGLING_FINDING, path, 'no such finding'); return; }
        if (next.findingKey !== finding.findingKey || next.ruleId !== finding.ruleId) {
            report.problem(RELATION_PROBLEM.SUPERSEDE_CHAIN, path, 'superseded by a finding about something else');
        }
    });
    const chainState = new Map(); // id -> 1 (on the current walk) | 2 (proven to end)
    for (const start of findings.values()) {
        if (report.full) break;
        const walk = [];
        let cursor = start;
        while (cursor && !chainState.has(cursor.id)) {
            chainState.set(cursor.id, 1);
            walk.push(cursor.id);
            cursor = cursor.lifecycle.supersededByFindingId === null ? null : findings.get(cursor.lifecycle.supersededByFindingId);
        }
        if (cursor && chainState.get(cursor.id) === 1) {
            report.problem(RELATION_PROBLEM.SUPERSEDE_CHAIN, '/drawingSet/findings', `supersession loops through ${cursor.id}`);
        }
        for (const id of walk) chainState.set(id, 2);
    }

    // -- decisions ----------------------------------------------------------
    const sequences = new Map();
    set.decisions.forEach((decision, i) => {
        if (report.full) return;
        const path = `/drawingSet/decisions/${i}`;
        claim(decision.id, `${path}/id`);
        const decidedAt = timestamp(decision.decidedAt, `${path}/decidedAt`);
        const finding = findings.get(decision.findingId);
        if (!finding) { report.problem(RELATION_PROBLEM.DANGLING_FINDING, `${path}/findingId`, 'no such finding'); return; }
        // A decision is about one exact statement. If the digests differ, the
        // decision was made about evidence this finding does not carry.
        if (decision.evidenceDigest !== finding.evidenceDigest) {
            report.problem(RELATION_PROBLEM.DECISION_EVIDENCE, `${path}/evidenceDigest`, 'decided on different evidence than the finding states');
        }
        ordered(findingCreated.get(finding.id), decidedAt, `${path}/decidedAt`, 'decided before the finding existed');
        if (!sequences.has(decision.findingId)) sequences.set(decision.findingId, []);
        sequences.get(decision.findingId).push(decision.sequence);
    });
    for (const [findingId, list] of sequences) {
        if (report.full) break;
        list.sort((a, b) => a - b);
        // 1..n with no gap and no repeat: the history is complete and ordered.
        if (list.some((sequence, index) => sequence !== index + 1)) {
            report.problem(RELATION_PROBLEM.DECISION_SEQUENCE, '/drawingSet/decisions', `decisions for ${findingId} are not numbered 1..${list.length}`);
        }
    }

    if (Number.isFinite(savedAt) && latest > savedAt) {
        report.warn(RELATION_WARNING.TIMESTAMP_ORDER, '/savedAt', 'something in the file is dated after the file was saved');
    }

    return { problems: report.problems, warnings: report.warnings };
}
