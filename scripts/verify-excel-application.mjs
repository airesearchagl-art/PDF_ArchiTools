/**
 * Open the generated workbook in a real spreadsheet application.
 *
 * Every other check on this file is a parser reading XML we wrote. That is good
 * evidence and it is not the same claim as "Excel opens it": a package can be
 * well-formed, satisfy a library, and still be refused by the application
 * people actually use.
 *
 * So this drives whatever is on the machine -- Microsoft Excel through COM, or
 * LibreOffice -- and reports what it found. If neither is present it says so
 * and exits 0: the absence of a spreadsheet is not a defect in the workbook,
 * and it must not be reported as a pass either.
 *
 * Run:  node scripts/smoke-excel-export.mjs && node scripts/verify-excel-application.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBOOK = path.join(ROOT, 'test-fixtures', 'excel', 'verification.xlsx');

if (!fs.existsSync(WORKBOOK)) {
    console.error('No workbook to check. Run: node scripts/smoke-excel-export.mjs');
    process.exit(1);
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/**
 * What the workbook is supposed to contain, mirrored from the gate that wrote
 * it. Kept here as literals so a change to either side has to be made twice on
 * purpose rather than once by accident.
 */
const EXPECTED = {
    sheets: ['Page_1_Table_1', 'Page_3_Table_2'],
    a1: '室名',
    japanese: 'タイルカーペット',
    escaped: '<未定> & 予備',
    identifier: '001',
    twelve: '12',
    scale: '1:100',
    rebar: 'D13@200',
    multilineStart: '床仕上げは施工前に',
    multilineEnd: '監理者の承認を得ること',
    blankCell: 'A3',
};

function runExcelCom(file) {
    // -sta because the Office COM API is single-threaded apartment; without it
    // PowerShell 5.1 can fail to marshal the call at all.
    // The result goes through a file, not the console.
    //
    // Windows PowerShell writes to the console in the system code page, which
    // turns every Japanese cell into mojibake and the JSON into something that
    // will not parse. A UTF-8 file keeps what Excel actually reported.
    const outFile = path.join(os.tmpdir(), `excel-verify-${process.pid}.json`);
    const script = `
$ErrorActionPreference = 'Stop'
$out = '${outFile.replace(/'/g, "''")}'
$excel = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $wb = $excel.Workbooks.Open('${file.replace(/'/g, "''")}', 0, $true)
  $names = @()
  foreach ($ws in $wb.Worksheets) { $names += $ws.Name }
  $s1 = $wb.Worksheets.Item(1)
  $s2 = $wb.Worksheets.Item(2)
  $cell = { param($ws, $ref)
    $c = $ws.Range($ref)
    [pscustomobject]@{ text = [string]$c.Text; value = [string]$c.Value2; type = $c.Value2.GetType().Name }
  }
  $a1 = & $cell $s1 'A1'
  $b2 = & $cell $s1 'B2'
  $b3 = & $cell $s1 'B3'
  $c3 = & $cell $s1 'C3'
  $b4 = & $cell $s1 'B4'
  $c4 = & $cell $s1 'C4'
  $a3 = $s1.Range('A3')
  $b2s2 = & $cell $s2 'B2'
  $b3s2 = & $cell $s2 'B3'
  $result = [pscustomobject]@{
    opened = $true
    sheetCount = $wb.Worksheets.Count
    sheetNames = $names
    a1 = $a1
    japanese = $b2
    escaped = $b3
    identifier = $c3
    multiline = $b4
    twelve = $c4
    a3IsEmpty = [string]::IsNullOrEmpty([string]$a3.Value2)
    scale = $b2s2
    rebar = $b3s2
  }
  $wb.Close($false)
  $result | ConvertTo-Json -Depth 5 -Compress | Out-File -LiteralPath $out -Encoding utf8
} catch {
  [pscustomobject]@{ opened = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | Out-File -LiteralPath $out -Encoding utf8
} finally {
  if ($excel) { $excel.Quit() }
}
`;
    try {
        execFileSync('powershell', ['-NoProfile', '-sta', '-Command', script], {
            stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
        });
        const text = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
        return JSON.parse(text.split('\n').filter(Boolean).pop());
    } finally {
        fs.rmSync(outFile, { force: true });
    }
}

function excelAvailable() {
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

console.log('\n=== spreadsheet application ===');
const version = process.platform === 'win32' ? excelAvailable() : null;

if (!version) {
    console.log('  Microsoft Excel: not available on this machine');
    console.log('  LibreOffice:     not checked (Excel COM is the check this machine supports)');
    console.log('\n  Actual spreadsheet application verification: NOT AVAILABLE ON THIS MACHINE');
    console.log('  The workbook has been verified by parsers only. This is not a claim that Excel opens it.\n');
    process.exit(0);
}

console.log(`  Microsoft Excel available, version ${version}`);
console.log(`  opening ${path.relative(ROOT, WORKBOOK)}`);

const r = runExcelCom(WORKBOOK);
if (!r.opened) {
    check('Microsoft Excel opens the generated workbook', false, r.error);
    console.log('');
    process.exit(1);
}

const names = Array.isArray(r.sheetNames) ? r.sheetNames : [r.sheetNames];
console.log(`  sheets: ${JSON.stringify(names)}`);
console.log(`  A1 "${r.a1.text}" (${r.a1.type})   B2 "${r.japanese.text}"   B3 "${r.escaped.text}"`);
console.log(`  C3 "${r.identifier.text}" (${r.identifier.type})   C4 "${r.twelve.text}" (${r.twelve.type})`);
console.log(`  B4 ${JSON.stringify(r.multiline.value)}`);
console.log(`  sheet 2: B2 "${r.scale.text}"   B3 "${r.rebar.text}"`);

check('Microsoft Excel opens the generated workbook', r.opened === true);
check('it reports one worksheet per confirmed table', r.sheetCount === 2, String(r.sheetCount));
check('the worksheet names are the ones written',
    JSON.stringify(names) === JSON.stringify(EXPECTED.sheets), JSON.stringify(names));
check('Japanese cell text is intact', r.a1.value === EXPECTED.a1 && r.japanese.value === EXPECTED.japanese,
    `${r.a1.value} / ${r.japanese.value}`);
check('XML-reserved characters come back as the characters themselves',
    r.escaped.value === EXPECTED.escaped, r.escaped.value);
check('a leading-zero identifier is still text, not a number',
    r.identifier.value === EXPECTED.identifier && r.identifier.type === 'String',
    `${r.identifier.value} (${r.identifier.type})`);
check('12 is text too, which is the point of string-first',
    r.twelve.value === EXPECTED.twelve && r.twelve.type === 'String',
    `${r.twelve.value} (${r.twelve.type})`);
check('a newline inside a cell survives into Excel',
    typeof r.multiline.value === 'string'
    && r.multiline.value.includes(EXPECTED.multilineStart)
    && r.multiline.value.includes(EXPECTED.multilineEnd)
    && /[\r\n]/.test(r.multiline.value),
    JSON.stringify(r.multiline.value));
check('a blank cell is blank in Excel, not shifted away', r.a3IsEmpty === true, String(r.a3IsEmpty));
check('a scale and a rebar mark keep their form',
    r.scale.value === EXPECTED.scale && r.rebar.value === EXPECTED.rebar,
    `${r.scale.value} / ${r.rebar.value}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed in Microsoft Excel ${version}`);
if (failed.length) for (const f of failed) console.log(`    FAILED: ${f.name} ${f.detail}`);
console.log('');
process.exit(failed.length === 0 ? 0 : 1);
