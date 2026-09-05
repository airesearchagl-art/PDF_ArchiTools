/**
 * What table reconstruction would cost, separated from what OCR already costs.
 *
 * Reconstruction takes tokens and returns a grid, so it is measured on tokens
 * directly: synthesised grids of a known size, with the ruling lines that go
 * with them. That isolates the new work from the recognition the app already
 * does, which is the number that decides whether M2-4 needs a worker, a yield
 * boundary, or neither.
 *
 * Run:  node scripts/research-m2-4-performance.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { detectByRuling, detectByGeometry } from '../research/m2-4/prototype/detect.mjs';
import { buildWorkbookParts, zipWorkbook } from '../research/m2-4/prototype/xlsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm2-4', 'results');
fs.mkdirSync(OUT, { recursive: true });

/** A grid of tokens and the lines that rule it, at a size we choose. */
function synthesise(rows, cols, { ruled = true, cellWidth = 60, cellHeight = 14, originX = 40, originY = 60 } = {}) {
    const tokens = [];
    const segments = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = originX + c * cellWidth + 2;
            const y = originY + r * cellHeight + 2;
            tokens.push({
                text: r === 0 ? `列${c + 1}` : `${r}-${c}`,
                x0: x, x1: x + 24, y0: y, y1: y + 9,
            });
        }
    }
    if (ruled) {
        const right = originX + cols * cellWidth;
        const bottom = originY + rows * cellHeight;
        for (let r = 0; r <= rows; r++) {
            const y = originY + r * cellHeight;
            segments.push({ orientation: 'h', x0: originX, x1: right, y0: y, y1: y, length: right - originX });
        }
        for (let c = 0; c <= cols; c++) {
            const x = originX + c * cellWidth;
            segments.push({ orientation: 'v', x0: x, x1: x, y0: originY, y1: bottom, length: bottom - originY });
        }
    }
    return { tokens, segments };
}

const ms = (fn) => {
    const t0 = performance.now();
    const value = fn();
    return { value, ms: +(performance.now() - t0).toFixed(1) };
};

const msAsync = async (fn) => {
    const t0 = performance.now();
    const value = await fn();
    return { value, ms: +(performance.now() - t0).toFixed(1) };
};

const CASES = [
    { name: 'small', rows: 10, cols: 5, pages: 1 },
    { name: 'medium', rows: 100, cols: 10, pages: 1 },
    { name: 'large', rows: 1000, cols: 20, pages: 1 },
    { name: 'multipage', rows: 40, cols: 8, pages: 20 },
    { name: 'token-heavy', rows: 400, cols: 25, pages: 1 },
];

console.log('\n=== reconstruction and writing, by table size ===');
console.log('  case          pages  tokens   ruling ms  geometry ms  build ms  zip ms   bytes    heap MB');
const results = [];
for (const c of CASES) {
    const pages = [];
    for (let p = 0; p < c.pages; p++) pages.push(synthesise(c.rows, c.cols));
    const tokenCount = pages.reduce((n, p) => n + p.tokens.length, 0);

    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const ruling = ms(() => pages.map((p) => detectByRuling(p.tokens, p.segments, {})));
    const geometry = ms(() => pages.map((p) => detectByGeometry(p.tokens, {})));

    const sheets = ruling.value.flatMap((tables, i) => tables.map((t, j) => ({
        name: `P${i + 1}-${j + 1}`,
        rows: t.grid.map((row) => row.map((cell) => cell ?? '')),
        merges: [],
    })));
    const built = ms(() => buildWorkbookParts(sheets));
    const zipped = await msAsync(() => zipWorkbook(JSZip, built.value.parts));
    const heapAfter = process.memoryUsage().heapUsed;

    const row = {
        name: c.name,
        pages: c.pages,
        tokens: tokenCount,
        detectedTables: ruling.value.flat().length,
        rulingMs: ruling.ms,
        geometryMs: geometry.ms,
        buildMs: built.ms,
        zipMs: zipped.ms,
        bytes: zipped.value.length,
        heapMB: +((heapAfter - heapBefore) / 1048576).toFixed(1),
    };
    results.push(row);
    console.log(`  ${c.name.padEnd(13)} ${String(c.pages).padStart(4)} ${String(tokenCount).padStart(8)} ${String(row.rulingMs).padStart(10)} ${String(row.geometryMs).padStart(12)} ${String(row.buildMs).padStart(9)} ${String(row.zipMs).padStart(7)} ${String(row.bytes).padStart(8)} ${String(row.heapMB).padStart(10)}`);
}

// ---------------------------------------------------------------------------
// Against what recognition already costs
// ---------------------------------------------------------------------------

console.log('\n=== the new work, next to the work the app already does ===');
const tokensDir = path.join(ROOT, 'test-fixtures', 'm2-4', 'tokens');
const ocrCosts = [];
if (fs.existsSync(tokensDir)) {
    for (const file of fs.readdirSync(tokensDir).filter((f) => f.startsWith('ocr-') && f.endsWith('.json'))) {
        const dump = JSON.parse(fs.readFileSync(path.join(tokensDir, file), 'utf8'));
        // The directory also holds sweep summaries, which are arrays.
        if (!Array.isArray(dump?.pages)) continue;
        const perPage = dump.pages.map((p) => p.ms).filter(Boolean);
        if (!perPage.length) continue;
        ocrCosts.push({
            fixture: file.replace(/^ocr-|\.json$/g, ''),
            pages: dump.pages.length,
            ocrMsPerPage: Math.round(perPage.reduce((a, b) => a + b, 0) / perPage.length),
            tokens: dump.pages.reduce((n, p) => n + p.tokens.length, 0),
        });
    }
    for (const c of ocrCosts) {
        console.log(`  ${c.fixture.padEnd(34)} OCR ${String(c.ocrMsPerPage).padStart(5)} ms/page   ${String(c.tokens).padStart(4)} word boxes`);
    }
}
const medium = results.find((r) => r.name === 'medium');
console.log(`\n  A 100x10 table reconstructs in ${medium.rulingMs} ms and writes in ${(medium.buildMs + medium.zipMs).toFixed(1)} ms.`);
console.log('  Recognising one scanned page costs a few hundred milliseconds by the numbers above,');
console.log('  so on a scanned document reconstruction is a rounding error against OCR; on a native');
console.log('  one it is the whole cost, and it is small.');

const large = results.find((r) => r.name === 'large');
console.log(`\n  The 1000x20 case (${large.tokens} tokens) takes ${large.rulingMs} ms by ruling lines and ${large.geometryMs} ms by geometry.`);
console.log('  The two routes do not scale alike. Ruling-line detection is roughly linear in the number of');
console.log('  lines. The geometry route grows far faster than its input: it re-scores a growing block of');
console.log('  rows for every row it adds, so a page dense enough to matter blocks the main thread for');
console.log('  seconds. That is a property of this prototype, not a law -- but any implementation of the');
console.log('  geometry route needs a bound on candidate growth, and a yield inside the page rather than');
console.log('  only between pages.');

fs.writeFileSync(path.join(OUT, 'performance.json'), `${JSON.stringify({ results, ocrCosts }, null, 1)}\n`);
console.log('\n  written to test-fixtures/m2-4/results/performance.json\n');
