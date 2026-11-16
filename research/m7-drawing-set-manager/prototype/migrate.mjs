/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Opening a Project file of any version: the current one, an old one, a future
 * one, and how the three differ.
 *
 *   current   validated and opened.
 *   future    refused. Not read "as far as it goes", not opened read-only: a
 *             build that has never been told what a field means cannot keep it
 *             safe through a save, and a file it cannot save is not open.
 *   old       never opened directly. It is validated against ITS OWN frozen
 *             schema, converted in memory by a pure function, and the result is
 *             validated again as a current file. A person is shown what was
 *             converted before anything else happens, and the file on disk is
 *             not touched -- the converted Project can only leave as a new file.
 *
 * The old-version path is the reason every version's schema has to be kept, not
 * just the latest: "validate, then migrate" is only as good as the validation.
 *
 * There is no real predecessor of schema version 1, so the mechanism is
 * exercised with a synthetic one. `SYNTHETIC_V0` exists only in this research
 * harness. It differs from v1 in two places chosen to cover both kinds of
 * change -- one in the envelope, one inside an entity -- and it must never be
 * mistaken for a format anything has written.
 */

import { IMPORT_STAGE, parseBounded } from './bounded-json.mjs';
import { CANDIDATE_LIMITS } from './limits.proposed.mjs';
import {
    SUPPORTED_SCHEMA_VERSION, VERSION_REFUSAL, classifyVersion, loadSchema, validateParsed,
} from './project-io.mjs';
import { compileSchema } from './schema-subset.mjs';

/**
 * The synthetic v0 schema, derived from v1 so the two cannot drift by accident.
 *
 *   envelope   `saveSequence` and `previousProjectFileId` sit at the top level;
 *              there is no `lineage` object.
 *   Sheet      pages are `pageIndex`, counted from 0, not `pageNumber` from 1.
 */
export function syntheticV0Schema() {
    const schema = structuredClone(loadSchema());
    schema.title = 'SYNTHETIC predecessor (schemaVersion 0) -- research harness only';
    schema.properties.schemaVersion = { type: 'integer', const: 0, minimum: 0, maximum: 0 };
    delete schema.properties.lineage;
    schema.properties.saveSequence = { type: 'integer', minimum: 1, maximum: 1000000000 };
    schema.properties.previousProjectFileId = { anyOf: [{ type: 'null' }, { $ref: '#/$defs/Uuid' }] };
    schema.required = schema.required.filter((name) => name !== 'lineage').concat(['saveSequence', 'previousProjectFileId']);

    const sheet = schema.$defs.Sheet;
    sheet.properties.pageIndex = { type: 'integer', minimum: 0, maximum: 4999 };
    delete sheet.properties.pageNumber;
    sheet.required = sheet.required.map((name) => (name === 'pageNumber' ? 'pageIndex' : name));
    return schema;
}

/**
 * v0 -> v1, as a pure function of an already v0-valid document.
 *
 * Returns the converted document and a list of what changed, in words a person
 * can be shown. It does not validate its result; the caller does, as v1.
 */
export function migrateV0toV1(old, { now }) {
    const { saveSequence, previousProjectFileId, ...rest } = old;
    const converted = structuredClone(rest);
    converted.schemaVersion = 1;
    converted.lineage = {
        saveSequence,
        previousProjectFileId,
        migratedFrom: { schemaVersion: 0, projectFileId: old.projectFileId, migratedAt: new Date(now).toISOString() },
    };
    let sheets = 0;
    for (const sheet of converted.drawingSet.sheets) {
        sheet.pageNumber = sheet.pageIndex + 1;
        delete sheet.pageIndex;
        sheets += 1;
    }
    return {
        document: converted,
        changes: [
            { code: 'LINEAGE_GROUPED', count: 1, detail: 'save sequence and previous file id moved into "lineage"' },
            { code: 'PAGE_NUMBERING', count: sheets, detail: 'sheet pages renumbered from 0-based to 1-based' },
        ],
    };
}

/** One step per old version. A version with no entry cannot be opened. */
const MIGRATIONS = new Map([
    [0, { to: 1, schema: syntheticV0Schema, migrate: migrateV0toV1 }],
]);

export const OPEN_STATUS = Object.freeze({
    OPENED: 'OPENED',
    MIGRATED_IN_MEMORY: 'MIGRATED_IN_MEMORY',
    REJECTED: 'REJECTED',
});

/**
 * Open a Project file of whatever version it turns out to be.
 *
 * MIGRATED_IN_MEMORY is a distinct outcome on purpose. The caller has a Project
 * it may show, and a report it must show; `project.lineage.migratedFrom` is
 * set, so the next save is recorded as a new file descended from the old one.
 */
export function openProject(bytes, { limits = CANDIDATE_LIMITS, now } = {}) {
    if (!Number.isFinite(now)) throw new TypeError('openProject needs now (epoch ms)');
    const reject = (stage, code, problems, extra = {}) => ({ status: OPEN_STATUS.REJECTED, stage, code, problems, ...extra });

    const parsed = parseBounded(bytes, limits);
    if (!parsed.ok) return reject(parsed.stage, parsed.code, [{ code: parsed.code, path: '', message: parsed.detail ?? '' }]);

    const version = classifyVersion(parsed.value);
    if (version.ok) {
        const verdict = validateParsed(parsed.value, { limits, now });
        if (verdict.status !== 'ACCEPTED') return reject(verdict.stage, verdict.code, verdict.problems);
        return { status: OPEN_STATUS.OPENED, project: verdict.project, warnings: verdict.warnings };
    }
    if (version.code !== VERSION_REFUSAL.OLD_VERSION_REQUIRES_MIGRATION) {
        return reject(IMPORT_STAGE.VERSION, version.code, [{ code: version.code, path: '/schemaVersion', message: '' }], { version: version.version ?? null });
    }

    // Old. Walk the chain one version at a time; each step validates its input
    // against that version's own schema before converting anything.
    let document = parsed.value;
    let from = version.version;
    const report = [];
    while (from < SUPPORTED_SCHEMA_VERSION) {
        const step = MIGRATIONS.get(from);
        if (!step) {
            return reject(IMPORT_STAGE.VERSION, VERSION_REFUSAL.OLD_VERSION_REQUIRES_MIGRATION,
                [{ code: 'NO_MIGRATION_PATH', path: '/schemaVersion', message: `from ${from}` }], { version: from });
        }
        const problems = compileSchema(step.schema(), limits).validate(document, limits.maxReportedProblems);
        if (problems.length > 0) return reject(IMPORT_STAGE.SCHEMA, problems[0].code, problems, { version: from });
        const migrated = step.migrate(document, { now });
        report.push({ from, to: step.to, changes: migrated.changes });
        document = migrated.document;
        from = step.to;
    }

    // The converted document earns no trust from having been converted.
    const verdict = validateParsed(document, { limits, now });
    if (verdict.status !== 'ACCEPTED') return reject(verdict.stage, verdict.code, verdict.problems, { version: version.version, afterMigration: true });
    return {
        status: OPEN_STATUS.MIGRATED_IN_MEMORY,
        project: verdict.project,
        warnings: verdict.warnings,
        migration: { fromVersion: version.version, toVersion: SUPPORTED_SCHEMA_VERSION, steps: report },
    };
}
