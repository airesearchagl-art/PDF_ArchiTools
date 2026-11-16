/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Reading and writing a Portable Project JSON.
 *
 * Import is a pipeline of refusals, cheapest first, each named by its stage:
 *
 *   bytes      how big is it                  before anything is read
 *   encoding   is it UTF-8
 *   scan       depth, count, duplicate keys   before anything is allocated
 *   parse      is it JSON
 *   version    is it ours, and which version  before the schema is consulted
 *   schema     does every value have a shape  bounded, no unknown field
 *   relations  does it mean something         ids, references, lifecycle
 *
 * There are two outcomes and no third: ACCEPTED with the whole project, or
 * REJECTED with nothing. A file is never partly imported and never repaired.
 *
 * Export is the same contract from the other side. The writer copies only what
 * the schema declares (so a runtime handle, a Blob URL or a byte buffer hanging
 * off the in-memory model cannot reach the file), and then it runs the import
 * checks on what it is about to write. A project this app cannot read back is
 * never written.
 */

import { IMPORT_STAGE, parseBounded } from './bounded-json.mjs';
import { CANDIDATE_LIMITS } from './limits.proposed.mjs';
import { compileSchema } from './schema-subset.mjs';
import { checkRelations } from './semantic.mjs';
// A JSON module, so the same file is the schema in Node and in the browser
// benchmark, and there is no second copy of it to fall out of step.
import proposedSchema from '../portable-project.schema.proposed.json' with { type: 'json' };

export const PROJECT_FORMAT = 'pdf-architools/drawing-set-project';
export const SUPPORTED_SCHEMA_VERSION = 1;

export const VERSION_REFUSAL = Object.freeze({
    NOT_A_PROJECT_FILE: 'NOT_A_PROJECT_FILE',
    VERSION_UNREADABLE: 'VERSION_UNREADABLE',
    UNSUPPORTED_FUTURE_VERSION: 'UNSUPPORTED_FUTURE_VERSION',
    OLD_VERSION_REQUIRES_MIGRATION: 'OLD_VERSION_REQUIRES_MIGRATION',
});

/** The proposed schema, as data. */
export const loadSchema = () => proposedSchema;

const compiledByLimits = new WeakMap();
function compiledFor(limits, schema) {
    if (schema) return compileSchema(schema, limits);
    if (!compiledByLimits.has(limits)) compiledByLimits.set(limits, compileSchema(loadSchema(), limits));
    return compiledByLimits.get(limits);
}

const rejected = (stage, code, problems, extra = {}) => ({ status: 'REJECTED', stage, code, problems, ...extra });

/**
 * Decide which reader a parsed document is for, before any schema sees it.
 *
 * This is the only place a future version is recognised, and all it does with
 * one is refuse: nothing downstream is asked to make sense of a shape this
 * build has never been told about.
 */
export function classifyVersion(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: VERSION_REFUSAL.NOT_A_PROJECT_FILE };
    if (!Object.hasOwn(value, 'format') || value.format !== PROJECT_FORMAT) return { ok: false, code: VERSION_REFUSAL.NOT_A_PROJECT_FILE };
    const version = Object.hasOwn(value, 'schemaVersion') ? value.schemaVersion : undefined;
    if (!Number.isSafeInteger(version) || version < 0) return { ok: false, code: VERSION_REFUSAL.VERSION_UNREADABLE };
    if (version > SUPPORTED_SCHEMA_VERSION) return { ok: false, code: VERSION_REFUSAL.UNSUPPORTED_FUTURE_VERSION, version };
    if (version < SUPPORTED_SCHEMA_VERSION) return { ok: false, code: VERSION_REFUSAL.OLD_VERSION_REQUIRES_MIGRATION, version };
    return { ok: true, version };
}

/** Schema, then relations, on an already-parsed current-version document. */
export function validateParsed(value, { limits = CANDIDATE_LIMITS, now, schema } = {}) {
    const timings = {};
    let t = performance.now();
    const compiled = compiledFor(limits, schema);
    const schemaProblems = compiled.validate(value, limits.maxReportedProblems);
    timings.schemaMs = performance.now() - t;
    if (schemaProblems.length > 0) return { ...rejected(IMPORT_STAGE.SCHEMA, schemaProblems[0].code, schemaProblems), timings };

    t = performance.now();
    const relations = checkRelations(value, { now, maxProblems: limits.maxReportedProblems });
    timings.relationsMs = performance.now() - t;
    if (relations.problems.length > 0) return { ...rejected(IMPORT_STAGE.RELATIONS, relations.problems[0].code, relations.problems), timings };

    return { status: 'ACCEPTED', project: value, warnings: relations.warnings, timings };
}

/**
 * Import a Portable Project JSON from bytes.
 *
 * `now` is epoch milliseconds and is required: nothing here reads the clock, so
 * a verdict is a function of the bytes and the arguments alone.
 */
export function importProject(bytes, { limits = CANDIDATE_LIMITS, now, schema } = {}) {
    if (!Number.isFinite(now)) throw new TypeError('importProject needs now (epoch ms)');

    const parsed = parseBounded(bytes, limits);
    if (!parsed.ok) {
        return rejected(parsed.stage, parsed.code, [{ code: parsed.code, path: '', message: parsed.detail ?? '' }], {
            at: parsed.at ?? null, timings: parsed.timings,
        });
    }

    const version = classifyVersion(parsed.value);
    if (!version.ok) {
        return rejected(IMPORT_STAGE.VERSION, version.code, [{ code: version.code, path: '/schemaVersion', message: '' }], {
            version: version.version ?? null, timings: parsed.timings,
        });
    }

    const verdict = validateParsed(parsed.value, { limits, now, schema });
    return { ...verdict, stats: parsed.stats, timings: { ...parsed.timings, ...verdict.timings } };
}

export class ExportRefused extends Error {
    constructor(stage, problems) {
        super(`export refused at ${stage}: ${problems[0]?.code} ${problems[0]?.path}`);
        this.name = 'ExportRefused';
        this.stage = stage;
        this.problems = problems;
    }
}

const encoder = new TextEncoder();

/**
 * Write a project as a new saved file.
 *
 * Every save is a new file with a new `projectFileId`, one step along the
 * lineage from the file the model was loaded from (or the first step, if it was
 * never saved). `newFileId` and `now` are injected for the same reason `now` is
 * on import.
 */
export function exportProject(model, { limits = CANDIDATE_LIMITS, now, newFileId, schema, migratedFrom = null } = {}) {
    if (!Number.isFinite(now)) throw new TypeError('exportProject needs now (epoch ms)');
    if (typeof newFileId !== 'string') throw new TypeError('exportProject needs newFileId');

    const compiled = compiledFor(limits, schema);
    // The allow-list: declared properties only, in declared order.
    const document = compiled.project(model);

    const neverSaved = model.projectFileId === null || model.projectFileId === undefined;
    document.format = PROJECT_FORMAT;
    document.schemaVersion = SUPPORTED_SCHEMA_VERSION;
    document.lineage = {
        saveSequence: neverSaved ? 1 : model.lineage.saveSequence + 1,
        previousProjectFileId: neverSaved ? null : model.projectFileId,
        migratedFrom: migratedFrom ?? (neverSaved ? null : model.lineage.migratedFrom ?? null),
    };
    document.projectFileId = newFileId;
    document.savedAt = new Date(now).toISOString();
    const ordered = compiled.project(document);

    const verdict = validateParsed(ordered, { limits, now, schema });
    if (verdict.status !== 'ACCEPTED') throw new ExportRefused(verdict.stage, verdict.problems);

    const text = JSON.stringify(ordered);
    const bytes = encoder.encode(text);
    if (bytes.length > limits.maxProjectBytes) {
        throw new ExportRefused(IMPORT_STAGE.BYTES, [{ code: 'PROJECT_TOO_LARGE', path: '', message: `${bytes.length}` }]);
    }
    return { bytes, text, document: ordered };
}
