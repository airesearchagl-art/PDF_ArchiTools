/**
 * Score the table-detection prototypes against the corpus.
 *
 * Runs in Node over the token dumps the browser probe wrote, so the same input
 * is scored the same way every time. Three signals crossed with three UX
 * shapes, on positive cases and on the adversarial drawing content that is
 * meant to be left alone.
 *
 * Run:  node scripts/research-m2-4-geometry.mjs && node scripts/research-m2-4-tables.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES, statusFor } from '../research/m2-4/prototype/detect.mjs';
import { scorePage, totals } from '../research/m2-4/prototype/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test-fixtures', 'm2-4');
const TOKENS = path.join(FIX, 'tokens');
const OUT = path.join(FIX, 'results');

if (!fs.existsSync(TOKENS)) {
    console.error('No token dumps. Run: node scripts/research-m2-4-geometry.mjs');
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const names = fs.readdirSync(FIX).filter((f) => f.endsWith('.truth.json'))
    .map((f) => f.replace(/\.truth\.json$/, '')).sort();
const read = (file) => JSON.parse(fs.readFileSync(path.join(TOKENS, file), 'utf8'));
const truthOf = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.truth.json`), 'utf8'));

/**
 * The tokens a reconstructor would actually be handed for a page.
 *
 * A native page gives its own text; a scanned one gives OCR boxes. The mixed
 * document needs both, page by page, which is exactly the case a real drawing
 * set presents.
 */
function tokensFor(name, ocrVariant = 'shipped') {
    const native = read(`native-${name}.json`);
    const prefix = ocrVariant === 'shipped' ? 'ocr' : 'ocrpsm';
    const ocrFile = path.join(TOKENS, `${prefix}-${name}.json`);
    const ocr = fs.existsSync(ocrFile) ? read(`${prefix}-${name}.json`) : null;
    const paths = read(`paths-${name}.json`);
    return native.pages.map((p, i) => {
        const ocrPage = ocr?.pages?.[i];
        const useOcr = p.tokens.length === 0 && ocrPage;
        return {
            page: p.page,
            width: p.width,
            height: p.height,
            source: useOcr ? 'ocr' : 'native',
            tokens: useOcr ? ocrPage.tokens : p.tokens,
            segments: paths.pages[i]?.segments ?? [],
        };
    });
}

const clip = (tokens, box, pad = 4) => tokens.filter((t) => {
    const cx = (t.x0 + t.x1) / 2;
    const cy = (t.y0 + t.y1) / 2;
    return cx >= box.left - pad && cx <= box.right + pad && cy >= box.top - pad && cy <= box.bottom + pad;
});

/**
 * The three UX shapes, run on identical input.
 *
 *   auto     the whole page, nothing asked of the user
 *   region   only what is inside the real table's box, as if the user drew it
 *   confirm  the whole page, but only confident candidates are accepted and the
 *            rest are held back for someone to look at
 */
function runMode(mode, strategy, page, truthTables) {
    const detect = STRATEGIES[strategy];
    if (mode === 'auto') {
        return { detected: detect(page.tokens, page.segments, {}), held: [] };
    }
    if (mode === 'region') {
        // Nothing to select on a page with no table: the user would not have
        // drawn a box, so nothing is detected and nothing is missed.
        const out = [];
        for (const t of truthTables) {
            const inside = clip(page.tokens, t.bbox);
            const segs = page.segments.filter((s) => s.x1 >= t.bbox.left - 4 && s.x0 <= t.bbox.right + 4
                && s.y1 >= t.bbox.top - 4 && s.y0 <= t.bbox.bottom + 4);
            out.push(...detect(inside, segs, {}));
        }
        return { detected: out, held: [] };
    }
    const all = detect(page.tokens, page.segments, {});
    const detected = [];
    const held = [];
    for (const t of all) (statusFor(t) === 'TABLE_CONFIDENT' ? detected : held).push(t);
    return { detected, held };
}

const MODES = ['auto', 'region', 'confirm'];
const SIGNALS = ['geometry', 'ruling', 'hybrid'];

/**
 * Which OCR tokens to score with.
 *
 * The default is what the app produces today. `--ocr-auto` scores the same
 * pages with the segmentation set explicitly, which is the only way to tell
 * "a reconstructor cannot work from this" apart from "the recogniser was never
 * asked to look inside the box".
 */
const OCR_VARIANT = process.argv.includes('--ocr-auto') ? 'psm-auto' : 'shipped';

const results = {};
for (const mode of MODES) {
    for (const signal of SIGNALS) {
        const key = `${mode}/${signal}`;
        const perFixture = [];
        for (const name of names) {
            const truth = truthOf(name);
            const pages = tokensFor(name, OCR_VARIANT);
            const scored = [];
            let held = 0;
            for (const page of pages) {
                const truthTables = truth.pages.find((p) => p.page === page.page)?.tables ?? [];
                const run = runMode(mode, signal, page, truthTables);
                held += run.held.length;
                scored.push(scorePage({ detected: run.detected, truthTables }));
            }
            perFixture.push({ name, kind: truth.kind, pages: scored, held, source: pages.map((p) => p.source) });
        }
        results[key] = perFixture;
    }
}

const suffix = OCR_VARIANT === 'shipped' ? '' : '-ocr-auto';
fs.writeFileSync(path.join(OUT, `detection${suffix}.json`), `${JSON.stringify(results, null, 1)}\n`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (v) => `${(v * 100).toFixed(0)}%`;
const summarise = (perFixture, filter) => totals(perFixture.filter(filter).flatMap((f) => f.pages));

const positives = names.filter((n) => truthOf(n).kind !== 'adversarial');
const adversarials = names.filter((n) => truthOf(n).kind === 'adversarial');
const truthTableCount = positives.reduce((n, name) =>
    n + truthOf(name).pages.reduce((m, p) => m + p.tables.length, 0), 0);

console.log(`\n  OCR tokens: ${OCR_VARIANT === 'shipped' ? 'as the app produces them today' : 'segmentation set to AUTO (research only)'}`);
console.log(`\n=== detection: positives (${truthTableCount} tables across ${positives.length} fixtures) ===`);
console.log('  mode/signal        found  matched  missed   FP   cell acc   text kept   exact grid');
for (const mode of MODES) {
    for (const signal of SIGNALS) {
        const t = summarise(results[`${mode}/${signal}`], (f) => f.kind !== 'adversarial');
        console.log(`  ${`${mode}/${signal}`.padEnd(18)} ${String(t.detected).padStart(5)} ${String(t.matched).padStart(8)} ${String(t.falseNegatives).padStart(7)} ${String(t.falsePositives).padStart(4)}   ${pct(t.cellAccuracy).padStart(7)}   ${pct(t.textRetention).padStart(8)}   ${String(t.exactGrid).padStart(3)}/${t.matched}`);
    }
}

console.log(`\n=== detection: adversarial (${adversarials.length} fixtures, correct answer is zero tables) ===`);
console.log('  mode/signal        false positives   pages affected   held for confirmation');
for (const mode of MODES) {
    for (const signal of SIGNALS) {
        const adv = results[`${mode}/${signal}`].filter((f) => f.kind === 'adversarial');
        const t = summarise(results[`${mode}/${signal}`], (f) => f.kind === 'adversarial');
        const affected = adv.filter((f) => f.pages.some((p) => p.falsePositives > 0)).length;
        const held = adv.reduce((n, f) => n + f.held, 0);
        console.log(`  ${`${mode}/${signal}`.padEnd(18)} ${String(t.falsePositives).padStart(15)} ${String(affected).padStart(16)} ${String(held).padStart(23)}`);
    }
}

console.log('\n=== per fixture, hybrid signal ===');
console.log('  fixture                        src      auto: found/FP     region: cells        confirm: kept/held');
for (const name of names) {
    const auto = results['auto/hybrid'].find((f) => f.name === name);
    const region = results['region/hybrid'].find((f) => f.name === name);
    const confirm = results['confirm/hybrid'].find((f) => f.name === name);
    const a = totals(auto.pages);
    const r = totals(region.pages);
    const c = totals(confirm.pages);
    const cells = r.expected ? `${r.correct}/${r.expected} cells` : 'no table';
    console.log(`  ${name.padEnd(30)} ${auto.source.join('+').padEnd(8)} ${String(a.detected).padStart(5)}/${String(a.falsePositives).padStart(2)}FP     ${cells.padEnd(20)} ${String(c.detected).padStart(3)}/${String(confirm.held).padStart(3)}`);
}

console.log('\n=== where the false positives are, hybrid/auto ===');
for (const f of results['auto/hybrid']) {
    for (const p of f.pages) {
        for (const fp of p.falsePositiveBoxes) {
            console.log(`  ${f.name.padEnd(30)} ${fp.rows}x${fp.cols} conf ${String(fp.confidence).padStart(3)}  at ${fp.bbox.left.toFixed(0)},${fp.bbox.top.toFixed(0)}`);
        }
    }
}

const summary = {};
for (const key of Object.keys(results)) {
    summary[key] = {
        positives: summarise(results[key], (f) => f.kind !== 'adversarial'),
        adversarial: summarise(results[key], (f) => f.kind === 'adversarial'),
    };
}
fs.writeFileSync(path.join(OUT, `detection-summary${suffix}.json`), `${JSON.stringify(summary, null, 1)}\n`);
console.log('\n  results written to test-fixtures/m2-4/results/\n');
