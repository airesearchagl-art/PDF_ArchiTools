/**
 * Open the candidate exports in a real spreadsheet.
 *
 * Every other check on these files is our own parser reading text we wrote,
 * which cannot answer the question that matters: does the application people
 * use treat `=1+1` as a formula. So this opens each policy's file in Microsoft
 * Excel through COM and reports what the cell actually became.
 *
 * Where no spreadsheet is installed it says so and exits 0. The absence of one
 * is not a finding about the CSV, and it must not be reported as a pass.
 *
 * The same twelve values also go out through the XLSX writer the app already
 * ships, because "CSV mangles this" is only half an answer. The other half is
 * whether the format we already have avoids it.
 *
 * Run:  node scripts/research-m2-5-register.mjs && node scripts/research-m2-5-export-application.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm2-5', 'results');
const POLICIES = ['raw', 'strip', 'prefix-quote', 'tab-prefix'];

/**
 * The same values, written by the workbook writer that is already in the app.
 *
 * This imports `src/utils/pdf-textifier/excel.ts` rather than reconstructing
 * the format here: a re-implementation would only prove that my second attempt
 * works, which is not the question.
 */
async function writeXlsxSample(samples) {
    const { buildWorkbook } = await import('../src/utils/pdf-textifier/excel.ts');
    const grid = [
        ['page_number', 'drawing_number', 'drawing_title'],
        ...samples.map((value, i) => [String(i + 1), value, `題名 ${value}`]),
    ];
    const { bytes } = await buildWorkbook([{ sheetName: 'Register', grid }]);
    const file = path.join(OUT, 'register-samples.xlsx');
    fs.writeFileSync(file, bytes);
    return file;
}

const files = POLICIES.map((p) => ({ policy: p, file: path.join(OUT, `csv-policy-${p}.csv`) }))
    .filter((f) => fs.existsSync(f.file));
if (!files.length) {
    console.error('No CSV samples. Run: node scripts/research-m2-5-register.mjs');
    process.exit(1);
}

function excelVersion() {
    if (process.platform !== 'win32') return null;
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            "try { $x = New-Object -ComObject Excel.Application; $v = $x.Version; $x.Quit(); \"OK $v\" } catch { 'NO' }"],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
        const line = out.trim().split('\n').pop().trim();
        return line.startsWith('OK') ? line.slice(3).trim() : null;
    } catch {
        return null;
    }
}

/**
 * Read the first data column of each file, as Excel sees it.
 *
 * The result travels through a UTF-8 file rather than the console: Windows
 * PowerShell writes to the console in the system code page, which turns every
 * Japanese title into mojibake and the JSON into something that will not parse.
 */
function inspect(filesToOpen) {
    const outFile = path.join(os.tmpdir(), `m2-5-csv-${process.pid}.json`);
    const list = filesToOpen.map((f) => `@{ policy = '${f.policy}'; path = '${f.file.replace(/'/g, "''")}' }`).join(',');
    const script = `
$ErrorActionPreference = 'Stop'
$out = '${outFile.replace(/'/g, "''")}'
$excel = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $results = @()
  foreach ($item in @(${list})) {
    $wb = $excel.Workbooks.Open($item.path, 0, $true)
    $ws = $wb.Worksheets.Item(1)
    $rows = @()
    # Walk the used range, not "until something is blank". A policy that
    # empties a cell is exactly what we are looking for, and skipping blanks
    # would both hide it and silently shift every row after it.
    $lastRow = $ws.UsedRange.Rows.Count
    for ($r = 2; $r -le $lastRow; $r++) {
      $cell = $ws.Cells.Item($r, 2)
      $title = $ws.Cells.Item($r, 3)
      $rows += [pscustomobject]@{
        displayed = [string]$cell.Text
        value = [string]$cell.Value2
        formula = [string]$cell.Formula
        hasFormula = [bool]$cell.HasFormula
        japanese = [string]$title.Text
      }
    }
    $results += [pscustomobject]@{ policy = $item.policy; rows = $rows }
    $wb.Close($false)
  }
  [pscustomobject]@{ opened = $true; results = $results } | ConvertTo-Json -Depth 6 -Compress | Out-File -LiteralPath $out -Encoding utf8
} catch {
  [pscustomobject]@{ opened = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | Out-File -LiteralPath $out -Encoding utf8
} finally {
  if ($excel) { $excel.Quit() }
}
`;
    try {
        execFileSync('powershell', ['-NoProfile', '-sta', '-Command', script], {
            stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000,
        });
        const text = fs.readFileSync(outFile, 'utf8').replace(/^﻿/, '').trim();
        return JSON.parse(text.split('\n').filter(Boolean).pop());
    } finally {
        fs.rmSync(outFile, { force: true });
    }
}

console.log('\n=== the CSV, opened in a real spreadsheet ===');
const version = excelVersion();
if (!version) {
    console.log('  Microsoft Excel: not available on this machine');
    console.log('  LibreOffice:     not checked (Excel COM is the check this machine supports)');
    console.log('\n  Actual spreadsheet application verification: NOT AVAILABLE ON THIS MACHINE');
    console.log('  The CSV has been checked by our own parser only. That is not the same claim.\n');
    process.exit(0);
}

console.log(`  Microsoft Excel ${version}`);
const intended = JSON.parse(fs.readFileSync(path.join(OUT, 'csv-samples.json'), 'utf8')).samples;
files.push({ policy: 'xlsx (app writer)', file: await writeXlsxSample(intended) });
const result = inspect(files);
if (!result.opened) {
    console.log(`  FAILED to open: ${result.error}`);
    process.exit(1);
}

/**
 * What happened to one value, in three words.
 *
 *   evaluated  the cell is a formula -- the injection worked
 *   altered    the cell shows something other than what we wrote
 *   intact     the cell shows exactly the value
 *
 * `altered` is not automatically a failure: a policy that adds a visible
 * character is doing it on purpose. It is reported so the cost is visible
 * rather than assumed away.
 */
function verdictFor(row, want) {
    if (row.hasFormula) return 'evaluated';
    if (row.displayed === want) return 'intact';
    return row.displayed === '' && want !== '' ? 'emptied' : 'altered';
}

const summary = {};
const results = Array.isArray(result.results) ? result.results : [result.results];
for (const entry of results) {
    const rows = (Array.isArray(entry.rows) ? entry.rows : [entry.rows]).filter(Boolean);
    console.log(`
  ${entry.policy}`);
    console.log('    we wrote              Excel shows           formula?  Excel formula         verdict');
    const verdicts = [];
    rows.forEach((r, i) => {
        const want = intended[i] ?? '?';
        const verdict = verdictFor(r, want);
        verdicts.push({ want, ...r, verdict });
        console.log(`    ${JSON.stringify(want).slice(0, 21).padEnd(22)}${JSON.stringify(r.displayed).slice(0, 21).padEnd(22)}${String(r.hasFormula).padEnd(10)}${JSON.stringify(r.formula).slice(0, 21).padEnd(22)}${verdict}`);
    });
    const of = (name) => verdicts.filter((v) => v.verdict === name);
    console.log(`    -> ${of('evaluated').length} evaluated, ${of('altered').length} altered, ${of('emptied').length} emptied, ${of('intact').length} intact`);
    summary[entry.policy] = {
        cells: verdicts.length,
        evaluated: of('evaluated').map((v) => v.want),
        altered: of('altered').map((v) => ({ wrote: v.want, shows: v.displayed })),
        emptied: of('emptied').map((v) => v.want),
        intact: of('intact').length,
        rows: verdicts,
    };
}

fs.writeFileSync(path.join(OUT, 'csv-excel-verification.json'),
    `${JSON.stringify({ excelVersion: version, summary }, null, 1)}\n`, 'utf8');

console.log('\n  summary (Excel is the judge here, not our parser)');
console.log('    export             evaluated   altered   emptied   intact');
for (const [policy, r] of Object.entries(summary)) {
    console.log(`    ${policy.padEnd(18)} ${String(r.evaluated.length).padStart(6)}   ${String(r.altered.length).padStart(7)}   ${String(r.emptied.length).padStart(7)}   ${String(r.intact).padStart(6)}`);
}
for (const [policy, r] of Object.entries(summary)) {
    if (r.emptied.length) console.log(`\n    ${policy} destroyed ${r.emptied.length} value(s) outright: ${r.emptied.map((v) => JSON.stringify(v)).join(', ')}`);
}
console.log('');
