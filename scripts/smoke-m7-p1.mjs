/**
 * M7-P1 foundation gate: the Drawing Set's model, intake, fingerprint and
 * contract, driven through the Production modules in a real browser.
 *
 * What it holds the code to:
 *  - contract drift: the P1 intake constants and patterns equal what the
 *    canonical schema (contracts/m7/portable-project.schema.json) says, read
 *    here from the JSON; the app never loads the schema;
 *  - SHA-256: published vectors, Node crypto at chunk splits around the block
 *    boundary, finalization, and the Production read + Worker path with its
 *    cancellation and protocol refusals;
 *  - intake: every refusal by name, before anything is read where it can be,
 *    atomic commit, duplicate content, the page-count and total-Sheet gates;
 *  - page facts: sizes, rotation, native text, against what the fixture
 *    generator built;
 *  - the in-memory model: a session that has taken files in and retired one
 *    is valid against the canonical schema and passes the canonical semantic
 *    contract (portable-project.semantic.mjs) -- checked by wrapping it, in
 *    this test only, in a file envelope; P1 has no save;
 *  - virtualization bounds, preview document ownership, and no request leaving
 *    the machine;
 *  - M7-P2-A (scripts/smoke-m7-p2a-checks.mjs, after the P1 sections, in the
 *    same browser): profiles, the register adapter over the unchanged Drawing
 *    Register engine, the EXTRACTION run, confirmations, currency, the PDF.js
 *    document gate, the PDF.js data files, and the live P2 model against the
 *    same canonical schema and semantic contract.
 *
 * Run:
 *   node scripts/make-m7-p1-fixtures.mjs        (also builds the P2-A fixtures)
 *   node scripts/smoke-m7-p1.mjs
 *   node scripts/smoke-m7-p1.mjs --browser="C:\Program Files\Google\Chrome\Application\chrome.exe"
 *   node scripts/smoke-m7-p1.mjs --browser="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { runP2aChecks } from './smoke-m7-p2a-checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5214;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures', 'm7-p1');
const SCHEMA_PATH = path.join(ROOT, 'contracts', 'm7', 'portable-project.schema.json');
const SEMANTIC_PATH = path.join(ROOT, 'contracts', 'm7', 'portable-project.semantic.mjs');
const CONTRACT_MANIFEST_PATH = path.join(ROOT, 'contracts', 'm7', 'contract-manifest.json');
const browserArg = process.argv.find((a) => a.startsWith('--browser='))?.slice('--browser='.length) || process.env.M7_BROWSER || '';

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);
const note = (name, detail) => console.log(`  ----  ${name}  ${detail}`);
const section = (title) => console.log(`\n=== ${title} ===`);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The same xorshift32 stream as the harness. */
function payload(length, seed) {
    const out = new Uint8Array(length);
    let x = (seed >>> 0) || 1;
    for (let i = 0; i < length; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17; x >>>= 0;
        x ^= x << 5; x >>>= 0;
        out[i] = x & 0xff;
    }
    return out;
}

// ---------------------------------------------------------------------------
// A small draft-07 subset interpreter, for this test only. It refuses to run
// against a schema that uses a keyword it does not implement, so it cannot
// pass something by not understanding it.
// ---------------------------------------------------------------------------
const SUPPORTED = new Set([
    '$schema', '$id', 'title', 'description', 'x-limit', '$defs', '$ref', 'type', 'const', 'enum', 'anyOf',
    'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
    'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

function unsupportedKeywords(schema) {
    const found = new Set();
    const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            if (!SUPPORTED.has(key)) found.add(key);
            if (key === 'properties' || key === '$defs') Object.values(value).forEach(walk);
            else walk(value);
        }
    };
    walk(schema);
    return [...found];
}

function validate(root, value) {
    const errors = [];
    const typeOk = (type, v) => ({
        object: v !== null && typeof v === 'object' && !Array.isArray(v),
        array: Array.isArray(v),
        string: typeof v === 'string',
        integer: Number.isInteger(v),
        number: typeof v === 'number' && Number.isFinite(v),
        null: v === null,
        boolean: typeof v === 'boolean',
    })[type] ?? false;
    const walk = (schema, v, at) => {
        if (schema.$ref) return walk(root.$defs[schema.$ref.replace('#/$defs/', '')], v, at);
        if (schema.anyOf) {
            const passes = schema.anyOf.some((sub) => {
                const mark = errors.length;
                walk(sub, v, at);
                const ok = errors.length === mark;
                errors.length = mark;
                return ok;
            });
            if (!passes) errors.push(`${at}: matches no anyOf branch`);
            return;
        }
        if (schema.type && !typeOk(schema.type, v)) return void errors.push(`${at}: not ${schema.type}`);
        if ('const' in schema && v !== schema.const) errors.push(`${at}: not const ${schema.const}`);
        if (schema.enum && !schema.enum.includes(v)) errors.push(`${at}: not in enum`);
        if (typeof v === 'string') {
            const length = [...v].length;
            if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
            if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
            if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) errors.push(`${at}: pattern`);
        }
        if (typeof v === 'number') {
            if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${at}: < ${schema.minimum}`);
            if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${at}: > ${schema.maximum}`);
        }
        if (Array.isArray(v)) {
            if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
            if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
            if (schema.items) v.forEach((item, i) => walk(schema.items, item, `${at}/${i}`));
        }
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            for (const key of schema.required ?? []) if (!(key in v)) errors.push(`${at}: missing ${key}`);
            for (const [key, item] of Object.entries(v)) {
                if (schema.properties?.[key]) walk(schema.properties[key], item, `${at}/${key}`);
                else if (schema.additionalProperties === false) errors.push(`${at}: unknown property ${key}`);
            }
        }
    };
    walk(root, value, '#');
    return errors;
}

/** TEST ONLY: the minimum file envelope the schema requires around a model. Not a save format. */
const envelope = (session) => ({
    format: 'pdf-architools/drawing-set-project',
    schemaVersion: 1,
    projectFileId: crypto.randomUUID(),
    lineage: { saveSequence: 1, previousProjectFileId: null, migratedFrom: null },
    savedAt: new Date().toISOString(),
    writer: { app: 'PDF_ArchiTools', toolVersion: '0.1.0' },
    project: session.project,
    drawingSet: session.drawingSet,
});

async function main() {
    if (!fs.existsSync(path.join(FIXTURES, 'manifest.json'))) {
        console.error('No fixtures. Run: node scripts/make-m7-p1-fixtures.mjs');
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
    const fixture = (name) => manifest.files.find((f) => f.name === name);
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const contractManifest = JSON.parse(fs.readFileSync(CONTRACT_MANIFEST_PATH, 'utf8'));
    const { checkRelations, RELATION_PROBLEM } = await import(pathToFileURL(SEMANTIC_PATH).href);

    const server = await createServer({ root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn' });
    await server.listen();
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ...(browserArg ? { executablePath: browserArg } : {}),
    });
    console.log(`browser: ${await browser.version()}${browserArg ? ` (${browserArg})` : ' (bundled)'}`);
    let exitCode = 1;
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(0);
        const external = [];
        const pageErrors = [];
        const assetRequests = [];
        const record = (url) => {
            if (url?.startsWith(`${ORIGIN}/pdfjs/`)) assetRequests.push(url);
            if (!url || url.startsWith(ORIGIN)) return;
            try {
                const { protocol } = new URL(url);
                if (protocol === 'http:' || protocol === 'https:') external.push(url);
            } catch { /* data:, blob: */ }
        };
        page.on('request', (r) => record(r.url()));
        page.on('pageerror', (e) => pageErrors.push(e.message));
        browser.on('targetcreated', async (target) => {
            if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
            try {
                const session = await target.createCDPSession();
                await session.send('Network.enable');
                session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
            } catch { /* gone */ }
        });

        await page.goto(`${ORIGIN}/scripts/smoke-m7-p1-harness.html`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.__m7p1Ready === true, { timeout: 300000 });
        const call = (fn, ...args) => page.evaluate((f, a) => window.__m7p1[f](...a), fn, args);

        // ------------------------------------------------------------------
        section('1. Contract drift: P1 constants against contracts/m7');
        const constants = await call('constants');
        const limits = constants.limits;
        const defs = schema.$defs;
        const drift = [
            ['SourceFingerprint.byteLength.maximum', defs.SourceFingerprint.properties.byteLength, 'maximum', limits.maxSourceBytes, 268435456],
            ['SourceFingerprint.pageCount.maximum', defs.SourceFingerprint.properties.pageCount, 'maximum', limits.maxPagesPerSource, 5000],
            ['DrawingSet.sources.maxItems', defs.DrawingSet.properties.sources, 'maxItems', limits.maxSources, 5000],
            ['DrawingSet.sheets.maxItems', defs.DrawingSet.properties.sheets, 'maxItems', limits.maxSheets, 5000],
            ['PagePoints.maximum', defs.PagePoints, 'maximum', limits.maxPagePoints, 14400],
            ['FileName.maxLength', defs.FileName, 'maxLength', limits.maxFileNameLength, 255],
        ];
        for (const [label, node, keyword, limit, expected] of drift) {
            check(`${label} = P1 constant`, node[keyword] === limit.value && limit.value === expected,
                `schema ${node[keyword]} · P1 ${limit.value}`);
            check(`${label}: same x-limit name`, node['x-limit'] === limit.xLimit, `${node['x-limit']} · ${limit.xLimit}`);
        }
        check('Sheet.pageNumber.maximum = maxPagesPerSource', defs.Sheet.properties.pageNumber.maximum === limits.maxPagesPerSource.value);
        check('256 MiB is marked as the M6-adopted ceiling reused by P1', limits.maxSourceBytes.status === 'M6_ADOPTED_REUSED_BY_P1');
        check('every other bound is marked a canonical pre-release candidate',
            Object.entries(limits).filter(([k]) => k !== 'maxSourceBytes').every(([, v]) => v.status === 'CANONICAL_PRE_RELEASE_CANDIDATE'));
        check('the contract still says the numbers are candidates', contractManifest.resourceLimitsStatus === 'CANDIDATE_PRE_RELEASE');
        check('FileName character rule = schema FileName.pattern',
            defs.FileName.pattern === `^[^${constants.patterns.fileNameForbidden.slice(1, -1)}]+$`);
        check('UUID pattern = schema Uuid.pattern', defs.Uuid.pattern === constants.patterns.uuid);
        check('Timestamp pattern = schema Timestamp.pattern', defs.Timestamp.pattern === constants.patterns.timestamp);
        check('read chunk is 4 MiB (bounded, not a contract value)', constants.readChunkBytes === 4 * 1024 * 1024);

        // ------------------------------------------------------------------
        section('2. SHA-256');
        const known = await call('shaKnown');
        check('empty', known.empty === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        check('"abc"', known.abc === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        check('448-bit message (two blocks)', known.bits448 === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
        check('896-bit message', known.bits896 === 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
        check('one million "a"', known.millionA === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');

        const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 4095, 4096, 4097, 65536, 1_000_003, 4 * 1024 * 1024 + 17];
        const splits = [1, 63, 64, 65, 4095, 4096, 4 * 1024 * 1024];
        const splitResult = await call('shaSplits', { lengths: lengths.filter((n) => n <= 65536), splits, seed: 101 });
        const bigResult = await call('shaSplits', { lengths: lengths.filter((n) => n > 65536), splits: splits.filter((s) => s >= 63), seed: 101 });
        let compared = 0;
        let mismatched = [];
        for (const result of [splitResult, bigResult]) {
            for (const [length, bySplit] of Object.entries(result)) {
                const expected = sha256(payload(Number(length), 101 + Number(length)));
                for (const [split, digest] of Object.entries(bySplit)) {
                    compared += 1;
                    if (digest !== expected) mismatched.push(`${length}/${split}`);
                }
            }
        }
        check('equals node:crypto at every length and chunk split', mismatched.length === 0 && compared > 100,
            `${compared} comparisons; splits ${splits.join('/')}${mismatched.length ? `; mismatched ${mismatched.join(',')}` : ''}`);
        const det = await call('shaSplits', { lengths: [4097], splits: [64], seed: 101 });
        check('deterministic: the same bytes give the same digest twice', det['4097']['64'] === splitResult['4097']['64']);
        const final = await call('shaFinalization');
        check('update after digest is refused', final.updateAfter);
        check('a second digest is refused', final.digestTwice);
        check('reset() starts a new message', final.resetSame);
        const web = await call('webCrypto', { lengths: [0, 3, 64, 1000, 70000], seed: 5 });
        check('Web Crypto agrees on small inputs (test evidence only)', web.every((r) => r.same), web.map((r) => r.length).join(','));

        section('3. Fingerprint Worker (Production read path)');
        for (const [length, chunkBytes] of [[1, 1], [63, 63], [64 * 1024 + 1, 64], [65 * 1024, 65], [100_000, 4095], [100_000, 4096], [9 * 1024 * 1024 + 3, 4 * 1024 * 1024]]) {
            const r = await call('workerFingerprint', { length, seed: 900 + length, chunkBytes });
            check(`Worker digest = node:crypto (${length} B in ${chunkBytes} B chunks)`, r.sha256 === sha256(payload(length, 900 + length)) && r.copied,
                `${r.ms.toFixed(0)} ms; analysis buffer holds the same bytes: ${r.copied}`);
        }
        const cancel = await call('workerCancel');
        check('cancel mid-file: no digest, a cancellation (no refusal)', cancel.result.kind === 'IntakeStop' && cancel.result.refusal === null,
            `after ${cancel.progressCalls} chunks`);
        const protocol = await call('workerProtocol');
        check('a second chunk while one is pending is refused', protocol.secondWhilePending === 'PROTOCOL_VIOLATION');
        check('finish with the wrong byte count is refused', protocol.wrongCount === 'BYTE_COUNT_MISMATCH');
        check('after a failure, the next step reports that failure, not a cancellation', protocol.afterFailure === 'BYTE_COUNT_MISMATCH', protocol.afterFailure);
        check('nothing is accepted after cancel', protocol.pushAfterCancel === 'CANCELLED');
        check('chunked through the Worker, "abc" is the known digest', protocol.abc === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        check('every fingerprint Worker was terminated', protocol.workers.live === 0, `started ${protocol.workers.started}, terminated ${protocol.workers.terminated}`);

        // ------------------------------------------------------------------
        section('4. Intake gate');
        const policy = await call('policy');
        check('256 MiB exactly passes the size preflight', policy.atBound === 'OK');
        check('256 MiB + 1 is refused by the size preflight', policy.pastBound === 'SOURCE_TOO_LARGE');
        check('zero bytes is refused', policy.zero === 'EMPTY_FILE');
        check('5000 Sources held: refused', policy.sourcesFull === 'SOURCE_LIMIT');
        check('5000 Sheets held: refused', policy.sheetsFull === 'SHEET_LIMIT');
        check('5000 pages passes, 5001 is refused, 0 is not a PDF',
            policy.pages5000 === 'OK' && policy.pages5001 === 'PAGE_COUNT_LIMIT' && policy.pagesZero === 'NOT_A_PDF');
        check('total Sheets: 4996 + 4 passes, 4996 + 5 is refused', policy.aggregateAt === 'OK' && policy.aggregatePast === 'SHEET_LIMIT');
        const n = policy.names;
        check('valid names pass (Japanese, 255 characters, an astral character counted once)',
            n.japanese === 'OK' && n.len255 === 'OK' && n.astral255 === 'OK');
        check('invalid names are refused (256 chars, / \\ :, direction override, isolate, line separator, control, . .. blank empty, lone surrogate)',
            ['len256', 'slash', 'backslash', 'colon', 'rlo', 'isolate', 'lineSep', 'control', 'dot', 'dotdot', 'blank', 'empty', 'loneSurrogate']
                .every((k) => n[k] === 'FILE_NAME_INVALID'),
            JSON.stringify(n));

        const oversize = await call('oversize');
        check('a 256 MiB + 1 file is refused without reading or allocating it',
            oversize.outcome.code === 'SOURCE_TOO_LARGE' && oversize.reads === 0 && oversize.allocations === 0,
            `reads ${oversize.reads}, allocations ${oversize.allocations}`);
        const names = await call('invalidNames');
        check('invalid File names are refused before allocation',
            Object.values(names).every((r) => r.code === 'FILE_NAME_INVALID' && r.allocations === 0), JSON.stringify(names));

        const empty = await call('intakeFixture', 'gate', 'p1-empty');
        check('zero-byte file refused', empty.outcome.code === 'EMPTY_FILE' && empty.allocations === 0);

        // A, then everything that must fail, then the Drawing Set must be exactly A.
        const a = await call('intakeFixture', 'gate', 'p1-native-a');
        check('fixture A accepted and committed', a.outcome.kind === 'candidate' && a.commit === 'committed', `${a.live.sheets} sheets`);
        check('A fingerprint = node:crypto of the file', a.outcome.source?.fingerprint.sha256 === fixture('p1-native-a').sha256);
        for (const [name, code] of [
            ['p1-not-a-pdf', 'NOT_A_PDF'],
            ['p1-password', 'PASSWORD_PROTECTED'],
            ['p1-page-past-bound', 'PAGE_SIZE_OUT_OF_RANGE'],
            ['p1-user-unit', 'PAGE_USER_UNIT_UNSUPPORTED'],
            ['p1-5001-pages', 'PAGE_COUNT_LIMIT'],
        ]) {
            const r = await call('intakeFixture', 'gate', name);
            check(`${name}: refused ${code}, Drawing Set untouched`, r.outcome.code === code && r.unchanged && r.live.sources === 1,
                r.outcome.code ?? r.outcome.kind);
            if (name === 'p1-5001-pages') {
                check('page-count gate fires before any page is read', !r.phases.includes('inventory'), r.phases.join('>'));
            }
        }
        const mixed = await call('intakeFixture', 'gate', 'p1-mixed-past-bound');
        check('page 2 past the bound: refused after page 1 was read, nothing of it kept',
            mixed.outcome.code === 'PAGE_SIZE_OUT_OF_RANGE' && mixed.maxInventoryPage === 1 && mixed.unchanged,
            `inventory reached page ${mixed.maxInventoryPage}`);
        const atBound = await call('intakeFixture', 'gate', 'p1-page-at-bound');
        check('a 14400 x 14400 pt page is accepted', atBound.commit === 'committed'
            && atBound.outcome.sheets?.[0]?.pageFacts.uprightWidthPt === 14400);

        const dup = await call('intakeFixture', 'gate', 'p1-native-a-copy');
        check('same bytes under another name: duplicate, names the existing Source, not committed',
            dup.outcome.kind === 'duplicate' && dup.outcome.existingName === 'p1-native-a.pdf' && dup.unchanged,
            dup.outcome.existingName ?? dup.outcome.kind);
        const sameName = await call('intakeFixture', 'gate', 'p1-second-c', 'p1-native-a.pdf');
        check('same name, different bytes: a new Source (a name is never identity)', sameName.commit === 'committed');
        check('every fingerprint Worker was terminated after the intakes', sameName.workers.live === 0);

        section('5. Total-Sheet gate and cancellation');
        const seeded = await call('seedSheets', 'aggregate', 4996);
        check('seeded 4996 Sheets', seeded.held.sheets === 4996);
        const fill = await call('intakeFixture', 'aggregate', 'p1-native-a');
        check('4996 + 4 = 5000: accepted', fill.commit === 'committed' && fill.held.sheets === 5000);
        const over = await call('intakeFixture', 'aggregate', 'p1-second-c');
        check('one more file at 5000 Sheets: refused before reading', over.outcome.code === 'SHEET_LIMIT' && over.allocations === 0 && over.unchanged);
        await call('seedSheets', 'aggregate2', 4997);
        const past = await call('intakeFixture', 'aggregate2', 'p1-native-a');
        check('4997 + 4 pages: refused when the page count is known, before inventory',
            past.outcome.code === 'SHEET_LIMIT' && !past.phases.includes('inventory') && past.unchanged);
        const cancelled = await call('intakeFixture', 'cancel', 'p1-5000-pages', undefined, {});
        note('5000-page intake', `${cancelled.outcome.kind}, ${cancelled.held.sheets} sheets`);
        check('a 5000-page Source is accepted whole', cancelled.commit === 'committed' && cancelled.held.sheets === 5000);
        const abortedRun = await page.evaluate(() => window.__m7p1.intakeFixture('cancel2', 'p1-5000-pages', undefined, {
            abortAt: (p) => p.phase === 'inventory' && p.pagesDone >= 25,
        }));
        check('cancel during inventory: cancelled, nothing committed, Worker gone',
            abortedRun.outcome.kind === 'cancelled' && abortedRun.commit === null && abortedRun.held.sheets === 0 && abortedRun.workers.live === 0,
            `inventory reached page ${abortedRun.maxInventoryPage}`);
        const abortedRead = await page.evaluate(() => window.__m7p1.intakeFixture('cancel3', 'p1-5000-pages', undefined, {
            chunkBytes: 65536,
            abortAt: (p) => p.phase === 'reading' && p.bytesDone >= 65536 * 3,
        }));
        check('cancel during reading: cancelled, nothing committed, Worker gone',
            abortedRead.outcome.kind === 'cancelled' && abortedRead.held.sheets === 0 && abortedRead.workers.live === 0);

        // ------------------------------------------------------------------
        section('6. Page facts');
        const facts = await call('pageFacts');
        check('A4 box', facts.a4 === '595.28x841.89@0');
        check('offset CropBox: size of the box, not its corner', facts.offset === '500x400@180');
        check('270 is kept', facts.rot270 === '595.28x841.89@270');
        check('45 / 360 rotations refused, not coerced', facts.rot45 === 'PAGE_ROTATION_INVALID' && facts.rot360 === 'PAGE_ROTATION_INVALID');
        check('UserUnit refused', facts.userUnit === 'PAGE_USER_UNIT_UNSUPPORTED');
        check('zero, negative, NaN sizes refused', [facts.zero, facts.negative, facts.nan].every((v) => v === 'PAGE_SIZE_INVALID'));
        check('14400 accepted, 14401 refused', facts.atBound === '14400x14400@0' && facts.pastBound === 'PAGE_SIZE_OUT_OF_RANGE');
        check('float noise from box arithmetic is not recorded', facts.noise === '595.28x841.89@0', facts.noise);
        const t = facts.text;
        check('meaningful text: letters and kanji yes; spaces, ideographic space, soft hyphen, zero-width, U+FFFD no',
            t.letter && t.kanji && !t.spaces && !t.ideographicSpace && !t.softHyphen && !t.zeroWidth && !t.replacement);

        const sheetFacts = (result) => (result.outcome.sheets ?? []).map((s) => s.pageFacts);
        const expectFacts = (name, got) => {
            const want = fixture(name).facts;
            const same = got.length === want.length && want.every((w, i) =>
                Math.abs(got[i].uprightWidthPt - w.uprightWidthPt) < 0.001
                && Math.abs(got[i].uprightHeightPt - w.uprightHeightPt) < 0.001
                && got[i].rotate === w.rotate && got[i].kind === w.kind
                && got[i].sourceSha256 === fixture(name).sha256);
            check(`${name}: page facts = what the generator built`, same,
                got.map((f) => `${f.uprightWidthPt}x${f.uprightHeightPt}@${f.rotate}/${f.kind}`).join(' '));
        };
        expectFacts('p1-native-a', sheetFacts(a));
        const b = await call('intakeFixture', 'facts', 'p1-image-only-b');
        expectFacts('p1-image-only-b', sheetFacts(b));
        const c = await call('intakeFixture', 'facts', 'p1-second-c');
        expectFacts('p1-second-c', sheetFacts(c));
        check('page numbers run 1..n in order', sheetFacts(c).length === 3 && c.outcome.sheets.every((s, i) => s.pageNumber === i + 1));
        check('P2/P3 fields are empty on every Sheet',
            [...a.outcome.sheets, ...b.outcome.sheets].every((s) => s.profileAssignment === null && s.observation === null
                && s.confirmation === null && s.confirmationHistory.length === 0));

        // ------------------------------------------------------------------
        section('7. The in-memory model against the canonical contract');
        const retired = await call('retire', 'facts', 0);
        check('retiring a Source retires its Sheets and nothing else',
            retired.retiredSheetsLive === 0 && retired.othersSame && retired.live.sources === 1 && retired.held.sources === 2,
            `retired ${retired.retiredName}; held ${retired.held.sheets} sheets, live ${retired.live.sheets}`);
        const readd = await call('intakeFixture', 'facts', 'p1-image-only-b');
        check('the bytes of a retired Source can be added again as a new Source', readd.commit === 'committed');
        for (const key of ['gate', 'facts']) {
            const session = await call('session', key);
            const file = envelope(session);
            const errors = validate(schema, file);
            check(`session "${key}" is valid against portable-project.schema.json`, errors.length === 0, errors.slice(0, 3).join(' | '));
            const relations = checkRelations(file, { now: Date.now() });
            check(`session "${key}" passes portable-project.semantic.mjs`, relations.problems.length === 0 && relations.warnings.length === 0,
                JSON.stringify(relations).slice(0, 200));
        }
        check('the interpreter implements every keyword the schema uses', unsupportedKeywords(schema).length === 0, unsupportedKeywords(schema).join(','));
        const base = envelope(await call('session', 'facts'));
        const mutate = (fn) => { const copy = structuredClone(base); fn(copy); return copy; };
        const rejects = (label, fn) => probe(`the schema check rejects ${label}`, validate(schema, mutate(fn)).length > 0);
        rejects('an extra property on a Sheet', (f) => { f.drawingSet.sheets[0].thumbnail = 'x'; });
        rejects('rotate 45', (f) => { f.drawingSet.sheets[0].pageFacts.rotate = 45; });
        rejects('an upper-case UUID', (f) => { f.drawingSet.sources[0].id = f.drawingSet.sources[0].id.toUpperCase(); });
        rejects('a path in displayName', (f) => { f.drawingSet.sources[0].displayName = 'C:/drawings/a.pdf'; });
        rejects('a page 14401 pt wide', (f) => { f.drawingSet.sheets[0].pageFacts.uprightWidthPt = 14401; });
        rejects('256 MiB + 1 bytes', (f) => { f.drawingSet.sources[0].fingerprint.byteLength = 268435457; });
        const relationProblem = (fn) => checkRelations(mutate(fn), { now: Date.now() }).problems.map((p) => p.code);
        probe('the semantic check rejects two live Sources with the same bytes',
            relationProblem((f) => {
                const live = f.drawingSet.sources.filter((s) => s.retiredAt === null);
                live[0].fingerprint.sha256 = live[1].fingerprint.sha256;
            }).includes(RELATION_PROBLEM.DUPLICATE_SOURCE_CONTENT));
        probe('the semantic check rejects a live Sheet of a retired Source',
            relationProblem((f) => {
                const retiredSource = f.drawingSet.sources.find((s) => s.retiredAt !== null);
                f.drawingSet.sheets.find((s) => s.sourceId === retiredSource.id).retiredAt = null;
            }).includes(RELATION_PROBLEM.RETIRED_STATE));

        // ------------------------------------------------------------------
        section('8. Virtualization bounds');
        const v = await call('virtual');
        const rows = (w) => w.end - w.start;
        check('5000 rows: start, middle and end windows stay within the bound',
            [v.start, v.middle, v.end].every((w) => rows(w) > 0 && rows(w) <= v.bound),
            `bound ${v.bound}; start ${rows(v.start)} middle ${rows(v.middle)} end ${rows(v.end)}`);
        check('the window covers the scrolled-to rows', v.middle.start <= 2500 && v.middle.end > 2500 && v.end.end === 5000 && v.start.start === 0);
        check('out-of-range scroll is clamped', v.beyond.end === 5000 && v.negative.start === 0 && v.empty.end === 0);
        check('total height is rows x row height', v.start.totalHeight === 5000 * 48);
        check('reveal scrolls only as far as needed', v.reveal.visible === 0 && v.reveal.first === 0
            && v.reveal.last === 5000 * 48 - 600 && v.reveal.middle === 2501 * 48 - 600);

        section('9. Preview document ownership');
        const owner = await call('previewOwner');
        check('one document per Source; the same Source reuses it', owner.sameDocReused && owner.afterSame.opened === 1);
        check('opening another Source destroys the previous document', owner.aDestroyed && owner.afterC.live === 1 && owner.afterC.destroyed === 1);
        check('never more than one live document', [owner.afterA, owner.afterSame, owner.afterC, owner.afterMismatch].every((c) => c.live <= 1));
        check('a File whose size no longer matches is not opened', owner.sizeMismatch === 'SOURCE_CHANGED');
        check('a File whose bytes no longer match the fingerprint is not opened', owner.shaMismatch === 'SOURCE_CHANGED' && owner.afterMismatch.opened === owner.afterC.opened);
        check('a failed open is not kept: the same Source opens on the next try', owner.retried === 'opened');
        check('a preview read no longer wanted stops part-way; the next one then opens',
            owner.abandoned === 'CLOSED' && owner.replacement === 4 && owner.slowCounts.readsStopped === 1 && owner.slowCounts.opened === 1,
            JSON.stringify(owner.slowCounts));
        check('the fingerprint Workers of the preview reads are gone', owner.workers.live === 0);
        check('a cancelled render ends as cancelled', owner.cancelled === 'RenderingCancelledException', owner.cancelled);
        check('close destroys the held document', owner.cDestroyedAfterClose && owner.afterClose.live === 0);

        section('10. Preview document release (RF-35-01)');
        const rel = await call('previewRelease');
        // The next document starts only after the held one has ended.
        const startsAfterEnd = (events) => {
            const end = events.indexOf('document-end');
            return end >= 0 && events.indexOf('document-start') > end;
        };
        check('asking to destroy is not counted as destroyed',
            rel.atRequest.destroyRequested === 1 && rel.atRequest.destroyed === 0 && rel.atRequest.live === 1,
            JSON.stringify(rel.atRequest));
        check('while the previous document is still being destroyed, no new document is opened',
            rel.midway.counts.opened === 1 && rel.midway.started === 1 && rel.midway.pdfLive === 1 && rel.midway.counts.destroyed === 0,
            `opened ${rel.midway.counts.opened}, PDF.js documents started ${rel.midway.started}, live ${rel.midway.pdfLive}`);
        check('the new document starts only after PDF.js has destroyed the previous one',
            rel.switchEvents[0] === 'document-start' && startsAfterEnd(rel.switchEvents.slice(1)) && rel.docCPages === 3, rel.switchEvents.join(' > '));
        check('after the switch: one document opened, one destroyed, one live',
            rel.afterC.opened === 2 && rel.afterC.destroyed === 1 && rel.afterC.live === 1);
        check('close() twice asks once, and resolves once PDF.js has finished',
            rel.closeAsked.destroyRequested === rel.afterC.destroyRequested + 1 && rel.closeAsked.destroyed === rel.afterC.destroyed
            && rel.closeDone.counts.destroyed === rel.closeDone.counts.destroyRequested && rel.closeDone.counts.live === 0 && rel.closeDone.pdfLive === 0
            && rel.afterSecondClose.destroyRequested === rel.closeAsked.destroyRequested,
            `asked ${rel.closeAsked.destroyRequested}/${rel.closeAsked.destroyed}, done ${rel.closeDone.counts.destroyed}, PDF.js live ${rel.closeDone.pdfLive}`);
        check('rapid switching: only the last choice opens, after the held document is gone',
            JSON.stringify(rel.rapidOutcomes) === JSON.stringify(['CLOSED', 'CLOSED', 4]) && rel.afterRapid.startedDuring === 1
            && startsAfterEnd(rel.afterRapid.events) && rel.afterRapid.counts.live === 1 && rel.afterRapid.pdfLive === 1,
            `${JSON.stringify(rel.rapidOutcomes)}; ${rel.afterRapid.events.join(' > ')}`);
        check('removing another Source keeps the held document; removing its own destroys it',
            rel.otherRemoved.sourceId === 'A' && rel.otherRemoved.pdfLive === 1
            && rel.ownRemoved.sourceId === null && rel.ownRemoved.counts.live === 0 && rel.ownRemoved.pdfLive === 0);
        // A destruction PDF.js reports as failed: its document is not known to
        // be gone, so nothing is opened after it.
        const [before, after, later] = [rel.beforeFailure, rel.afterFailure, rel.afterRefusals];
        const opensNothing = (s) => s.counts.opened === before.counts.opened && s.getDocs === before.getDocs
            && s.started === before.started && s.pdfLive === 1 && s.counts.live === 1;
        const getDocLine = (s) => `opened ${s.counts.opened}, getDocument ${s.getDocs}, PDF.js workers started ${s.started}, live ${s.pdfLive}`;
        check('getDocument() calls reaching PDF.js are counted, one per document the owner opened',
            before.getDocs === before.counts.opened && before.started === before.counts.opened, getDocLine(before));
        check('a destruction PDF.js reports as failed is counted as failed, not done; its document stays live',
            after.counts.destroyFailed === before.counts.destroyFailed + 1 && after.counts.destroyed === before.counts.destroyed
            && after.counts.destroyRequested === before.counts.destroyRequested + 1 && after.counts.live === 1 && after.pdfLive === 1,
            JSON.stringify(after.counts));
        check('after it the next document is not opened: refused, no getDocument(), no new PDF.js worker',
            rel.refused === 'RELEASE_UNCONFIRMED' && opensNothing(after), `${rel.refused}; ${getDocLine(after)}`);
        check('the refusal stands: later opens are refused too, even once PDF.js could destroy again',
            rel.refusedLater.every((code) => code === 'RELEASE_UNCONFIRMED') && opensNothing(later),
            `${JSON.stringify(rel.refusedLater)}; ${getDocLine(later)}`);
        check('the viewer shows no page and tells the user to reload',
            rel.viewerShown.state === 'error' && rel.viewerShown.alert.includes('再読み込み'), JSON.stringify(rel.viewerShown));
        check('PDF.js documents never overlapped, failure included; none left once released by hand',
            rel.final.peak === 1 && rel.final.pdfLive === 0, `peak ${rel.final.peak}, left ${rel.final.pdfLive}`);
        check('the fingerprint Workers of these reads are gone', rel.workers.live === 0);

        section('11. Viewer page and render cleanup (RF-35-02)');
        const vw = await call('viewerLifecycle');
        const [p1, p2, p3] = vw.sheetIds;
        const cleanups = vw.log.filter((e) => e.startsWith('cleanup:'));
        const fetchesOf = (n) => vw.log.filter((e) => e === `page:${n}`).length;
        const cleanupsOf = (n) => cleanups.filter((e) => e.startsWith(`cleanup:${n}:`)).length;
        const lateAt = vw.late.log.indexOf('page:1');
        check('a page that arrives after another Sheet was chosen is cleaned up',
            lateAt >= 0 && vw.late.log.slice(lateAt + 1).includes('cleanup:1:0'), vw.late.log.join(' '));
        check('nothing is drawn from that late page', vw.late.rendersOfLatePage === 0);
        check('switching after a render completed counts no cancellation',
            vw.afterDone.renderCancelled === vw.beforeDone.renderCancelled
            && vw.afterDone.renderStarted === vw.beforeDone.renderStarted + 1 && vw.afterDone.renderCompleted === vw.beforeDone.renderCompleted + 1,
            `cancelled ${vw.beforeDone.renderCancelled} -> ${vw.afterDone.renderCancelled}`);
        check('switching during a render cancels it and counts it once',
            vw.afterRunning.renderCancelled === vw.beforeRunning.renderCancelled + 1
            && JSON.stringify(vw.page4Outcomes) === JSON.stringify(['RenderingCancelledException'])
            && vw.afterRunning.renderStarted === vw.beforeRunning.renderStarted + 2 && vw.afterRunning.renderCompleted === vw.beforeRunning.renderCompleted + 1,
            `cancelled ${vw.beforeRunning.renderCancelled} -> ${vw.afterRunning.renderCancelled}; page 4 ${vw.page4Outcomes.join(',')}`);
        check('the viewer going away during a render cancels it and counts it once',
            vw.afterUnmount.renderCancelled === vw.beforeUnmount.renderCancelled + 1);
        check('no page is cleaned up while a render of it is still running',
            cleanups.length > 0 && cleanups.every((e) => e.endsWith(':0')), cleanups.join(' '));
        check('every page fetched is cleaned up, once per fetch',
            [1, 2, 3, 4].every((n) => fetchesOf(n) > 0 && cleanupsOf(n) === fetchesOf(n)),
            [1, 2, 3, 4].map((n) => `p${n} ${fetchesOf(n)}/${cleanupsOf(n)}`).join(', '));
        check('only the Sheet chosen last was ever shown as rendered',
            JSON.stringify(vw.shown) === JSON.stringify([p2, p3, p1]), vw.shown.map((id) => `p${vw.sheetIds.indexOf(id) + 1}`).join(' > '));
        check('every render that started ended exactly once: completed, cancelled or failed',
            vw.final.renderStarted === vw.final.renderCompleted + vw.final.renderCancelled + vw.final.renderFailed && vw.final.renderFailed === 0,
            `started ${vw.final.renderStarted}, completed ${vw.final.renderCompleted}, cancelled ${vw.final.renderCancelled}, failed ${vw.final.renderFailed}`);
        check('the viewer\'s document is destroyed with its owner; no fingerprint Worker left', vw.final.live === 0 && vw.workers.live === 0);

        section('12. Privacy');
        const workers = await call('workers');
        check('no fingerprint Worker left running', workers.live === 0, `started ${workers.started}`);
        check('no request left the machine', external.length === 0, external.join(', '));
        check('no uncaught page error', pageErrors.length === 0, pageErrors.join(' | '));

        await runP2aChecks({
            page, ROOT, ORIGIN, check, probe, note, section, validate, envelope, schema, checkRelations, RELATION_PROBLEM, assetRequests,
        });

        section('28. The whole run, P1 and P2-A');
        check('no request left the machine', external.length === 0, external.join(', '));
        check('no uncaught page error', pageErrors.length === 0, pageErrors.join(' | '));

        const failed = checks.filter((c) => !c.ok);
        const probes = checks.filter((c) => c.name.startsWith('negative probe')).length;
        console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (${probes} negative probes)`);
        if (failed.length > 0) {
            console.log('FAILED:');
            for (const f of failed) console.log(`  - ${f.name}`);
        }
        exitCode = failed.length === 0 ? 0 : 1;
    } catch (error) {
        console.error(`\nSmoke run failed: ${error?.stack ?? error}\n`);
    } finally {
        await browser.close().catch(() => { });
        await server.close().catch(() => { });
    }
    process.exit(exitCode);
}

main();
