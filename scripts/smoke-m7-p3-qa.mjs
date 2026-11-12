/**
 * M7-P3 QA core gate: the Production QA engine (QA01 / QA02 / QA09), the typed drawing register and Review
 * Decisions, held to the Human-adopted CAN-03 R4.1 artifact and to the canonical contract (contracts/m7).
 *
 * The reference model the contract was adopted with is a test oracle here and nowhere else:
 * scripts/m7-p3-oracle/ holds the pack's generator, counterexamples and the R3 / R4 originals they import,
 * byte for byte, and each is checked against the pack's SHA-256 before anything is run. The Production modules
 * are loaded from src through Vite, in Node; nothing of the oracle is imported by src.
 *
 *  1. provenance: every oracle file is the pack's; the generator writes the pack's vectors byte for byte;
 *  2. contract drift: the P3 bounds, the comment characters, the rule / outcome enums and the engine name are
 *     the schema's;
 *  3. byte derivations: the contract's six findingKey and four evidenceDigest reference vectors, through the
 *     Production functions;
 *  4. vectors: both scenarios (R3's 13 steps, the 7 multi-reference steps), replayed on the Production engine,
 *     equal the pack's vectors step for step -- keys, evidence, lifecycles, currencies, Decisions, readiness and
 *     the final Drawing Sets -- once the replay has been shown to reproduce the vectors on the generator itself;
 *  5. counterexamples: the pack's 35 cases (24 of R4, 11 at and past every bound of R4.1-L), unchanged, with
 *     every operation that decides answered by the Production engine, each against its stated expectation;
 *  6. contract: every state the Production engine produced above, the at-bound ones included, is valid against
 *     the schema and passes portable-project.semantic.mjs with no problem and no warning; negative controls;
 *  7. the typed register and Decision inputs: declaration, correction, retirement and their refusals, a retired
 *     Source taking its registers with it, the comment's characters;
 *  8. a 5000-Sheet Drawing Set: QA run, assessment and re-run times, recorded (no threshold).
 *
 * Run:  node scripts/smoke-m7-p3-qa.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { unsupportedKeywords, validate } from './m7-schema-subset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = path.join(ROOT, 'scripts', 'm7-p3-oracle');
const SCHEMA_PATH = path.join(ROOT, 'contracts', 'm7', 'portable-project.schema.json');
const SEMANTIC_PATH = path.join(ROOT, 'contracts', 'm7', 'portable-project.semantic.mjs');
const CONTRACT_MD_PATH = path.join(ROOT, 'contracts', 'm7', 'semantic-contract.md');

/** The Human-adopted pack (semantic-contract.md, M7-CAN-03) and the SHA-256 its SHA256SUMS states per file. */
const PACK = {
    name: 'M7-CAN03-R4.1-LIMIT-ATOMICITY.zip',
    sha256: 'c6bf864db66ecc0797ef3220a4be893dc0eb661b8f91cdff492db51c99c311cb',
    files: {
        'can03-r41-generator.mjs': '9de2e22c851ed0fb2f7d5daec02b3c280cdf4a6c2e4b7c3a3d21e164968427f4',
        'can03-r41-counterexamples.mjs': '28b46bb807a4f399b8ae1f1e7438f019d10777a36f12ffd7adc278bf3ca38f9f',
        'r3-original/can03-r3-generator.mjs': 'd0dea662be33c869e42d8f73d0e9e37f33a35d9aa56f665ac24ab15f2fc8c8db',
        'r4-original/can03-r4-generator.mjs': 'c70fef3ec759be59c4ed69e534ae4cbfa66b40875303215780799233e47fd069',
    },
    vectors: '4c521733e4cc6f7ceac3c0855912f6df81f081533330c0cff3a1d67531e8f98a',
};

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const note = (name, detail) => console.log(`  ----  ${name}  ${detail}`);
const section = (title) => console.log(`\n=== ${title} ===`);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** JSON with every object's keys sorted: equality that does not depend on how an object was built. */
const canonical = (value) => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
/** The first path at which two JSON values differ, for a failure's detail. */
function firstDifference(a, b, at = '$') {
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) return `${at}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
    if (a && typeof a === 'object') {
        const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        for (const key of keys) {
            const d = firstDifference(a[key], b[key], `${at}.${key}`);
            if (d) return d;
        }
        return null;
    }
    return a === b ? null : `${at}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
}
/** The QA engine's version is the Production engine's own, not the generator's synthetic label: set aside. */
const ENGINE_LABEL = '<qa-engine>';
function sameEngineLabel(value) {
    return JSON.parse(JSON.stringify(value), (key, v) => (v && typeof v === 'object' && v.name === 'drawing-set-qa' && typeof v.version === 'string'
        ? { ...v, version: ENGINE_LABEL } : v));
}

async function main() {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const { checkRelations } = await import(pathToFileURL(SEMANTIC_PATH).href);

    // ------------------------------------------------------------------
    section('1. Provenance: the oracle is the Human-adopted pack');
    note('pack', `${PACK.name}  SHA-256 ${PACK.sha256} (semantic-contract.md, M7-CAN-03)`);
    for (const [file, expected] of Object.entries(PACK.files)) {
        const got = sha256(fs.readFileSync(path.join(ORACLE, file)));
        check(`scripts/m7-p3-oracle/${file} is the pack's`, got === expected, got.slice(0, 16));
    }
    const G = await import(pathToFileURL(path.join(ORACLE, 'can03-r41-generator.mjs')).href);
    const vectorsText = `${JSON.stringify(G.vectorsDocument(), null, 1)}\n`;
    check('the generator writes the pack\'s can03-r41-vectors.json byte for byte', sha256(Buffer.from(vectorsText, 'utf8')) === PACK.vectors, sha256(Buffer.from(vectorsText, 'utf8')).slice(0, 16));
    const VECTORS = JSON.parse(vectorsText);

    // ------------------------------------------------------------------
    section('2. The Production modules, loaded from src through Vite');
    const server = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
    let exitCode = 1;
    try {
        const qa = await server.ssrLoadModule('/src/utils/drawing-set/qa-engine.ts');
        const register = await server.ssrLoadModule('/src/utils/drawing-set/drawing-register.ts');
        const bounds = await server.ssrLoadModule('/src/utils/drawing-set/field-bounds.ts');
        const analysisRun = await server.ssrLoadModule('/src/utils/drawing-set/analysis-run.ts');
        const model = await server.ssrLoadModule('/src/utils/drawing-set/model.ts');
        check('qa-engine, drawing-register, field-bounds, analysis-run and model load', typeof qa.runQa === 'function' && typeof register.declareManualRegister === 'function');
        globalThis.__m7p3Product = { qa, bounds, analysisRun };
        const A = await import(pathToFileURL(path.join(ROOT, 'scripts', 'm7-p3-oracle-adapter.mjs')).href);

        // ------------------------------------------------------------------
        section('3. Contract drift: the P3 bounds and enums against contracts/m7');
        const defs = schema.$defs;
        const L = bounds.P3_QA_LIMITS;
        const drift = [
            ['DrawingSet.analysisRuns.maxItems', defs.DrawingSet.properties.analysisRuns, 'maxItems', L.maxAnalysisRuns, 2000],
            ['DrawingSet.findings.maxItems', defs.DrawingSet.properties.findings, 'maxItems', L.maxFindings, 50000],
            ['DrawingSet.decisions.maxItems', defs.DrawingSet.properties.decisions, 'maxItems', L.maxDecisions, 100000],
            ['ReviewDecision.sequence.maximum', defs.ReviewDecision.properties.sequence, 'maximum', L.maxDecisions, 100000],
            ['Finding.sheetIds.maxItems', defs.Finding.properties.sheetIds, 'maxItems', L.maxSubjectsPerFinding, 5000],
            ['Finding.registerEntryIds.maxItems', defs.Finding.properties.registerEntryIds, 'maxItems', L.maxSubjectsPerFinding, 5000],
            ['Finding.sourceIds.maxItems', defs.Finding.properties.sourceIds, 'maxItems', L.maxSources, 5000],
            ['Finding.basis.maxItems', defs.Finding.properties.basis, 'maxItems', L.maxSources, 5000],
            ['AnalysisRun.coverage.sheetsEvaluated.maximum', defs.AnalysisRun.properties.coverage.properties.sheetsEvaluated, 'maximum', L.maxSheets, 5000],
            ['AnalysisRun.coverage.sheetsExcluded.maximum', defs.AnalysisRun.properties.coverage.properties.sheetsExcluded, 'maximum', L.maxSheets, 5000],
            ['DrawingSet.drawingRegisterReferences.maxItems', defs.DrawingSet.properties.drawingRegisterReferences, 'maxItems', L.maxRegisterReferences, 64],
            ['DrawingRegisterReference.entries.maxItems', defs.DrawingRegisterReference.properties.entries, 'maxItems', L.maxRegisterEntriesPerReference, 1000],
            ['RegisterEntry.row.maximum', defs.RegisterEntry.properties.row, 'maximum', L.maxRegisterEntriesPerReference, 1000],
            ['DrawingRegisterReference.pageNumber.maximum', defs.DrawingRegisterReference.properties.pageNumber, 'maximum', L.maxPagesPerSource, 5000],
            ['Comment.maxLength', defs.Comment, 'maxLength', L.maxCommentLength, 4000],
        ];
        for (const [label, node, keyword, limit, expected] of drift) {
            check(`${label} = P3 constant`, node[keyword] === limit.value && limit.value === expected, `${node[keyword]} / ${limit.value}`);
            check(`${label}: same x-limit name`, node['x-limit'] === limit.xLimit, `${node['x-limit']} / ${limit.xLimit}`);
        }
        check('every P3 bound is a candidate, none raised or frozen here',
            Object.values(L).every((limit) => limit.status === 'CANONICAL_PRE_RELEASE_CANDIDATE'), Object.values(L).map((l) => l.status).join(','));
        check('maxAnalysisRuns is the P2 constant itself (one bound for EXTRACTION and QA runs)', L.maxAnalysisRuns === bounds.P2_METADATA_LIMITS.maxAnalysisRuns);
        check('Comment.pattern is rebuilt from COMMENT_FORBIDDEN_CLASS', defs.Comment.pattern === `^[^${bounds.COMMENT_FORBIDDEN_CLASS}]*$`, defs.Comment.pattern);
        check('the ruleId enum is the schema\'s, in its order', JSON.stringify(model.QA_RULE_IDS) === JSON.stringify(defs.Finding.properties.ruleId.enum));
        check('the Decision outcomes are the schema\'s, in its order', JSON.stringify(model.REVIEW_OUTCOMES) === JSON.stringify(defs.ReviewDecision.properties.outcome.enum));
        check('the QA engine name is in AnalysisRun.engine.name.enum', defs.AnalysisRun.properties.engine.properties.name.enum.includes(qa.QA_ENGINE.name), qa.QA_ENGINE.name);
        check('the QA engine version is a VersionString', new RegExp(defs.VersionString.pattern, 'u').test(qa.QA_ENGINE.version), qa.QA_ENGINE.version);
        check('M7-P3 implements exactly QA01, QA02 and QA09', JSON.stringify(qa.IMPLEMENTED_QA_RULES) === JSON.stringify(G.P3_INITIAL_RULES));
        check('the bounds the adapter hands the oracle are the generator\'s values', canonical(A.LIMITS) === canonical(G.LIMITS), canonical(A.LIMITS));

        // ------------------------------------------------------------------
        section('3b. Byte derivations: the contract\'s reference vectors through Production');
        const md = fs.readFileSync(CONTRACT_MD_PATH, 'utf8').replace(/\r\n/g, '\n');
        const blocks = [...md.matchAll(/#### (findingKey|evidenceDigest) — (.+)\n\n```json\n(.+)\n```\n\nSHA-256: `([0-9a-f]{64})`/g)]
            .map((m) => ({ kind: m[1], title: m[2], input: m[3], hex: m[4] }));
        check('the contract states six findingKey and four evidenceDigest vectors', blocks.filter((b) => b.kind === 'findingKey').length === 6 && blocks.filter((b) => b.kind === 'evidenceDigest').length === 4, `${blocks.length}`);
        const rawOf = { 'A-102': 'A-102', '" A-102 " (trimmed)': ' A-102 ', '"A-102\\u3000" (ideographic space trimmed)': 'A-102　', 'A 102 (internal space kept)': 'A 102', 'A102': 'A102', 'Ａ－１０２ (full width: hint only, never the same key)': 'Ａ－１０２' };
        for (const block of blocks.filter((b) => b.kind === 'findingKey')) {
            const raw = rawOf[block.title];
            const key = qa.findingKeyOf('QA01_DUPLICATE_NUMBER', null, [qa.comparisonKey(raw)]);
            check(`findingKey ${block.title}: the contract's string and SHA-256`, raw !== undefined && key.input === block.input && key.hex === block.hex && sha256(Buffer.from(block.input, 'utf8')) === block.hex, key.hex.slice(0, 16));
        }
        for (const block of blocks.filter((b) => b.kind === 'evidenceDigest')) {
            const [, , ruleId, , reason, basis, sheets, entries, extra] = JSON.parse(block.input);
            // Handed over in reverse order: the engine sorts basis, sheets and entries itself.
            const got = qa.evidenceDigestOf({ ruleId, reason, basis: [...basis].reverse(), sheets: [...sheets].reverse(), entries: [...entries].reverse(), extra });
            check(`evidenceDigest ${block.title}: the contract's string and SHA-256`, got.input === block.input && got.hex === block.hex, got.hex.slice(0, 16));
        }
        check('manifestDigest: the §F vectors through Production', analysisRun.manifestDigest({ sources: [] }) === '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
            && analysisRun.manifestDigest({ sources: [{ id: G.U(2), retiredAt: null, fingerprint: { sha256: G.HEX('b') } }, { id: G.U(1), retiredAt: null, fingerprint: { sha256: G.HEX('a') } }] }) === '8fdeea72a821499e08e043456eff0e02008b83fce8bad8905a34535e4727fed0');
        for (const [label, raw, key] of [['" A-102 "', ' A-102 ', 'A-102'], ['ideographic space', '　A-102　', 'A-102'], ['internal space', 'A 102', 'A 102'], ['full width', 'Ａ－１０２', 'Ａ－１０２']]) {
            check(`comparisonKey ${label} -> ${JSON.stringify(key)} (trim only, never folded)`, qa.comparisonKey(raw) === key);
        }

        // ------------------------------------------------------------------
        section('4. Vectors: both scenarios on the Production engine');
        const { replayScenarios } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'm7-p3-scenarios.mjs')).href);
        const onGenerator = replayScenarios(G);
        const replayFaithful = JSON.stringify(onGenerator.r3Regression.steps) === JSON.stringify(VECTORS.scenarios.r3Regression)
            && JSON.stringify(onGenerator.multiReference.steps) === JSON.stringify(VECTORS.scenarios.multiReference);
        check('the replay reproduces the pack\'s vectors on the generator itself, byte for byte', replayFaithful);
        const onProduct = replayScenarios(A);
        const productStates = [];
        for (const [name, steps] of [['r3Regression', onProduct.r3Regression.steps], ['multiReference', onProduct.multiReference.steps]]) {
            const expected = VECTORS.scenarios[name];
            check(`${name}: the same ${expected.length} steps`, steps.length === expected.length, `${steps.length}`);
            for (const [i, step] of steps.entries()) {
                const want = expected[i];
                const got = sameEngineLabel(step);
                const exp = sameEngineLabel(want);
                const same = canonical(got) === canonical(exp);
                check(`${name} step ${want.step} "${want.name}": run, register, every Finding (key, evidence, lifecycle, currency, Decisions) and readiness`,
                    same, same ? `${want.findings.length} findings, ${want.readinessP3.status}` : firstDifference(JSON.parse(canonical(got)), JSON.parse(canonical(exp))));
            }
        }
        check('the QA runs name the Production engine', [...onProduct.r3Regression.steps, ...onProduct.multiReference.steps].every((step) => step.qaRun.engine.name === qa.QA_ENGINE.name && step.qaRun.engine.version === qa.QA_ENGINE.version));
        for (const name of ['r3Regression', 'multiReference']) {
            const file = A.toProjectFile(onProduct[name].session);
            productStates.push([`scenario ${name} final`, file]);
            const same = canonical(sameEngineLabel(file)) === canonical(sameEngineLabel(VECTORS.finalProjectFiles[name]));
            check(`${name}: the final Drawing Set equals the pack's, field for field`, same, same ? '' : firstDifference(JSON.parse(canonical(sameEngineLabel(file))), JSON.parse(canonical(sameEngineLabel(VECTORS.finalProjectFiles[name])))));
        }
        const mrSteps = onProduct.multiReference.steps;
        check('MR1: one LISTED_BUT_MISSING for A-104, citing the rows of both references (MD-1)',
            mrSteps[0].findings.filter((f) => f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && f.reason === 'LISTED_BUT_MISSING' && f.lifecycle === 'ACTIVE').map((f) => f.stored.registerEntryIds.length).join(',') === '2');
        const activeQa09AtMr6 = mrSteps[5].findings.filter((f) => f.ruleId === 'QA09_REGISTER_SHEET_MISMATCH' && f.lifecycle === 'ACTIVE').map((f) => f.id);
        const atMr7 = new Map(mrSteps[6].findings.map((f) => [f.id, f]));
        check('MR7: every reference withdrawn, the next run closes the QA09 Findings still ACTIVE NOT_REPRODUCED (MD-2 A)',
            activeQa09AtMr6.length > 0 && activeQa09AtMr6.every((id) => atMr7.get(id).lifecycle === 'NOT_REPRODUCED'), `${activeQa09AtMr6.length}`);
        check('MR7: the two Decisions of MR1 are still recorded, each on the Finding it was made on',
            mrSteps[6].findings.flatMap((f) => f.decisions.map((d) => [d.findingId === f.id, d.sequence])).filter(([own]) => own).length === 2);
        check('every step\'s readiness is FINAL_UNAVAILABLE (QA01B, QA03-QA08 and QA10 not implemented)',
            [...onProduct.r3Regression.steps, ...mrSteps].every((step) => step.readinessP3.status === 'FINAL_UNAVAILABLE'));

        // ------------------------------------------------------------------
        section('5. Counterexamples: the pack\'s 35 cases, every decision Production\'s');
        const counterexamplesUrl = pathToFileURL(path.join(ORACLE, 'can03-r41-counterexamples.mjs')).href;
        const adapterUrl = pathToFileURL(path.join(ROOT, 'scripts', 'm7-p3-oracle-adapter.mjs')).href;
        let redirected = 0;
        registerHooks({
            resolve(specifier, context, nextResolve) {
                if (specifier === './can03-r41-generator.mjs' && context.parentURL === counterexamplesUrl) {
                    redirected += 1;
                    return { url: adapterUrl, shortCircuit: true };
                }
                return nextResolve(specifier, context);
            },
        });
        const started = performance.now();
        const CX = await import(counterexamplesUrl);
        note('counterexamples ran', `${Math.round(performance.now() - started)} ms`);
        check('the counterexample file\'s generator import is answered by the adapter', redirected === 1, `${redirected}`);
        const r4Cases = CX.cases.filter((c) => !c.id.startsWith('CX-R41-'));
        const limitCases = CX.cases.filter((c) => c.id.startsWith('CX-R41-'));
        check('24 R4 cases and 11 R4.1-L limit cases', r4Cases.length === 24 && limitCases.length === 11, `${r4Cases.length} + ${limitCases.length}`);
        for (const c of CX.cases) {
            check(`${c.id} (${c.contract}): ${c.title}`, c.r41.pass === true, c.r41.pass ? '' : JSON.stringify(c.r41.got).slice(0, 400));
        }
        for (const c of limitCases) note(`${c.id} on the R4 original (RF-01 reproduction, information only)`, c.r4.pass ? 'meets the R4.1 expectation' : `differs: ${c.r4.differs.join(',')}`);
        for (const [id, s] of CX.finalSessions) productStates.push([`counterexample ${id} final`, A.toProjectFile(s)]);
        for (const [label, s] of CX.limitStates) productStates.push([`limit ${label}`, A.toProjectFile(s)]);

        // ------------------------------------------------------------------
        section('6. Contract: every state Production produced, against the schema and the semantic contract');
        check('the interpreter implements every keyword the schema uses', unsupportedKeywords(schema).length === 0, unsupportedKeywords(schema).join(','));
        let valid = 0;
        for (const [label, file] of productStates) {
            const errors = validate(schema, file);
            const relations = checkRelations(file, { now: Date.now() });
            const ok = errors.length === 0 && relations.problems.length === 0 && relations.warnings.length === 0;
            if (ok) valid += 1;
            else check(`${label}: schema and semantic contract`, false, JSON.stringify({ errors: errors.slice(0, 3), problems: relations.problems.slice(0, 3), warnings: relations.warnings.slice(0, 3) }));
        }
        check(`all ${productStates.length} states: schema-valid, no semantic problem, no warning`, valid === productStates.length, `${valid}/${productStates.length}`);
        const atBound = (label, pick) => {
            const entry = productStates.find(([l]) => l === label);
            return entry ? pick(entry[1].drawingSet) : null;
        };
        check('the at-bound states are among them: 5000 cited rows, 2000 runs, 50000 Findings, 100000 Decisions',
            atBound('limit CX-R41-01 after', (ds) => Math.max(...ds.findings.map((f) => f.registerEntryIds.length))) === 5000
            && atBound('limit CX-R41-04 after', (ds) => ds.analysisRuns.length) === 2000
            && atBound('limit CX-R41-06 after', (ds) => ds.findings.length) === 50000
            && atBound('limit CX-R41-10 after', (ds) => ds.decisions.length) === 100000);
        const base = productStates.find(([l]) => l === 'scenario r3Regression final')[1];
        const mutate = (fn) => { const copy = structuredClone(base); fn(copy.drawingSet); return copy; };
        probe('the schema refuses a Finding carrying its key input (runtime data stored)', validate(schema, mutate((ds) => { ds.findings[0].keyInput = 'x'; })).length > 0);
        probe('the schema refuses a stored currency', validate(schema, mutate((ds) => { ds.findings[0].currency = 'CURRENT'; })).length > 0);
        probe('the semantic contract refuses a Decision whose evidence is not its Finding\'s',
            checkRelations(mutate((ds) => { ds.decisions[0].evidenceDigest = 'f'.repeat(64); }), { now: Date.now() }).problems.length > 0);
        probe('the semantic contract refuses two ACTIVE Findings with one key',
            checkRelations(mutate((ds) => { const f = ds.findings.find((x) => x.lifecycle.state === 'ACTIVE'); ds.findings.push({ ...structuredClone(f), id: crypto.randomUUID() }); }), { now: Date.now() })
                .problems.some((p) => p.code === 'REL_FINDING_KEY_NOT_UNIQUE'));

        // ------------------------------------------------------------------
        section('7. The typed register and Decision inputs');
        let clock = Date.parse('2026-11-01T00:00:00.000Z');
        const ids = { n: 0 };
        const seams = { now: () => new Date((clock += 1000)).toISOString(), newId: () => crypto.randomUUID() };
        const at = '2026-11-01T00:00:00.000Z';
        const source = (sha, pages = 3) => ({ id: crypto.randomUUID(), displayName: `s${++ids.n}.pdf`, addedAt: at, retiredAt: null, fingerprint: { algorithm: 'SHA-256', sha256: sha, byteLength: 1000, pageCount: pages, recordedAt: at }, fingerprintHistory: [] });
        const sheet = (src, page, values = null) => ({
            id: crypto.randomUUID(), sourceId: src.id, pageNumber: page, createdAt: at, retiredAt: null, pageFacts: null, profileAssignment: null, observation: null,
            confirmation: values ? { confirmedAt: at, sourceSha256: src.fingerprint.sha256, profile: null, values, editedFields: ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'] } : null,
            confirmationHistory: [],
        });
        /** TEST ONLY: the file envelope around a Drawing Set built here, saved after its latest timestamp. */
        const fileOf = (ds) => A.toProjectFile({ t: Date.parse(at), project: { id: crypto.randomUUID(), name: '図面管理プロジェクト', createdAt: at }, ds });
        const V4 = (n) => ({ drawingNumber: n, drawingTitle: '', revision: '', issueDate: '' });
        const ROW = (n, t = '', r = '', d = '') => ({ drawingNumber: n, drawingTitle: t, revision: r, issueDate: d });
        const s1 = source('a'.repeat(64)), s2 = source('b'.repeat(64), 1);
        let set = {
            id: crypto.randomUUID(), name: '図面一式', createdAt: at, sources: [s1, s2], titleBlockProfiles: [],
            sheets: [sheet(s1, 1, V4('A-101')), sheet(s1, 2, V4('A-102')), sheet(s1, 3, V4('A-101'))],
            drawingRegisterReferences: [], analysisRuns: [], findings: [], decisions: [],
        };
        const declared = register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 1, rows: [ROW('A-101', '配置図', 'A', '2026/11/01'), ROW(' A-103 ')] }, seams);
        check('a typed register on page 1 of a live Source is declared, MANUAL, with no region, on the Source\'s bytes',
            declared.ok && declared.drawingSet.drawingRegisterReferences[0].method === 'MANUAL' && declared.drawingSet.drawingRegisterReferences[0].region === null
            && declared.drawingSet.drawingRegisterReferences[0].sourceSha256 === s2.fingerprint.sha256);
        const reference = declared.drawingSet.drawingRegisterReferences[0];
        check('rows keep the typed values exactly; an optional value left empty is null; rows numbered 1..n, all MANUAL',
            reference.entries[1].drawingNumber === ' A-103 ' && reference.entries[1].drawingTitle === null && reference.entries[0].drawingTitle === '配置図'
            && reference.entries.map((e) => e.row).join(',') === '1,2' && reference.entries.every((e) => e.origin === 'MANUAL' && e.retiredAt === null));
        check('the input Drawing Set is untouched', set.drawingRegisterReferences.length === 0);
        set = declared.drawingSet;
        const refusals = [
            ['a page past the Source\'s last', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 2, rows: [ROW('A-1')] }, seams), 'PAGE_OUT_OF_RANGE'],
            ['page 0', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 0, rows: [ROW('A-1')] }, seams), 'PAGE_OUT_OF_RANGE'],
            ['no rows', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 1, rows: [] }, seams), 'NO_ROWS'],
            ['1001 rows', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 1, rows: Array.from({ length: 1001 }, (_, i) => ROW(`A-${i}`)) }, seams), 'ROW_LIMIT'],
            ['a blank drawing number', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 1, rows: [ROW('A-1'), ROW('  　')] }, seams), 'NUMBER_REQUIRED'],
            ['a line feed in a value', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 1, rows: [ROW('A-1\nA-2')] }, seams), 'VALUE_INVALID'],
            ['a 301-character title', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 1, rows: [ROW('A-1', 'x'.repeat(301))] }, seams), 'VALUE_INVALID'],
            ['an unknown Source', register.declareManualRegister(set, { sourceId: crypto.randomUUID(), pageNumber: 1, rows: [ROW('A-1')] }, seams), 'SOURCE_NOT_LIVE'],
        ];
        for (const [label, result, code] of refusals) probe(`a declaration with ${label} is refused (${code}) and nothing is written`, !result.ok && result.refusal.code === code, result.ok ? 'accepted' : result.refusal.code);
        check('the blank-number refusal names its row', refusals[4][1].refusal?.row === 2, `${refusals[4][1].refusal?.row}`);
        check('exactly 1000 rows are accepted', register.declareManualRegister(set, { sourceId: s2.id, pageNumber: 1, rows: Array.from({ length: 1000 }, (_, i) => ROW(`A-${i}`)) }, seams).ok);
        let full = set;
        for (let i = full.drawingRegisterReferences.length; i < 64; i += 1) full = register.declareManualRegister(full, { sourceId: s2.id, pageNumber: 1, rows: [ROW(`B-${i}`)] }, seams).drawingSet;
        check('64 references fit (retired ones counted)', full.drawingRegisterReferences.length === 64);
        probe('a 65th reference is refused (REGISTER_LIMIT)', register.declareManualRegister(full, { sourceId: s2.id, pageNumber: 1, rows: [ROW('C-1')] }, seams).refusal?.code === 'REGISTER_LIMIT');
        const entryId = reference.entries[1].id;
        const edited = register.editRegisterEntry(set, { referenceId: reference.id, entryId, values: ROW('A-102', '平面図') }, seams);
        const editedRef = edited.drawingSet?.drawingRegisterReferences[0];
        check('a corrected row keeps its id and row number, takes the new values, and stays MANUAL',
            edited.ok && editedRef.entries[1].id === entryId && editedRef.entries[1].row === 2 && editedRef.entries[1].drawingNumber === 'A-102'
            && editedRef.entries[1].drawingTitle === '平面図' && editedRef.entries[1].origin === 'MANUAL' && editedRef.updatedAt > reference.updatedAt);
        probe('a correction that changes nothing is not written (NO_CHANGE)', register.editRegisterEntry(edited.drawingSet, { referenceId: reference.id, entryId, values: ROW('A-102', '平面図') }, seams).refusal?.code === 'NO_CHANGE');
        const retiredRow = register.retireRegisterEntry(edited.drawingSet, { referenceId: reference.id, entryId }, seams);
        check('a retired row stays in its reference, retired', retiredRow.ok && retiredRow.drawingSet.drawingRegisterReferences[0].entries.length === 2 && retiredRow.drawingSet.drawingRegisterReferences[0].entries[1].retiredAt !== null);
        probe('a retired row cannot be corrected (ENTRY_RETIRED)', register.editRegisterEntry(retiredRow.drawingSet, { referenceId: reference.id, entryId, values: ROW('A-109') }, seams).refusal?.code === 'ENTRY_RETIRED');
        const withdrawn = register.retireRegisterReference(retiredRow.drawingSet, reference.id, seams);
        check('a withdrawn reference stays, retired, with its rows as they were', withdrawn.ok && withdrawn.drawingSet.drawingRegisterReferences[0].retiredAt !== null && withdrawn.drawingSet.drawingRegisterReferences[0].entries[0].retiredAt === null);
        probe('a withdrawn reference cannot be withdrawn again (REFERENCE_RETIRED)', register.retireRegisterReference(withdrawn.drawingSet, reference.id, seams).refusal?.code === 'REFERENCE_RETIRED');
        const cascade = model.retireSource(set, s2.id);
        check('retiring a Source retires the live registers declared from it at the same instant (REL_RETIRED_STATE)',
            cascade.drawingRegisterReferences[0].retiredAt !== null && cascade.drawingRegisterReferences[0].retiredAt === cascade.sources[1].retiredAt);
        // QA over the typed register: A-101 twice (QA01), A-102 not listed (ANL), " A-103 " listed but no Sheet (LBM).
        const binding = () => 'MATCHED';
        const run = qa.runQa(set, { now: seams.now, newId: () => crypto.randomUUID() });
        const active = run.drawingSet.findings.filter((f) => f.lifecycle.state === 'ACTIVE');
        check('QA over a typed register: QA01 A-101 (two Sheets), ANL A-102, LBM A-103 (trimmed), no QA02 (all confirmed)',
            run.ok && active.length === 3
            && active.some((f) => f.ruleId === 'QA01_DUPLICATE_NUMBER' && f.params.comparisonKey === 'A-101' && f.sheetIds.length === 2)
            && active.some((f) => f.params.reason === 'ACTUAL_NOT_LISTED' && f.params.comparisonKey === 'A-102')
            && active.some((f) => f.params.reason === 'LISTED_BUT_MISSING' && f.params.comparisonKey === 'A-103'), JSON.stringify(active.map((f) => [f.ruleId, f.params])));
        const qa01 = active.find((f) => f.ruleId === 'QA01_DUPLICATE_NUMBER');
        const decided = qa.addDecision(run.drawingSet, { findingId: qa01.id, outcome: 'INTENTIONAL', comment: '同じ図面の差し替え前後。\n\tタブと改行は残る。' }, binding, { now: seams.now, newId: () => crypto.randomUUID() });
        check('a comment keeps its line feeds and tabs', decided.ok && decided.decision.comment.includes('\n\t'));
        for (const [label, comment] of [['a CR', 'a\rb'], ['a NUL', 'a\u0000b'], ['a bidi override', 'a‮b'], ['4001 characters', 'x'.repeat(4001)]]) {
            probe(`a comment with ${label} is refused (COMMENT_INVALID)`, qa.addDecision(run.drawingSet, { findingId: qa01.id, outcome: 'HOLD', comment }, binding, seams).refusal === 'COMMENT_INVALID');
        }
        check('a comment of exactly 4000 characters is accepted', qa.addDecision(run.drawingSet, { findingId: qa01.id, outcome: 'HOLD', comment: 'x'.repeat(4000) }, binding, seams).ok);
        probe('an outcome outside the four is refused (OUTCOME_INVALID)', qa.addDecision(run.drawingSet, { findingId: qa01.id, outcome: 'PASS', comment: '' }, binding, seams).refusal === 'OUTCOME_INVALID');
        const behind = qa.addDecision(run.drawingSet, { findingId: qa01.id, outcome: 'HOLD', comment: '' }, binding, { now: () => '2026-01-01T00:00:00.000Z', newId: () => crypto.randomUUID() });
        check('a clock set back before the Finding still dates the Decision at or after the Finding', behind.ok && behind.decision.decidedAt >= qa01.createdAt, behind.decision?.decidedAt);
        for (const [label, ds] of [['the typed-register state with its run and Decision', decided.drawingSet], ['a withdrawn reference with a retired row', withdrawn.drawingSet], ['a retired Source with its register', cascade], ['64 references', full]]) {
            const file = fileOf(ds);
            const relations = checkRelations(file, { now: Date.now() });
            check(`${label}: schema-valid, no semantic problem, no warning`, validate(schema, file).length === 0 && relations.problems.length === 0 && relations.warnings.length === 0,
                JSON.stringify({ errors: validate(schema, file).slice(0, 2), problems: relations.problems.slice(0, 2), warnings: relations.warnings.slice(0, 2) }));
        }

        // ------------------------------------------------------------------
        section('8. A 5000-Sheet Drawing Set: times (recorded, no threshold)');
        const SOURCES = 50, PAGES = 100;
        const bigSources = Array.from({ length: SOURCES }, (_, i) => source(sha256(Buffer.from(`perf source ${i}`)), PAGES));
        const bigSheets = [];
        bigSources.forEach((src, i) => {
            for (let p = 1; p <= PAGES; p += 1) {
                const n = i * PAGES + p;
                // Every 10th Sheet is unread (QA02 NOT_READ); every 50th repeats its read neighbour's number (QA01).
                const number = `A-${String(n % 50 === 7 ? n - 1 : n).padStart(4, '0')}`;
                bigSheets.push(sheet(src, p, n % 10 === 0 ? null : V4(number)));
            }
        });
        let big = { id: crypto.randomUUID(), name: '図面一式', createdAt: at, sources: bigSources, titleBlockProfiles: [], sheets: bigSheets, drawingRegisterReferences: [], analysisRuns: [], findings: [], decisions: [] };
        // A typed register over five pages of the first Source: 5000 rows, the numbers 1..5000 shifted by 3.
        for (let r = 0; r < 5; r += 1) {
            big = register.declareManualRegister(big, { sourceId: bigSources[0].id, pageNumber: r + 1, rows: Array.from({ length: 1000 }, (_, j) => ROW(`A-${String(r * 1000 + j + 4).padStart(4, '0')}`)) }, seams).drawingSet;
        }
        const time = (fn) => { const t0 = performance.now(); const value = fn(); return [value, performance.now() - t0]; };
        const bindAll = () => 'MATCHED';
        const qaSeams = { now: seams.now, newId: () => crypto.randomUUID() };
        const [evaluation, evalMs] = time(() => qa.evaluateQa(big));
        const [first, firstMs] = time(() => qa.runQa(big, qaSeams, evaluation));
        const [assessment, assessMs] = time(() => qa.assessQa(first.drawingSet, bindAll));
        const [again, againMs] = time(() => qa.runQa(first.drawingSet, qaSeams));
        let changed = again.drawingSet;
        changed = { ...changed, sheets: changed.sheets.map((sh, i) => (i < 100 && sh.confirmation ? { ...sh, confirmation: { ...sh.confirmation, values: V4(`B-${i}`) } } : sh)) };
        const [third, thirdMs] = time(() => qa.runQa(changed, qaSeams));
        const counts = (r) => `+${r.created.length} new, ${r.superseded.length} superseded, ${r.closed.length} closed`;
        note('5000 Sheets, 50 Sources, 5 typed references x 1000 rows', `${evaluation.statements.length} statements`);
        note('evaluate (statements, keys, evidence)', `${evalMs.toFixed(0)} ms`);
        note('first QA run', `${firstMs.toFixed(0)} ms (${counts(first)})`);
        note('assessment (currency of every Finding, readiness, refusal)', `${assessMs.toFixed(0)} ms (${assessment.readiness.status}, ${assessment.readiness.blockers.map((b) => `${b.code} ${b.subjects.length}`).join(', ')})`);
        note('re-run, nothing changed', `${againMs.toFixed(0)} ms (${counts(again)})`);
        note('re-run after 100 Sheets changed number', `${thirdMs.toFixed(0)} ms (${counts(third)})`);
        const thirdFile = fileOf(third.drawingSet);
        const thirdRelations = checkRelations(thirdFile, { now: Date.now() });
        check('the 5000-Sheet runs are accepted and leave the Drawing Set valid', first.ok && again.ok && third.ok
            && validate(schema, thirdFile).length === 0 && thirdRelations.problems.length === 0 && thirdRelations.warnings.length === 0,
            JSON.stringify({ problems: thirdRelations.problems.slice(0, 2), warnings: thirdRelations.warnings.slice(0, 2) }));
        check('a re-run with nothing changed writes no Finding', again.ok && again.created.length === 0 && again.closed.length === 0);
        check('readiness stays FINAL_UNAVAILABLE at 5000 Sheets', assessment.readiness.status === 'FINAL_UNAVAILABLE');
        const byRule = (list) => Object.entries(list.reduce((acc, st) => ({ ...acc, [`${st.ruleId.slice(0, 4)}${st.params.reason && st.ruleId.startsWith('QA09') ? `/${st.params.reason}` : ''}`]: (acc[`${st.ruleId.slice(0, 4)}${st.params.reason && st.ruleId.startsWith('QA09') ? `/${st.params.reason}` : ''}`] ?? 0) + 1 }), {}));
        note('statements by rule', byRule(evaluation.statements).map(([k, v]) => `${k} ${v}`).join(', '));
        check('the 5000-Sheet set states all three rules (QA01, QA02, QA09 both reasons)',
            ['QA01', 'QA02', 'QA09/ACTUAL_NOT_LISTED', 'QA09/LISTED_BUT_MISSING'].every((k) => byRule(evaluation.statements).some(([key]) => key === k)));

        // ------------------------------------------------------------------
        section('9. Part of a register withdrawn: only what it alone listed closes');
        const activeLbm = (ds, key) => ds.findings.find((f) => f.lifecycle.state === 'ACTIVE' && f.params.reason === 'LISTED_BUT_MISSING' && f.params.comparisonKey === key);
        {
            // Register A lists K-1, X-1, S-1; register B lists K-2, Y-1, S-1. Two Sheets carry K-1 and K-2; a third is
            // unread, so a listed number could still be on it: X-1 closes because no live row lists it any more.
            const sA = source('c'.repeat(64), 3), sR = source('d'.repeat(64), 2);
            let ds = { id: crypto.randomUUID(), name: '図面一式', createdAt: at, sources: [sA, sR], titleBlockProfiles: [],
                sheets: [sheet(sA, 1, V4('K-1')), sheet(sA, 2, V4('K-2')), sheet(sA, 3)], drawingRegisterReferences: [], analysisRuns: [], findings: [], decisions: [] };
            ds = register.declareManualRegister(ds, { sourceId: sR.id, pageNumber: 1, rows: [ROW('K-1'), ROW('X-1'), ROW('S-1')] }, seams).drawingSet;
            const refA = ds.drawingRegisterReferences.at(-1).id;
            ds = register.declareManualRegister(ds, { sourceId: sR.id, pageNumber: 2, rows: [ROW('K-2'), ROW('Y-1'), ROW('S-1')] }, seams).drawingSet;
            const r1 = qa.runQa(ds, qaSeams);
            const was = { x: activeLbm(r1.drawingSet, 'X-1'), y: activeLbm(r1.drawingSet, 'Y-1'), s: activeLbm(r1.drawingSet, 'S-1') };
            const qa02 = r1.ok ? r1.drawingSet.findings.find((f) => f.ruleId === qa.QA02) : null;
            check('before: X-1 (A), Y-1 (B) and S-1 (both registers, two rows cited) are listed but missing; the unread page is QA02',
                r1.ok && r1.created.length === 4 && was.x && was.y && was.s && was.s.registerEntryIds.length === 2 && qa02?.params.reason === 'NOT_READ');
            const out = register.retireRegisterReference(r1.drawingSet, refA, seams);
            const r2 = qa.runQa(out.drawingSet, qaSeams);
            const now = (id) => r2.drawingSet.findings.find((f) => f.id === id);
            const anl = r2.drawingSet.findings.filter((f) => f.lifecycle.state === 'ACTIVE' && f.params.reason === 'ACTUAL_NOT_LISTED');
            check('withdrawing A, the next run closes X-1 and nothing else (NOT_REPRODUCED)',
                r2.ok && r2.closed.length === 1 && r2.closed[0] === was.x.id && now(was.x.id).lifecycle.state === 'NOT_REPRODUCED', JSON.stringify(r2.ok && r2.closed));
            check('Y-1, listed by B alone, and the unread page\'s QA02 stay ACTIVE as they were',
                now(was.y.id).lifecycle.state === 'ACTIVE' && !r2.superseded.includes(was.y.id) && now(qa02.id).lifecycle.state === 'ACTIVE' && !r2.superseded.includes(qa02.id));
            check('S-1, still listed by B, is restated citing B\'s row alone (superseded, not closed)',
                r2.superseded.length === 1 && r2.superseded[0] === was.s.id && activeLbm(r2.drawingSet, 'S-1')?.registerEntryIds.length === 1);
            check('K-1, listed by A only, is now a number the register does not list', anl.length === 1 && anl[0].params.comparisonKey === 'K-1');
            const file = fileOf(r2.drawingSet);
            const relations = checkRelations(file, { now: Date.now() });
            check('the state after the withdrawal and the run is schema-valid, no semantic problem, no warning',
                validate(schema, file).length === 0 && relations.problems.length === 0 && relations.warnings.length === 0);
        }

        // The rule a run closed by in 510b05e, one pass over every Sheet and row per Finding, kept here as the
        // reference: on every state below, Production must close exactly the Findings it closed.
        const closedByScan = (ds, ev) => ds.findings.filter((finding) => {
            if (finding.lifecycle.state !== 'ACTIVE' || ev.byKey.has(finding.findingKey)) return false;
            const sheetLive = (id) => { const s = ev.sheetsById.get(id); return s !== undefined && model.isLive(s); };
            const read = (id) => sheetLive(id) && ev.inputs.get(id).origin !== 'NONE';
            switch (finding.ruleId) {
                case qa.QA02: return true;
                case qa.QA01: return finding.sheetIds.every((id) => !sheetLive(id) || read(id));
                case qa.QA09: {
                    if (ev.register.state === 'NONE') return true;
                    if (ev.register.state !== 'EVALUABLE') return false;
                    if (finding.params.reason === 'ACTUAL_NOT_LISTED') return finding.sheetIds.every((id) => !sheetLive(id) || read(id));
                    const key = finding.params.comparisonKey;
                    const found = ev.liveSheets.some((s) => read(s.id) && qa.comparisonKey(ev.inputs.get(s.id).number) === key);
                    const allRead = ev.liveSheets.every((s) => read(s.id));
                    const stillListed = ev.register.entries.some((e) => qa.comparisonKey(e.drawingNumber) === key);
                    return found || allRead || !stillListed;
                }
                default: return false;
            }
        });
        {
            // Seeded states: unread Sheets, numbers that collide, several registers; then rows retired or corrected,
            // registers withdrawn, Sheets re-read or unread, the register's Source changed or removed.
            const random = (seed) => () => {
                seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            const POOL = ['P-1', 'P-2', ' P-2 ', 'P-3', 'P-4', 'P-5', 'P-6', 'P-7'];
            let states = 0, mismatches = 0, compared = 0, closedLbm = 0, keptLbm = 0;
            let firstMismatch = '';
            for (let seedNo = 1; seedNo <= 150; seedNo += 1) {
                const r = random(seedNo);
                const pick = (list) => list[Math.floor(r() * list.length)];
                const sD = source(sha256(Buffer.from(`diff drawings ${seedNo}`)), 8), sL = source(sha256(Buffer.from(`diff register ${seedNo}`)), 4);
                let ds = { id: crypto.randomUUID(), name: '図面一式', createdAt: at, sources: [sD, sL], titleBlockProfiles: [],
                    sheets: Array.from({ length: 8 }, (_, i) => sheet(sD, i + 1, r() < 0.75 ? V4(pick(POOL)) : null)),
                    drawingRegisterReferences: [], analysisRuns: [], findings: [], decisions: [] };
                for (let p = 1, refs = 1 + Math.floor(r() * 4); p <= refs; p += 1) {
                    ds = register.declareManualRegister(ds, { sourceId: sL.id, pageNumber: p, rows: Array.from({ length: 1 + Math.floor(r() * 5) }, () => ROW(pick(POOL))) }, seams).drawingSet;
                }
                for (let round = 0; round < 3; round += 1) {
                    const ran = qa.runQa(ds, qaSeams);
                    if (!ran.ok) break;
                    ds = ran.drawingSet;
                    for (let m = 0, moves = 1 + Math.floor(r() * 3); m < moves; m += 1) {
                        const liveRefs = ds.drawingRegisterReferences.filter(model.isLive);
                        const ref = liveRefs.length > 0 ? pick(liveRefs) : null;
                        const liveRows = ref ? ref.entries.filter(model.isLive) : [];
                        const move = Math.floor(r() * 8);
                        let next = null;
                        if (move === 0 && ref) next = register.retireRegisterReference(ds, ref.id, seams).drawingSet;
                        else if (move === 1 && liveRows.length > 0) next = register.retireRegisterEntry(ds, { referenceId: ref.id, entryId: pick(liveRows).id }, seams).drawingSet;
                        else if (move === 2 && liveRows.length > 0) next = register.editRegisterEntry(ds, { referenceId: ref.id, entryId: pick(liveRows).id, values: ROW(pick(POOL)) }, seams).drawingSet;
                        else if (move === 3 || move === 4) {
                            // A Sheet confirmed with another number, or left with no QA input.
                            const target = Math.floor(r() * ds.sheets.length);
                            const confirmation = move === 3 ? sheet(sD, 1, V4(pick(POOL))).confirmation : null;
                            next = { ...ds, sheets: ds.sheets.map((s, i) => (i === target ? { ...s, confirmation } : s)) };
                        } else if (move === 5 && r() < 0.3) next = model.retireSource(ds, sL.id);
                        else if (move === 6 && r() < 0.3) {
                            next = { ...ds, sources: ds.sources.map((s) => (s.id === sL.id ? { ...s, fingerprint: { ...s.fingerprint, sha256: sha256(Buffer.from(`changed ${seedNo}`)) } } : s)) };
                        } else if (move === 7) {
                            next = register.declareManualRegister(ds, { sourceId: sL.id, pageNumber: 1 + Math.floor(r() * 4), rows: [ROW(pick(POOL))] }, seams).drawingSet ?? null;
                        }
                        if (next) ds = next;
                    }
                    const ev = qa.evaluateQa(ds);
                    const got = qa.planQa(ds, ev).closes.map((f) => f.id).sort();
                    const want = closedByScan(ds, ev).map((f) => f.id).sort();
                    states += 1;
                    compared += ds.findings.filter((f) => f.lifecycle.state === 'ACTIVE').length;
                    const lbm = ds.findings.filter((f) => f.lifecycle.state === 'ACTIVE' && f.params.reason === 'LISTED_BUT_MISSING' && !ev.byKey.has(f.findingKey));
                    closedLbm += lbm.filter((f) => want.includes(f.id)).length;
                    keptLbm += lbm.filter((f) => !want.includes(f.id)).length;
                    if (got.join() !== want.join()) {
                        mismatches += 1;
                        if (!firstMismatch) firstMismatch = `seed ${seedNo} round ${round}: ${got.length} vs ${want.length}`;
                    }
                }
            }
            note('seeded states compared', `${states} states, ${compared} ACTIVE Findings; listed-but-missing no longer stated: ${closedLbm} closed, ${keptLbm} kept open`);
            check('on every seeded state, the run closes exactly the Findings the per-Finding scan closed', states > 0 && mismatches === 0, firstMismatch);
            check('the seeded states reach both outcomes for a listed-but-missing Finding no longer stated (closed, and kept open)', closedLbm > 0 && keptLbm > 0, `${closedLbm} / ${keptLbm}`);
        }
        {
            // 24 registers kept (24000 rows) and 24 withdrawn (24000 rows, each number listed nowhere else).
            const pad = (i) => String(i).padStart(5, '0');
            const drawings = Array.from({ length: 10 }, (_, i) => source(sha256(Buffer.from(`withdraw drawings ${i}`)), 100));
            const sL = source(sha256(Buffer.from('withdraw register')), 48);
            let ds = { id: crypto.randomUUID(), name: '図面一式', createdAt: at, sources: [...drawings, sL], titleBlockProfiles: [],
                sheets: drawings.flatMap((src, i) => Array.from({ length: 100 }, (_, p) => sheet(src, p + 1, V4(`L-${pad(i * 100 + p + 1)}`)))),
                drawingRegisterReferences: [], analysisRuns: [], findings: [], decisions: [] };
            for (let k = 0; k < 24; k += 1) ds = register.declareManualRegister(ds, { sourceId: sL.id, pageNumber: k + 1, rows: Array.from({ length: 1000 }, (_, j) => ROW(`L-${pad(k * 1000 + j + 1)}`)) }, seams).drawingSet;
            const withdraw = [];
            for (let k = 0; k < 24; k += 1) {
                ds = register.declareManualRegister(ds, { sourceId: sL.id, pageNumber: 25 + k, rows: Array.from({ length: 1000 }, (_, j) => ROW(`M-${pad(k * 1000 + j + 1)}`)) }, seams).drawingSet;
                withdraw.push(ds.drawingRegisterReferences.at(-1).id);
            }
            const r1 = qa.runQa(ds, qaSeams);
            let out = r1.drawingSet;
            for (const id of withdraw) out = register.retireRegisterReference(out, id, seams).drawingSet;
            const [ev, evMs] = time(() => qa.evaluateQa(out));
            const [assessed, assessedMs] = time(() => qa.assessQa(out, bindAll, ev));
            const [r2, r2Ms] = time(() => qa.runQa(out, qaSeams, ev));
            const before = new Map(out.findings.map((f) => [f.id, f]));
            const closedKeys = r2.ok ? r2.closed.map((id) => before.get(id).params.comparisonKey) : [];
            const open = r2.ok ? r2.drawingSet.findings.filter((f) => f.lifecycle.state === 'ACTIVE') : [];
            note('1000 Sheets; 24 of 48 registers withdrawn', `${r1.ok ? r1.created.length : 'refused'} listed-but-missing before (24000 withdrawn, 23000 kept)`);
            note('evaluate after the withdrawal', `${evMs.toFixed(0)} ms`);
            note('assessment after the withdrawal (what the QA screen shows)', `${assessedMs.toFixed(0)} ms (refusal ${assessed.refusal.length})`);
            note('the run after the withdrawal', `${r2Ms.toFixed(0)} ms (${r2.ok ? counts(r2) : 'refused'})`);
            check('after 24 of 48 registers are withdrawn, the run closes the 24000 numbers they alone listed, and only those',
                r1.ok && r1.created.length === 47000 && r2.ok && closedKeys.length === 24000 && closedKeys.every((k) => k.startsWith('M-')) && r2.created.length === 0 && r2.superseded.length === 0);
            check('the 23000 numbers the kept registers list stay ACTIVE as they were', open.length === 23000 && open.every((f) => f.params.comparisonKey.startsWith('L-') && before.has(f.id)));
        }

        exitCode = checks.every((c) => c.ok) ? 0 : 1;
    } finally {
        await server.close();
    }
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (${checks.filter((c) => c.name.startsWith('negative probe:')).length} negative probes)`);
    if (failed.length > 0) {
        console.log('FAILED:');
        for (const c of failed) console.log(`  - ${c.name}`);
    }
    process.exit(exitCode);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
