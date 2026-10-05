/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * The schema file and the thing that executes it.
 *
 *   - the interpreter refuses a schema it cannot fully enforce;
 *   - the numbers written in the schema are the candidate limits, one for one;
 *   - an independent implementation (ajv, present only as a transitive
 *     dependency of ESLint) agrees with the interpreter on every fixture.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CANDIDATE_LIMITS, limitsWith } from '../prototype/limits.proposed.mjs';
import { loadSchema } from '../prototype/project-io.mjs';
import { SchemaError, compileSchema } from '../prototype/schema-subset.mjs';
import { cloneDocument, smallProject } from './helpers.mjs';

const schema = loadSchema();
const { document: VALID } = smallProject();

test('the proposed schema compiles, and says what it is', () => {
    assert.doesNotThrow(() => compileSchema(schema, CANDIDATE_LIMITS));
    assert.match(schema.title, /PROPOSED/);
    assert.match(schema.title, /NON-CANONICAL/);
    assert.match(schema.description, /NOT an adopted schema/);
});

test('an unknown keyword is an error, not a constraint that silently does nothing', () => {
    const typo = cloneDocument(schema);
    typo.$defs.Name.maxLenght = 5; // the typo a permissive validator would ignore
    assert.throws(() => compileSchema(typo), (e) => e instanceof SchemaError && /maxLenght/.test(e.message));
    for (const keyword of ['oneOf', 'allOf', 'not', 'if', 'patternProperties', 'format', 'uniqueItems', 'default']) {
        const unsupported = cloneDocument(schema);
        unsupported.$defs.Name[keyword] = keyword === 'format' ? 'email' : {};
        assert.throws(() => compileSchema(unsupported), SchemaError, keyword);
    }
});

test('a schema that would admit something unbounded does not compile', () => {
    const cases = [
        ['an object open to extra fields', (s) => { delete s.$defs.Project.additionalProperties; }],
        ['an object with additionalProperties: true', (s) => { s.$defs.Project.additionalProperties = true; }],
        ['an array with no maxItems', (s) => { delete s.$defs.DrawingSet.properties.sheets.maxItems; delete s.$defs.DrawingSet.properties.sheets['x-limit']; }],
        ['a string with no maxLength', (s) => { delete s.$defs.Comment.maxLength; delete s.$defs.Comment['x-limit']; }],
        ['a number with no range', (s) => { delete s.$defs.Lineage.properties.saveSequence.maximum; }],
        ['a required field that is not declared', (s) => { s.$defs.Project.required.push('owner'); }],
        ['a $ref to nothing', (s) => { s.$defs.Project.properties.id = { $ref: '#/$defs/Missing' }; }],
        ['a $ref outside the document', (s) => { s.$defs.Project.properties.id = { $ref: 'https://example.invalid/x.json' }; }],
        ['a recursive $ref', (s) => { s.$defs.Project.properties.child = { $ref: '#/$defs/Project' }; }],
        ['anyOf used for anything but "or null"', (s) => { s.$defs.Project.properties.id = { anyOf: [{ $ref: '#/$defs/Uuid' }, { $ref: '#/$defs/Sha256Hex' }] }; }],
        ['a bad pattern', (s) => { s.$defs.Uuid.pattern = '('; }],
        ['a type list', (s) => { s.$defs.Uuid.type = ['string', 'null']; }],
    ];
    for (const [name, mutate] of cases) {
        const broken = cloneDocument(schema);
        mutate(broken);
        assert.throws(() => compileSchema(broken), SchemaError, name);
    }
});

test('the schema has no recursion, so validating never descends further than the schema is deep', () => {
    // A value nested far deeper than the schema is reported at the first level that is wrong.
    let deep = 'x';
    for (let i = 0; i < 5000; i += 1) deep = [deep];
    const broken = cloneDocument(VALID);
    broken.project.name = deep;
    const problems = compileSchema(schema).validate(broken);
    assert.deepEqual(problems.map((p) => [p.code, p.path]), [['SCHEMA_TYPE', '/project/name']]);
});

test('every x-limit in the schema names a real limit, and the number written beside it is that limit', () => {
    const { limitBindings } = compileSchema(schema, CANDIDATE_LIMITS);
    assert.ok(limitBindings.length >= 20, `only ${limitBindings.length} bindings`);
    for (const binding of limitBindings) {
        assert.ok(Object.hasOwn(CANDIDATE_LIMITS, binding.limit), `${binding.where}: unknown limit ${binding.limit}`);
        assert.equal(binding.literal, CANDIDATE_LIMITS[binding.limit], `${binding.where}: schema says ${binding.literal}, limits say ${CANDIDATE_LIMITS[binding.limit]}`);
    }
    // Every count/length limit the schema can express is actually used by it.
    const used = new Set(limitBindings.map((b) => b.limit));
    const schemaLimits = ['maxSources', 'maxSheets', 'maxProfiles', 'maxAnalysisRuns', 'maxFindings', 'maxDecisions', 'maxFingerprintHistoryPerSource',
        'maxConfirmationHistoryPerSheet', 'maxSubjectsPerFinding', 'maxNameLength', 'maxFileNameLength', 'maxFieldValueLength', 'maxFieldRawTextLength',
        'maxCommentLength', 'maxSourceBytes', 'maxPagesPerSource', 'maxPagePoints'];
    for (const name of schemaLimits) assert.ok(used.has(name), `${name} is not bound to anything in the schema`);
});

test('an injected limit replaces the written one, and an unknown limit name is refused', () => {
    const small = compileSchema(schema, limitsWith({ maxNameLength: 5 }));
    const long = cloneDocument(VALID);
    assert.ok(small.validate(long).some((p) => p.code === 'SCHEMA_STRING_LENGTH' && p.path === '/project/name'));
    assert.throws(() => limitsWith({ maxShets: 1 }), RangeError);
    assert.throws(() => limitsWith({ maxSheets: -1 }), RangeError);
    assert.throws(() => limitsWith({ maxSheets: 1.5 }), RangeError);
});

test('the schema\'s own depth is what the nesting limit was sized against', () => {
    const depth = (value) => {
        if (value === null || typeof value !== 'object') return 0;
        let deepest = 0;
        for (const item of Array.isArray(value) ? value : Object.values(value)) deepest = Math.max(deepest, depth(item));
        return deepest + 1;
    };
    const natural = depth(VALID);
    assert.equal(natural, 7, `document depth ${natural}`);
    assert.ok(CANDIDATE_LIMITS.maxNestingDepth >= 2 * natural);
});

test('projection keeps declared properties in declared order and drops everything else', () => {
    const compiled = compileSchema(schema);
    const messy = cloneDocument(VALID);
    messy.extra = 1;
    messy.drawingSet.sheets[0].runtimeOnly = { anything: true };
    const reordered = Object.fromEntries(Object.entries(messy).reverse());
    const projected = compiled.project(reordered);
    assert.deepEqual(projected, VALID);
    assert.equal(JSON.stringify(projected), JSON.stringify(VALID));
});

test('differential: ajv (draft-07) and the owned interpreter agree on every fixture', (t) => {
    let Ajv;
    try {
        Ajv = createRequire(import.meta.url)('ajv');
    } catch {
        t.skip('ajv is not resolvable here (it is only a transitive dependency of ESLint)');
        return;
    }
    const forAjv = cloneDocument(schema);
    delete forAjv.$id;
    const ajvValidate = new Ajv({ allErrors: false, unicode: true }).compile(forAjv);
    const owned = compileSchema(schema);

    const mutations = [
        ['valid', () => {}],
        ['unknown top-level field', (d) => { d.extra = 1; }],
        ['unknown nested field', (d) => { d.drawingSet.sheets[0].thumbnail = 'x'; }],
        ['missing required', (d) => { delete d.drawingSet.sheets[0].sourceId; }],
        ['wrong type', (d) => { d.drawingSet.sheets[0].pageNumber = '1'; }],
        ['fractional integer', (d) => { d.drawingSet.sheets[0].pageNumber = 1.5; }],
        ['below minimum', (d) => { d.drawingSet.sheets[0].pageNumber = 0; }],
        ['above maximum', (d) => { d.drawingSet.sources[0].fingerprint.byteLength = 268435457; }],
        ['bad enum', (d) => { d.drawingSet.decisions[0].outcome = 'RESOLVED'; }],
        ['bad const', (d) => { d.format = 'other'; }],
        ['bad uuid', (d) => { d.project.id = 'not-a-uuid'; }],
        ['upper-case sha', (d) => { d.drawingSet.sources[0].fingerprint.sha256 = d.drawingSet.sources[0].fingerprint.sha256.toUpperCase(); }],
        ['string too long', (d) => { d.project.name = 'x'.repeat(201); }],
        ['string too short', (d) => { d.project.name = ''; }],
        ['path in file name', (d) => { d.drawingSet.sources[0].displayName = 'a/b.pdf'; }],
        ['control char in name', (d) => { d.project.name = `a${String.fromCodePoint(7)}b`; }],
        ['bidi override in name', (d) => { d.project.name = `a${String.fromCodePoint(0x202e)}b`; }],
        ['newline in comment (allowed)', (d) => { d.drawingSet.decisions[0].comment = 'a\nb'; }],
        ['newline in name (not allowed)', (d) => { d.project.name = 'a\nb'; }],
        ['null where object required', (d) => { d.project = null; }],
        ['object where null-or-object allowed', (d) => { d.drawingSet.sheets[0].confirmation = null; }],
        ['array too long', (d) => { d.drawingSet.sheets[0].confirmation = null; d.drawingSet.sheets[0].confirmationHistory = Array.from({ length: 33 }, () => ({ confirmation: d.drawingSet.sheets.find((s) => s.confirmation).confirmation, retiredAt: d.savedAt, reason: 'RECONFIRMED' })); }],
        ['bad timestamp form', (d) => { d.savedAt = '2026-10-05'; }],
        ['bad rotate', (d) => { d.drawingSet.sheets[0].pageFacts.rotate = 45; }],
        ['negative coordinate', (d) => { d.drawingSet.titleBlockProfiles[0].fields.revision.left = -1; }],
        ['array where object required', (d) => { d.drawingSet = []; }],
    ];
    let accepted = 0;
    let refused = 0;
    for (const [name, mutate] of mutations) {
        const candidate = cloneDocument(VALID);
        mutate(candidate);
        const ownedOk = owned.validate(candidate).length === 0;
        const ajvOk = ajvValidate(candidate) === true;
        assert.equal(ownedOk, ajvOk, `${name}: owned=${ownedOk} ajv=${ajvOk} ${JSON.stringify(ajvValidate.errors?.[0] ?? null)}`);
        if (ownedOk) accepted += 1; else refused += 1;
    }
    // The comparison is only worth something if both verdicts actually occur.
    assert.ok(accepted >= 3 && refused >= 20, `accepted ${accepted}, refused ${refused}`);
});
