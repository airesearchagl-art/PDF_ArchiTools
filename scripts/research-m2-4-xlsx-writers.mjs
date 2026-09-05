/**
 * Compare the three ways this app could write an .xlsx.
 *
 *   A  hand-written OOXML, zipped with the JSZip already in package.json
 *   B  SheetJS (xlsx)
 *   C  ExcelJS
 *
 * B and C are installed into a throwaway directory outside the repository with
 * --no-save and no lock file, and they are used here as *readers* as much as
 * writers: an independent parser opening the hand-written package is the
 * strongest verification available on this machine, since there is no Excel and
 * no LibreOffice here to open it with. Nothing about the repository's own
 * dependencies changes -- that is asserted at the end.
 *
 * Run:  node scripts/research-m2-4-xlsx-writers.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { buildWorkbookParts, zipWorkbook, typeValue, XLSX_MIME } from '../research/m2-4/prototype/xlsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm2-4', 'xlsx');
fs.mkdirSync(OUT, { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// The workbook every writer has to produce
// ---------------------------------------------------------------------------

const SHEETS = [
    {
        name: '仕上表',
        rows: [
            ['室名', '仕上', '', '面積'],
            ['', '床', '壁', ''],
            ['事務室', 'OA', 'EP', '120.5'],
            ['会議室', 'CT', '', '48.0'],
            ['倉庫 & 物置', '長尺シート', '<未定>', '22.0'],
            ['注記', '床仕上げは施工前に\n監理者の承認を得ること', '', ''],
        ],
        // A merged header, the case that cannot be faked with formatting.
        merges: [{ r0: 0, c0: 1, r1: 0, c1: 2 }, { r0: 0, c0: 0, r1: 1, c1: 0 }, { r0: 0, c0: 3, r1: 1, c1: 3 }],
    },
    {
        name: 'QUANTITY',
        rows: [
            ['部材', '数量', '単価', '備考'],
            ['H形鋼', '12', '18500.50', '2026.09.01'],
            ['アンカー', '001', '320', 'M16'],
            ['デッキ', '8', '4200.00', '1:100'],
            ['配筋', '24', '150', 'D13@200'],
        ],
        merges: [],
    },
];

console.log('\n=== A. hand-written OOXML, zipped with the JSZip already in package.json ===');

const { parts, counts } = buildWorkbookParts(SHEETS);
console.log(`  parts: ${[...parts.keys()].join(', ')}`);
console.log(`  cells ${counts.cells}  numbers ${counts.numbers}  strings ${counts.strings}  blanks ${counts.blanks}  merges ${counts.merges}`);
check('the package needs five parts, not three as the .docx did', parts.size === 5 + SHEETS.length - 1, String(parts.size));

const bytesA = await zipWorkbook(JSZip, parts);
const bytesA2 = await zipWorkbook(JSZip, buildWorkbookParts(SHEETS).parts);
fs.writeFileSync(path.join(OUT, 'handwritten.xlsx'), bytesA);
check('the same workbook zips to the same bytes twice', sha(bytesA) === sha(bytesA2), `${sha(bytesA).slice(0, 16)}…`);
console.log(`  size: ${bytesA.length} bytes`);

// Well-formedness of every part, before any reader is asked to open it.
const reread = await JSZip.loadAsync(bytesA);
let xmlOk = true;
const declared = [];
for (const name of Object.keys(reread.files)) {
    const text = await reread.file(name).async('string');
    if (!text.startsWith('<?xml')) xmlOk = false;
    const opens = (text.match(/<[a-zA-Z]/g) ?? []).length;
    const closes = (text.match(/<\//g) ?? []).length + (text.match(/\/>/g) ?? []).length;
    if (opens !== closes) xmlOk = false;
    declared.push(name);
}
check('every part is well-formed XML with balanced tags', xmlOk, declared.length + ' parts');
check('no macro part and no external relationship',
    !declared.some((n) => /vbaProject|\.bin$/i.test(n))
    && !(await reread.file('xl/_rels/workbook.xml.rels').async('string')).includes('TargetMode="External"'),
    declared.join(' '));

// ---------------------------------------------------------------------------
// Value typing
// ---------------------------------------------------------------------------

console.log('\n=== value typing: what each policy does to text off a drawing ===');
const SAMPLES = ['001', '1-2', '2026.09', '1:100', '150A', 'D13@200', '12', '18500.50', '0.5', '2026.09.01', '+3', '1,200', '１２３'];
/**
 * The only question that matters for a cell: does it still show what the
 * drawing showed?
 *
 * Numeric equality is not the test. "001" becomes the number 1, which is
 * numerically the same and is no longer the mark number that was on the sheet;
 * "18500.50" becomes 18500.5, which is the same quantity displayed to one digit
 * less. Both fail to round-trip, and both can only be restored by writing an
 * explicit number format -- a part this minimal package does not have. So the
 * count below is round-trip failures, and the distinction kept alongside it is
 * whether the underlying number survived at all.
 */
const policies = ['string', 'conservative', 'aggressive'];
const loss = { string: 0, conservative: 0, aggressive: 0 };
const valueLoss = { string: 0, conservative: 0, aggressive: 0 };
console.log('  value          string        conservative     aggressive');
for (const sample of SAMPLES) {
    const cells = {};
    for (const p of policies) {
        const t = typeValue(sample, p);
        const shown = t.kind === 'number' ? String(t.value) : t.value;
        const roundTrips = shown === sample;
        const sameNumber = t.kind === 'number' && Number(sample) === t.value;
        if (!roundTrips) loss[p]++;
        if (!roundTrips && !sameNumber) valueLoss[p]++;
        cells[p] = `${t.kind === 'number' ? `num ${t.value}` : 'text'}${roundTrips ? '' : (sameNumber ? ' fmt' : ' LOST')}`;
    }
    console.log(`  ${sample.padEnd(14)} ${cells.string.padEnd(13)} ${cells.conservative.padEnd(16)} ${cells.aggressive}`);
}
console.log(`  round-trip failures -- string ${loss.string}/${SAMPLES.length}, conservative ${loss.conservative}/${SAMPLES.length}, aggressive ${loss.aggressive}/${SAMPLES.length}`);
console.log(`  of those, the number itself is wrong -- string ${valueLoss.string}, conservative ${valueLoss.conservative}, aggressive ${valueLoss.aggressive}`);
check('string-first is the only policy where every cell shows what the drawing showed',
    loss.string === 0, `${loss.string} failures`);
check('conservative typing already loses some cells, though never the number',
    loss.conservative > 0 && valueLoss.conservative === 0, `${loss.conservative} display, ${valueLoss.conservative} numeric`);
check('aggressive typing loses more, including values that are simply wrong',
    loss.aggressive > loss.conservative && valueLoss.aggressive > 0,
    `${loss.aggressive} failures, ${valueLoss.aggressive} wrong numbers`);

// ---------------------------------------------------------------------------
// B and C: the libraries, in a directory of their own
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-4-xlsx-'));
console.log(`\n=== B, C. candidate libraries (installed in ${tmp}, never in the repository) ===`);

const view = (pkg, fields) => {
    try {
        // shell: true because npm on Windows is a .cmd, which Node will not
        // spawn directly.
        const out = execFileSync(npm, ['view', pkg, ...fields, '--json'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
        return JSON.parse(out);
    } catch (error) {
        return { error: String(error?.message ?? error).split('\n')[0] };
    }
};

const candidates = [];
for (const pkg of ['xlsx', 'exceljs']) {
    const meta = view(pkg, ['version', 'license', 'dist.unpackedSize', 'dist.tarball', 'time.modified', 'deprecated']);
    // How long the npm listing has stood still matters as much as the version
    // number: a package whose newest npm release is years old is a different
    // supply-chain proposition from one released last month.
    const tags = view(pkg, ['dist-tags']);
    const all = view(pkg, ['versions']);
    meta.latestTag = tags?.latest ?? tags?.['dist-tags']?.latest ?? null;
    meta.releaseCount = Array.isArray(all) ? all.length : (Array.isArray(all?.versions) ? all.versions.length : null);
    meta.newestOnNpm = Array.isArray(all) ? all[all.length - 1] : null;
    candidates.push({ pkg, ...meta });
    console.log(`  ${pkg.padEnd(9)} version ${String(meta.version ?? '?').padEnd(10)} license ${String(meta.license ?? '?').padEnd(12)} unpacked ${meta['dist.unpackedSize'] ?? '?'} bytes  modified ${meta['time.modified'] ?? '?'}`);
    console.log(`             npm dist-tag latest ${meta.latestTag ?? '?'}, newest published ${meta.newestOnNpm ?? '?'}, ${meta.releaseCount ?? '?'} releases on npm`);
    if (meta.deprecated) console.log(`             DEPRECATED: ${meta.deprecated}`);
    if (meta.error) console.log(`             lookup failed: ${meta.error}`);
}

let installed = false;
try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'm2-4-probe', private: true, type: 'module' }));
    execFileSync(npm, ['install', '--package-lock=false', '--no-save', '--no-audit', '--no-fund', 'xlsx', 'exceljs'],
        { cwd: tmp, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' });
    installed = true;
} catch (error) {
    console.log(`  install failed: ${String(error?.message ?? error).split('\n')[0]}`);
}
check('the candidates could be installed for measurement', installed);

const dirSize = (dir) => {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
    return total;
};

if (installed) {
    for (const pkg of ['xlsx', 'exceljs']) {
        const dir = path.join(tmp, 'node_modules', pkg);
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const deps = Object.keys(meta.dependencies ?? {});
        const entry = candidates.find((c) => c.pkg === pkg);
        entry.installedSize = dirSize(dir);
        entry.deps = deps;
        entry.browser = meta.browser ? 'declares a browser build' : 'no browser field';
        console.log(`  ${pkg.padEnd(9)} on disk ${String(entry.installedSize).padStart(9)} bytes  ${deps.length} runtime deps${deps.length ? ` (${deps.slice(0, 6).join(', ')}${deps.length > 6 ? ', …' : ''})` : ''}  ${entry.browser}`);
    }
    // The whole install, which is what a bundler would have to reason about.
    console.log(`  entire install tree: ${dirSize(path.join(tmp, 'node_modules'))} bytes across ${fs.readdirSync(path.join(tmp, 'node_modules')).length} top-level packages`);

    // ---- independent readers open the hand-written package -----------------
    console.log('\n=== does an independent parser accept the hand-written package? ===');
    const req = (m) => import(pathToFileURL(path.join(tmp, 'node_modules', m, 'package.json')).href)
        .catch(() => null);
    void req;

    try {
        const XLSX = (await import(pathToFileURL(path.join(tmp, 'node_modules', 'xlsx', 'xlsx.mjs')).href)).default
            ?? await import(pathToFileURL(path.join(tmp, 'node_modules', 'xlsx', 'xlsx.mjs')).href);
        const wb = XLSX.read(bytesA, { type: 'buffer' });
        const names = wb.SheetNames;
        const sheet = wb.Sheets[names[0]];
        const a1 = sheet.A1?.v;
        const merged = (sheet['!merges'] ?? []).length;
        const second = wb.Sheets[names[1]];
        const numberCell = second?.B2;
        const identifierCell = second?.B3;
        console.log(`  SheetJS: sheets ${JSON.stringify(names)}  A1 ${JSON.stringify(a1)}  merges ${merged}`);
        console.log(`           B2 ${JSON.stringify(numberCell?.v)} (type ${numberCell?.t})  B3 ${JSON.stringify(identifierCell?.v)} (type ${identifierCell?.t})`);
        check('SheetJS opens the hand-written workbook', names.length === SHEETS.length, JSON.stringify(names));
        check('Japanese sheet names and cell text survive the round trip',
            names[0] === '仕上表' && a1 === '室名', `${names[0]} / ${a1}`);
        check('the merged header comes back as a merge', merged === SHEETS[0].merges.length, String(merged));
        check('12 is a number and 001 is still text',
            numberCell?.t === 'n' && numberCell?.v === 12 && identifierCell?.t === 's' && identifierCell?.v === '001',
            `${numberCell?.t}/${identifierCell?.t}`);
    } catch (error) {
        check('SheetJS opens the hand-written workbook', false, String(error?.message ?? error).split('\n')[0]);
    }

    try {
        const ExcelJS = (await import(pathToFileURL(path.join(tmp, 'node_modules', 'exceljs', 'lib', 'exceljs.nodejs.js')).href)).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(bytesA);
        const ws = wb.worksheets[0];
        const a1 = ws.getCell('A1').value;
        const multiline = ws.getCell('B6').value;
        console.log(`  ExcelJS: worksheets ${wb.worksheets.length}  A1 ${JSON.stringify(a1)}  B6 ${JSON.stringify(multiline)}`);
        check('ExcelJS opens the same bytes', wb.worksheets.length === SHEETS.length, String(wb.worksheets.length));
        check('a newline inside a cell survives', typeof multiline === 'string' && multiline.includes('\n'), JSON.stringify(multiline));
    } catch (error) {
        check('ExcelJS opens the same bytes', false, String(error?.message ?? error).split('\n')[0]);
    }

    // ---- what the libraries produce, for size comparison -------------------
    console.log('\n=== output size, same workbook ===');
    const sizes = { handwritten: bytesA.length };
    try {
        const XLSX = (await import(pathToFileURL(path.join(tmp, 'node_modules', 'xlsx', 'xlsx.mjs')).href));
        const wb = XLSX.utils.book_new();
        for (const sheet of SHEETS) {
            const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
            if (sheet.merges.length) ws['!merges'] = sheet.merges.map((m) => ({ s: { r: m.r0, c: m.c0 }, e: { r: m.r1, c: m.c1 } }));
            XLSX.utils.book_append_sheet(wb, ws, sheet.name);
        }
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        sizes.sheetjs = buf.length;
        fs.writeFileSync(path.join(OUT, 'sheetjs.xlsx'), buf);
    } catch (error) {
        sizes.sheetjs = `failed: ${String(error?.message ?? error).split('\n')[0]}`;
    }
    try {
        const ExcelJS = (await import(pathToFileURL(path.join(tmp, 'node_modules', 'exceljs', 'lib', 'exceljs.nodejs.js')).href)).default;
        const wb = new ExcelJS.Workbook();
        for (const sheet of SHEETS) {
            const ws = wb.addWorksheet(sheet.name);
            for (const row of sheet.rows) ws.addRow(row);
            for (const m of sheet.merges) ws.mergeCells(m.r0 + 1, m.c0 + 1, m.r1 + 1, m.c1 + 1);
        }
        const buf = await wb.xlsx.writeBuffer();
        sizes.exceljs = buf.byteLength ?? buf.length;
        fs.writeFileSync(path.join(OUT, 'exceljs.xlsx'), Buffer.from(buf));
    } catch (error) {
        sizes.exceljs = `failed: ${String(error?.message ?? error).split('\n')[0]}`;
    }
    for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(12)} ${v} bytes`);
    fs.writeFileSync(path.join(OUT, 'sizes.json'), `${JSON.stringify({ sizes, candidates }, null, 1)}\n`);
}

fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// The repository is untouched
// ---------------------------------------------------------------------------

console.log('\n=== the repository manifests are unchanged ===');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('no spreadsheet library was added to package.json',
    !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => ['xlsx', 'exceljs', 'sheetjs'].includes(d)),
    Object.keys(pkg.dependencies).join(' '));
check('jszip is already a dependency, so writer A needs nothing new',
    Boolean(pkg.dependencies.jszip), pkg.dependencies.jszip ?? 'absent');
check('the temporary install directory is gone', !fs.existsSync(tmp));
console.log(`  MIME for the download: ${XLSX_MIME}`);

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n  ${checks.length - failed}/${checks.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
