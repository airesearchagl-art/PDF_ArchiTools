/**
 * M7-P2-A foundation checks, run by scripts/smoke-m7-p1.mjs after the M7-P1
 * sections, in the same browser and against the same Vite dev server.
 *
 * The harness (smoke-m7-p2a-harness.html) drives the Production modules --
 * profiles, the register adapter over the unchanged Drawing Register engine,
 * the extraction runtime, confirmations, currency, the document gate -- with
 * real files, real PDF.js and the real recogniser, and returns plain data.
 * Everything is decided here, against what the fixture generator built
 * (test-fixtures/m7-p2a/manifest.json), the canonical schema and the
 * executable semantic contract.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PDFJS_ASSET_DIRS, listAssets } from './setup-pdfjs-assets.mjs';

const norm = (s) => String(s ?? '').replace(/\s+/gu, '');
const FIELDS = ['drawingNumber', 'drawingTitle', 'revision', 'issueDate'];
const countBy = (items, key) => items.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] ?? 0) + 1 }), {});
const valuesOf = (observation) => (observation ? FIELDS.map((f) => observation.fields[f].value) : null);

export async function runP2aChecks(ctx) {
    const { page, ROOT, ORIGIN, check, probe, note, section, validate, envelope, schema, checkRelations, RELATION_PROBLEM, assetRequests } = ctx;
    const FIXTURES = path.join(ROOT, 'test-fixtures', 'm7-p2a');
    if (!fs.existsSync(path.join(FIXTURES, 'manifest.json'))) throw new Error('No P2-A fixtures. Run: node scripts/make-m7-p1-fixtures.mjs');
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
    const file = (name) => manifest.files.find((f) => f.name === name);
    const truth = (name) => file(name).truth;
    const SENTINEL = manifest.sentinel;
    const collected = [];
    const keep = (value) => { collected.push(value); return value; };

    await page.goto(`${ORIGIN}/scripts/smoke-m7-p2a-harness.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__m7p2aReady === true, { timeout: 300000 });
    const call = async (fn, ...args) => keep(await page.evaluate((f, a) => window.__m7p2a[f](...a), fn, args));
    // Browser storage before any P2-A work, the first recognition included.
    const storageAtStart = await call('storage');
    const sessions = [];
    const session = (label, value) => sessions.push([label, value]);

    // ------------------------------------------------------------------
    section('13. P2-A contract drift: bounds, names and enums against contracts/m7');
    const constants = await call('constants');
    const defs = schema.$defs;
    const L = constants.limits;
    const drift = [
        ['FieldRawText.maxLength', defs.FieldRawText, 'maxLength', L.maxFieldRawTextLength, 1000],
        ['FieldValue.maxLength', defs.FieldValue, 'maxLength', L.maxFieldValueLength, 300],
        ['Name.maxLength', defs.Name, 'maxLength', L.maxNameLength, 200],
        ['DrawingSet.titleBlockProfiles.maxItems', defs.DrawingSet.properties.titleBlockProfiles, 'maxItems', L.maxProfiles, 64],
        ['DrawingSet.analysisRuns.maxItems', defs.DrawingSet.properties.analysisRuns, 'maxItems', L.maxAnalysisRuns, 2000],
        ['Sheet.confirmationHistory.maxItems', defs.Sheet.properties.confirmationHistory, 'maxItems', L.maxConfirmationHistoryPerSheet, 32],
    ];
    for (const [label, node, keyword, limit, expected] of drift) {
        check(`${label} = P2 constant`, node[keyword] === limit.value && limit.value === expected, `schema ${node[keyword]} · P2 ${limit.value}`);
        check(`${label}: same x-limit name`, node['x-limit'] === limit.xLimit, `${node['x-limit']} · ${limit.xLimit}`);
    }
    const contractText = fs.readFileSync(path.join(ROOT, 'contracts', 'm7', 'semantic-contract.md'), 'utf8');
    check('maxFieldRawTextLength is the one Human-adopted bound, as the contract says',
        L.maxFieldRawTextLength.status === 'HUMAN_ADOPTED' && /\| `maxFieldRawTextLength` \| 1000 characters \| \*\*Human-adopted\*\*/.test(contractText)
        && Object.entries(L).filter(([k]) => k !== 'maxFieldRawTextLength').every(([, v]) => v.status === 'CANONICAL_PRE_RELEASE_CANDIDATE'));
    check('TitleBlockProfile.revision bound = P2 constant', defs.TitleBlockProfile.properties.revision.maximum === constants.maxProfileRevision
        && defs.TitleBlockProfile.properties.revision.minimum === 1);
    check('FieldValue / Name character rule = the single-line class', defs.FieldValue.pattern === `^[^${constants.singleLineClass}]*$`
        && defs.Name.pattern === `^[^${constants.singleLineClass}]*$`);
    check('FieldRawText character rule = the raw-text class (line feeds kept)', defs.FieldRawText.pattern === `^[^${constants.rawTextClass}]*$`);
    check('field names and their canonical order = FieldName', JSON.stringify(defs.FieldName.enum) === JSON.stringify(constants.fieldNames)
        && JSON.stringify(Object.keys(defs.TitleBlockProfile.properties.fields.properties)) === JSON.stringify(constants.fieldNames));
    check('transfer models = TitleBlockProfile.transferModel', JSON.stringify(defs.TitleBlockProfile.properties.transferModel.enum) === JSON.stringify(constants.transferModels));
    check('the engine a run names is the contract\'s, and its version is a VersionString',
        defs.AnalysisRun.properties.engine.properties.name.enum.includes(constants.engine.name) && constants.engine.name === 'register-extraction'
        && new RegExp(defs.VersionString.pattern, 'u').test(constants.engine.version) && constants.engine.version.length <= defs.VersionString.maxLength);
    const semanticSource = fs.readFileSync(path.join(ROOT, 'contracts', 'm7', 'portable-project.semantic.mjs'), 'utf8');
    check('rectangle tolerance = the semantic contract\'s GEOMETRY_EPSILON_PT',
        Number(/GEOMETRY_EPSILON_PT = ([0-9.]+)/.exec(semanticSource)?.[1]) === constants.rectEpsilon);
    check('the revision date is the issue date (Architecture v1 decision 8)', constants.engineField.issueDate === 'revision_date'
        && constants.engineField.drawingNumber === 'drawing_number' && constants.engineField.drawingTitle === 'drawing_title' && constants.engineField.revision === 'revision');
    check('PDF.js data files are same-origin paths, never a CDN', Object.entries(constants.assets).filter(([k]) => k !== 'cMapPacked')
        .every(([, url]) => typeof url === 'string' && url.startsWith('/pdfjs/') && url.endsWith('/')), JSON.stringify(constants.assets));

    // ------------------------------------------------------------------
    section('14. PDF.js data files: copies of the installed pdfjs-dist, byte for byte');
    const assetDir = path.join(ROOT, 'public', 'pdfjs');
    const pdfjsDir = path.join(ROOT, 'node_modules', 'pdfjs-dist');
    const lock = JSON.parse(fs.readFileSync(path.join(assetDir, 'ASSETS.json'), 'utf8'));
    const installed = JSON.parse(fs.readFileSync(path.join(pdfjsDir, 'package.json'), 'utf8')).version;
    check('ASSETS.json names the installed pdfjs-dist', lock.pdfjsDist === installed, `${lock.pdfjsDist} · installed ${installed}`);
    check('served directories: cmaps, standard_fonts, wasm', JSON.stringify(lock.dirs) === JSON.stringify(PDFJS_ASSET_DIRS)
        && JSON.stringify(PDFJS_ASSET_DIRS) === JSON.stringify(['cmaps', 'standard_fonts', 'wasm']));
    const upstream = listAssets(pdfjsDir);
    const served = listAssets(assetDir);
    const extra = fs.readdirSync(assetDir).filter((n) => n !== 'ASSETS.json' && !PDFJS_ASSET_DIRS.includes(n));
    check('the same files, no more and no fewer', JSON.stringify(upstream) === JSON.stringify(served) && extra.length === 0
        && JSON.stringify(Object.keys(lock.files).sort()) === JSON.stringify(upstream), `${served.length} served, ${upstream.length} upstream, extra ${extra.join(',')}`);
    const differing = upstream.filter((rel) => !fs.readFileSync(path.join(pdfjsDir, rel)).equals(fs.readFileSync(path.join(assetDir, rel)))
        || crypto.createHash('sha256').update(fs.readFileSync(path.join(assetDir, rel))).digest('hex') !== lock.files[rel]);
    check('every byte equal to pdfjs-dist, every SHA-256 as recorded', differing.length === 0, differing.slice(0, 5).join(','));
    const src = (rel) => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
    check('P2-A wires the data files into the extraction document only (P1 intake and preview unchanged)',
        src('utils/drawing-set/pdf-document-gate.ts').includes('m7PdfDocumentAssets()')
        && !/cMapUrl|m7PdfDocumentAssets/.test(src('utils/drawing-set/source-intake.ts'))
        && !/cMapUrl|m7PdfDocumentAssets/.test(src('utils/drawing-set/preview-document.ts')));

    // ------------------------------------------------------------------
    section('15. Field bounds: recorded exactly or not at all');
    const b = await call('bounds');
    const t = b.texts;
    const is = (r, kind, extra = {}) => r !== null && r.kind === kind && Object.entries(extra).every(([k, v]) => r[k] === v);
    check('value: 300 characters pass, 301 are refused (TOO_LONG 301)', t.value300.value === null && is(t.value301.value, 'TOO_LONG', { length: 301, limit: 300 }));
    check('value: counted in code points (300 astral characters = 600 UTF-16 units pass, 301 do not)',
        t.astral300.value === null && is(t.astral301.value, 'TOO_LONG', { length: 301 }));
    check('raw text: 1000 pass, 1001 refused; astral counted once', t.raw1000.raw === null && is(t.raw1001.raw, 'TOO_LONG', { length: 1001, limit: 1000 })
        && t.rawAstral1000.raw === null && is(t.rawAstral1001.raw, 'TOO_LONG', { length: 1001 }));
    check('raw text keeps line feeds; a value refuses them', t.lineFeed.raw === null && is(t.lineFeed.value, 'INVALID_CHARACTER', { codePoint: 10, characterClass: 'CONTROL' }));
    check('controls refused everywhere: TAB, NUL, CR, DEL, C1', ['tab', 'nul', 'cr', 'del', 'c1']
        .every((k) => is(t[k].value, 'INVALID_CHARACTER', { characterClass: 'CONTROL' }) && is(t[k].raw, 'INVALID_CHARACTER', { characterClass: 'CONTROL' })));
    check('line and paragraph separators refused', ['lineSeparator', 'paragraphSeparator'].every((k) => is(t[k].value, 'INVALID_CHARACTER', { characterClass: 'LINE_SEPARATOR' }) && is(t[k].raw, 'INVALID_CHARACTER', { characterClass: 'LINE_SEPARATOR' })));
    check('bidi controls refused (RLO, LRE, LRI, PDI)', ['rlo', 'lre', 'lri', 'pdi'].every((k) => is(t[k].value, 'INVALID_CHARACTER', { characterClass: 'BIDI_CONTROL' }) && is(t[k].raw, 'INVALID_CHARACTER', { characterClass: 'BIDI_CONTROL' })));
    check('unpaired surrogates refused (high, low, reversed pair)', ['loneHigh', 'loneLow', 'reversedPair'].every((k) => is(t[k].value, 'INVALID_CHARACTER', { characterClass: 'UNPAIRED_SURROGATE' })));
    check('what the schema allows is allowed: ZWJ, U+FFFD, full-width, and the empty value', ['zeroWidthJoiner', 'replacement', 'fullWidth', 'empty'].every((k) => t[k].value === null && t[k].raw === null));
    check('names: empty and blank refused, 200 pass, 201 and bidi and line feed refused', is(b.names.empty, 'EMPTY') && is(b.names.blank, 'EMPTY') && b.names.len200 === null
        && is(b.names.len201, 'TOO_LONG', { length: 201 }) && is(b.names.bidi, 'INVALID_CHARACTER') && is(b.names.lineFeed, 'INVALID_CHARACTER') && b.names.japanese === null);
    check('CRLF and lone CR become LF; nothing else changes', b.lineEndings === true);

    section('16. The register adapter (engine rows -> observations)');
    const a = b.adapter;
    check('an engine row becomes an observation with the run, the bytes and the profile revision it was read under',
        a.normal.ok && a.normal.status === 'READ' && a.normal.runId && a.normal.sha && a.normal.profile.profileRevision === 3);
    check('revision_date becomes issueDate; value = the last line of the raw text; raw text kept whole',
        a.normal.fields.issueDate.value === '2026.09.01' && a.normal.fields.drawingNumber.value === 'A-101' && a.normal.rawText.drawingNumber === '図面番号\nA-101');
    check('CRLF / CR in raw text become LF, and the value is taken after that', a.crlf.ok && a.crlf.rawText.drawingNumber === 'LBL\nA-1\nB-2' && a.crlf.fields.drawingNumber.value === 'B-2');
    check('raw text of 1000 characters is recorded whole; 1001 makes the Sheet unrecordable', a.raw1000.ok && a.raw1000.fields.drawingTitle.rawLength === 1000
        && !a.raw1001.ok && JSON.stringify(a.raw1001.problems) === JSON.stringify([{ field: 'drawingTitle', part: 'rawText', problem: { kind: 'TOO_LONG', length: 1001, limit: 1000 } }]));
    check('astral raw text: 1000 characters (1994 UTF-16 units) recorded, 1001 not', a.rawAstral1000.ok && a.rawAstral1000.fields.drawingTitle.rawLength === 1000
        && !a.rawAstral1001.ok && a.rawAstral1001.problems[0].problem.length === 1001);
    check('a 300-character value is recorded, 301 is not', a.value300.ok && a.value300.fields.drawingNumber.rawLength === 300
        && !a.value301.ok && a.value301.problems.some((p) => p.part === 'value' && p.problem.length === 301));
    check('a control, bidi, separator or unpaired surrogate anywhere makes the Sheet unrecordable, naming field and code point',
        !a.tabInRaw.ok && a.tabInRaw.problems[0].problem.codePoint === 9
        && !a.bidiInValue.ok && a.bidiInValue.problems.some((p) => p.field === 'revision' && p.problem.characterClass === 'BIDI_CONTROL')
        && !a.loneSurrogate.ok && a.loneSurrogate.problems[0].problem.characterClass === 'UNPAIRED_SURROGATE'
        && !a.lineSeparator.ok && a.lineSeparator.problems[0].problem.characterClass === 'LINE_SEPARATOR');
    check('a reason names field, part and counts only -- never the text',
        [a.raw1001, a.value301, a.tabInRaw, a.bidiInValue, a.loneSurrogate].every((r) => r.problems.every((p) =>
            JSON.stringify(Object.keys(p).sort()) === '["field","part","problem"]'
            && Object.keys(p.problem).every((k) => ['kind', 'length', 'limit', 'codePoint', 'characterClass'].includes(k)))));
    check('ocrScore: integers 0..100 kept as they are; 101 and 55.5 refused, never rounded or clamped',
        a.score100.ok && a.score100.fields.drawingTitle.ocrScore === 100 && a.score0.ok && a.score0.fields.drawingTitle.ocrScore === 0
        && !a.score101.ok && !a.scoreFraction.ok && a.scoreFraction.problems[0].part === 'ocrScore');
    check('OCR that found nothing: source ocr, empty value -- recorded as read', a.ocrEmpty.ok && a.ocrEmpty.status === 'READ'
        && a.ocrEmpty.fields.revision.source === 'ocr' && a.ocrEmpty.fields.revision.value === '');
    check('OCR that failed: status OCR_FAILED, the fields it owned source none', a.ocrFailed.ok && a.ocrFailed.status === 'OCR_FAILED'
        && a.ocrFailed.fields.drawingTitle.source === 'none' && a.ocrFailed.fields.drawingNumber.source === 'native');

    // ------------------------------------------------------------------
    section('17. Title-block profiles and assignment');
    const p = await call('profileOps');
    check('no transfer model, or one that is not a person\'s choice: refused, nothing created',
        p.noModel.code === 'TRANSFER_MODEL_REQUIRED' && p.guessedModel.code === 'TRANSFER_MODEL_REQUIRED' && p.noModel.untouched && p.guessedModel.untouched);
    check('names: empty, blank, 201 characters, bidi -- refused', ['emptyName', 'blankName', 'longName', 'bidiName'].every((k) => p[k].code === 'NAME_INVALID'));
    check('rectangles: off the reference page, inverted, empty, NaN, missing -- refused and named',
        p.outsidePage.code === 'RECT_INVALID' && p.outsidePage.field === 'drawingNumber' && p.inverted.field === 'revision'
        && p.empty.field === 'issueDate' && p.notANumber.field === 'drawingTitle' && p.missing.field === 'issueDate');
    check('reference page past 14400 pt or zero: refused', p.hugePage.code === 'REFERENCE_PAGE_INVALID' && p.zeroPage.code === 'REFERENCE_PAGE_INVALID');
    check('nothing was created by any refusal', p.profilesAfterRefusals === 0);
    check('0.01 pt past the page edge is the contract\'s tolerance; a 200-character name fits', p.atTolerance.ok && p.name200.ok);
    check('a rename keeps the revision; the same name changes nothing', p.rename.changed && p.rename.revision === 1 && p.rename.updatedMoved && p.renameSame === false);
    check('the same geometry is no change; rectangles, model, reference page each make a new revision',
        p.reviseSame.changed === false && p.reviseSame.revision === 1 && p.reviseGeometry.revision === 2 && p.reviseModel.revision === 3
        && p.reviseReference.revision === 4 && p.reviseBadRect === 'RECT_INVALID');
    check('assignment covers exactly the Sheets named; nothing else is assigned', p.assign.assigned === 4 && p.othersUnassigned);
    check('a Sheet on another profile is a conflict: refused whole, named, nothing changed',
        p.conflict.code === 'ASSIGNMENT_CONFLICT' && JSON.stringify(p.conflict.conflicting) === '[3,4]' && p.conflict.untouched);
    check('with the person\'s go-ahead, the conflicting Sheets move and the others are added',
        JSON.stringify(p.replace.replaced) === '[3,4]' && JSON.stringify(p.replace.assigned) === '[5,6]');
    check('assigning the same profile again keeps the moment it was made', p.reassignSame.unchanged === 1 && p.reassignSame.keptMoment);
    check('unassign; unknown and retired Sheets refused', p.unassign.cleared === 1 && p.unassign.now === null && p.unknownSheet === 'SHEET_NOT_FOUND' && p.retiredSheet === 'SHEET_RETIRED');
    check('retiring a profile keeps it listed, takes it off its live Sheets, and nothing more can be done with it',
        JSON.stringify(p.retire.unassigned) === '[1,2]' && p.retire.retiredAt && p.retire.stillListed
        && ['assignAfter', 'reviseAfter', 'renameAfter', 'retireAgain'].every((k) => p.retire[k] === 'PROFILE_RETIRED'));
    check('64 profiles (retired ones count): the 65th is refused', p.atLimit === 64 && p.overLimit.code === 'PROFILE_LIMIT' && p.overLimit.untouched);
    check('a revision at its bound cannot move again', p.revisionLimit === 'REVISION_LIMIT');
    session('profiles (retired profile, conflicts resolved)', p.sessionMid);
    session('profiles (64, limit)', p.session);

    // ------------------------------------------------------------------
    section('18. Coordinates: /Rotate 0/90/180/270, with and without a CropBox offset (mandatory)');
    const geo = truth('p2a-geometry');
    const g = await call('geometry', geo);
    for (const model of ['normalised', 'corner-anchored']) {
        const r = g.results[model];
        const exact = geo.pages.every((pg, i) => FIELDS.every((f) => r.observations[i]?.fields[f].value === pg.tokens[f]
            && r.observations[i].fields[f].rawText === pg.tokens[f] && r.observations[i].fields[f].source === 'native'));
        check(`${model}: every field of all 8 pages is exactly its own token, from the text layer`, exact,
            geo.pages.map((pg, i) => `p${pg.page}@${pg.rotate}${pg.offset ? '+off' : ''}:${valuesOf(r.observations[i])?.every((v, k) => v === pg.tokens[FIELDS[k]]) ? 'ok' : 'MISS'}`).join(' '));
        check(`${model}: one run, all 8 evaluated, one document opened and destroyed`, r.report.outcome === 'COMPLETED'
            && r.report.run.coverage.sheetsEvaluated === 8 && r.report.run.coverage.sheetsExcluded === 0 && r.gate.opened === 1 && r.gate.destroyed === 1 && r.gate.peakLive === 1);
    }
    const conv = g.conversions;
    check('viewer space -> upright: the Production toUprightRect equals the generator\'s rectangles at every rotation and offset (<= 0.5 pt)',
        conv.length === 8 && conv.every((c) => c.productionError <= 0.5), conv.map((c) => `${c.rotate}:${c.productionError.toFixed(3)}`).join(' '));
    check('and so does PDF.js\'s own inverse through the CropBox origin', conv.every((c) => c.pdfjsError <= 0.5));
    check('the offset pages really are offset, and the quarter turns really are turned',
        conv.filter((c) => c.view[0] === 40 && c.view[1] === 60).length === 4 && conv.filter((c) => c.viewport[0] === 580).length === 4);
    session('geometry', g.session);
    const tr = truth('p2a-transfer');
    const tx = await call('transfer', tr);
    check('normalised on the scaled sheet, corner-anchored on the fixed block: every field exact', tr.pages.every((pg, i) =>
        FIELDS.every((f) => tx.right.observations[i]?.fields[f].value === pg.tokens[f])));
    probe('with the two models swapped, the transferred cells miss', tx.swapped.observations.slice(1).every((o, i) =>
        FIELDS.some((f) => o.fields[f].value !== tr.pages[i + 1].tokens[f])), JSON.stringify(tx.swapped.observations.slice(1).map(valuesOf)));

    // ------------------------------------------------------------------
    section('19. Register extraction through the M7 adapter: native, OCR, mixed, blank, bounds');
    const reg = truth('p2a-register');
    const r = await call('register', reg);
    const obs = r.observations;
    const regFile = file('p2a-register');
    note('run', JSON.stringify(r.report.run.coverage));
    check('one run, appended once, COMPLETED: 5 evaluated, 2 excluded', r.report.outcome === 'COMPLETED' && r.runsAdded === 1 && r.applyCalls === 1
        && r.report.run.coverage.sheetsEvaluated === 5 && r.report.run.coverage.sheetsExcluded === 2);
    check('the model did not move until the run ended (one change, at the end)', r.unchangedDuringRun);
    check('every observation names this run, the fixture\'s bytes and profile revision 1',
        obs.slice(0, 5).every((o) => o.runId === r.report.run.id && o.sourceSha256 === regFile.sha256 && o.profile.profileId === r.profile.id && o.profile.profileRevision === 1));
    check('page 1 (native, label above value): values exact, raw text whole, from the text layer',
        FIELDS.every((f) => obs[0].fields[f].value === reg.pages[0].values[f] && obs[0].fields[f].rawText === reg.pages[0].rawText[f] && obs[0].fields[f].source === 'native' && obs[0].fields[f].ocrScore === null));
    check('page 3: the drawing number from the text layer, the rest recognised', obs[2].fields.drawingNumber.source === 'native'
        && obs[2].fields.drawingNumber.value === 'A-103' && obs[2].fields.drawingNumber.rawText === 'A-103' && ['drawingTitle', 'revision', 'issueDate'].every((f) => obs[2].fields[f].source === 'ocr'));
    check('page 4: an empty cell goes to OCR, which finds nothing -- recorded as read, empty, source ocr',
        obs[3].fields.revision.source === 'ocr' && obs[3].fields.revision.value === '' && obs[3].fields.revision.rawText === '' && obs[3].status === 'READ'
        && obs[3].fields.drawingNumber.value === 'A-104');
    const ocrFields = [[1, FIELDS], [2, ['drawingTitle', 'revision', 'issueDate']]].flatMap(([i, fs]) => fs.map((f) => ({ got: obs[i].fields[f].value, want: reg.pages[i].values[f], score: obs[i].fields[f].ocrScore, source: obs[i].fields[f].source })));
    const ocrHits = ocrFields.filter((x) => norm(x.got).includes(norm(x.want))).length;
    check('recognised fields: at least the Drawing Register\'s own bar (70%)', ocrFields.every((x) => x.source === 'ocr') && ocrHits / ocrFields.length >= 0.7,
        `${ocrHits}/${ocrFields.length}: ${ocrFields.map((x) => JSON.stringify(x.got)).join(' ')}`);
    check('recognised fields carry an integer score 0..100, and nothing was confirmed by it',
        ocrFields.every((x) => x.score === null || (Number.isInteger(x.score) && x.score >= 0 && x.score <= 100)) && r.confirmations.every((c) => c === null));
    check('page 5 (bounds that fit): a 300-character value and a 1000-character raw text recorded whole',
        obs[4].fields.drawingNumber.value === reg.pages[4].values.drawingNumber && [...obs[4].fields.drawingNumber.value].length === 300
        && obs[4].fields.drawingTitle.rawText === reg.pages[4].rawText.drawingTitle && [...obs[4].fields.drawingTitle.rawText].length === 1000
        && obs[4].fields.drawingTitle.value === reg.pages[4].values.drawingTitle);
    const ex = r.report.excluded;
    const exFor = (n) => ex.find((e) => e.sheetId === r.session.drawingSet.sheets.filter((s) => s.sourceId === r.session.drawingSet.sources[0].id).sort((x, y) => x.pageNumber - y.pageNumber)[n - 1].id);
    check('page 6 (1001-character raw text): no observation; the reason says field, part and length',
        obs[5] === null && JSON.stringify(exFor(6)) === JSON.stringify({ sheetId: exFor(6)?.sheetId, code: 'FIELD_UNRECORDABLE', problems: [{ field: 'drawingTitle', part: 'rawText', problem: { kind: 'TOO_LONG', length: 1001, limit: 1000 } }] }));
    check('page 7 (301-character value): no observation; the reason says so', obs[6] === null && exFor(7)?.code === 'FIELD_UNRECORDABLE'
        && exFor(7).problems.some((pr) => pr.field === 'drawingNumber' && pr.part === 'value' && pr.problem.length === 301));
    check('recognition rendered regions only, never a whole page', r.report.stats.maxRegionPixels > 0
        && r.report.stats.maxRegionPixels < (800 / 72 * 300) * (580 / 72 * 300) / 4, `largest region ${r.report.stats.maxRegionPixels} px`);
    check('one PDF.js document at a time; destroyed; the recogniser terminated', r.pdfPeakDuringRun === 1 && r.pdfLiveAfter === 0 && r.ocrLiveAfter === 0
        && r.gate.opened === 1 && r.gate.destroyed === 1 && r.report.ocr.closes >= 1 && r.report.ocr.started === false);
    const digest = (s) => crypto.createHash('sha256').update(Buffer.from(JSON.stringify(s.drawingSet.sources.filter((x) => x.retiredAt === null)
        .map((x) => [x.id, x.fingerprint.sha256]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))), 'utf8')).digest('hex');
    check('manifestDigest = node:crypto over the sorted live [id, sha256] pairs', r.report.run.manifestDigest === digest(r.session) && r.digestNow === r.report.run.manifestDigest);
    check('the run: kind EXTRACTION, engine register-extraction 1.0.0, completed after it started', r.report.run.kind === 'EXTRACTION'
        && r.report.run.engine.name === 'register-extraction' && r.report.run.completedAt >= r.report.run.startedAt);

    // ------------------------------------------------------------------
    section('20. Human confirmation (HDR-36-01)');
    const e = await call('editedFields');
    check('typed with no profile: all four', JSON.stringify(e.manual) === JSON.stringify(FIELDS));
    check('same value from the text layer or OCR: not edited', e.sameNative.length === 0 && e.sameOcr.length === 0 && e.emptyAgainstOcrEmpty.length === 0);
    check('source none is supplied by the person, even blank for blank', JSON.stringify(e.sourceNoneEmpty) === '["revision"]' && JSON.stringify(e.sourceNoneAll) === JSON.stringify(FIELDS));
    check('canonical order, whatever order the values came in', JSON.stringify(e.reverseOrder) === '["drawingNumber","revision","issueDate"]');
    check('exact comparison: a trailing space, a full-width letter are edits', JSON.stringify(e.exactWhitespace) === '["drawingNumber"]' && JSON.stringify(e.exactWidth) === '["drawingNumber"]');
    const c = r.confirm;
    check('confirming as read: the observation\'s own basis, nothing edited', c.asRead.editedFields?.length === 0 && c.asRead.profile?.profileRevision === 1 && c.asRead.sourceSha256 === regFile.sha256);
    check('re-confirming with an edit: only that field; the old one kept as RECONFIRMED', JSON.stringify(c.reconfirmEdited.editedFields) === '["drawingTitle"]'
        && c.historyAfterReconfirm.length === 1 && c.historyAfterReconfirm[0].reason === 'RECONFIRMED' && c.historyAfterReconfirm[0].confirmation.editedFields.length === 0);
    check('withdrawing: nothing stands, the history says WITHDRAWN; nothing to withdraw is refused',
        c.afterWithdraw.confirmation === null && JSON.stringify(c.afterWithdraw.history) === '["RECONFIRMED","WITHDRAWN"]' && c.withdrawNothing === 'NO_CONFIRMATION');
    check('a blank OCR read confirmed blank is not an edit; two edits come in canonical order; a trailing space is an edit',
        c.blankRead.editedFields?.length === 0 && JSON.stringify(c.twoEdited.editedFields) === '["drawingNumber","drawingTitle"]' && JSON.stringify(c.trailingSpace.editedFields) === '["drawingNumber"]');
    check('typed with no profile: profile null, all four edited, against the Source\'s bytes', c.manual.profile === null && c.manual.editedFields.length === 4 && c.manual.sourceSha256 === regFile.sha256);
    check('no observation: confirming from one is refused', c.noObservation.refused === 'NO_OBSERVATION');
    check('values are never cut or cleaned: 301 characters, a line feed, a bidi control, a non-string -- refused, set untouched',
        c.tooLong.refused === 'VALUE_INVALID' && c.lineFeed.refused === 'VALUE_INVALID' && c.bidi.refused === 'VALUE_INVALID' && c.notString.refused === 'VALUE_INVALID' && c.invalidLeftSetAlone);
    check('the File not MATCHED (changed, missing, not held): no confirmation of either kind',
        c.changedObservation.refused === 'SOURCE_NOT_MATCHED' && c.changedManual.refused === 'SOURCE_NOT_MATCHED' && c.unboundManual.refused === 'SOURCE_NOT_MATCHED' && c.missingObservation.refused === 'SOURCE_NOT_MATCHED');
    check('recognition that failed: an OCR_FAILED observation; blank for blank is still all four edited',
        c.failedRun.outcome === 'COMPLETED' && c.failedObservation.status === 'OCR_FAILED' && FIELDS.every((f) => c.failedObservation.fields[f].source === 'none')
        && c.blankOfFailed.editedFields.length === 4 && c.typedOfFailed.editedFields.length === 4);
    check('after the profile moved: the stale reading cannot be confirmed; typing without a profile can',
        c.staleObservation.refused === 'OBSERVATION_NOT_CURRENT' && c.staleManualAllowed.profile === null);
    check('editedFields is never recomputed: reading the Sheet again leaves its confirmation exactly as it was',
        c.reread.outcome === 'COMPLETED' && c.reread.newRevision === 2 && c.keptConfirmation && JSON.stringify(c.keptEdited) === '["drawingNumber"]');
    check('history: the 32nd entry fits; the next re-confirmation and a withdrawal are refused, nothing dropped',
        c.history32.editedFields?.length === 4 && c.historyLength === 32 && c.history33.refused === 'HISTORY_LIMIT' && c.withdrawAtLimit === 'HISTORY_LIMIT' && c.fullLeftAlone);
    session('register + confirmations', r.session);

    section('21. Currency (derived, never stored)');
    const m = r.currency;
    check('a reading under the current revision: CURRENT; a confirmation under the old one: STALE_PROFILE', m.p3.observation === 'CURRENT' && m.p3.confirmation === 'STALE_PROFILE');
    check('typed with no profile: a profile change does not touch it', m.p5.observation === 'STALE_PROFILE' && m.p5.confirmation === 'CURRENT' && m.p6.confirmation === 'CURRENT');
    check('nothing read, nothing confirmed: NONE', m.p7.observation === 'NONE' && m.p7.confirmation === 'NONE' && m.p6.observation === 'NONE');
    check('the File changed, missing or not held: UNVERIFIED, not stale', m.p6Changed.confirmation === 'UNVERIFIED' && m.p3Missing.observation === 'UNVERIFIED' && m.p3Unbound.observation === 'UNVERIFIED');
    check('stale wins over unverified', m.p3Missing.confirmation === 'STALE_PROFILE' && m.p3NewBytesChanged.observation === 'STALE_SOURCE');
    check('new bytes for the Source: STALE_SOURCE, for a typed confirmation too; with a moved profile both reasons',
        m.p3NewBytes.observation === 'STALE_SOURCE' && m.p3NewBytes.confirmation === 'STALE_SOURCE_AND_PROFILE' && m.p6NewBytes.confirmation === 'STALE_SOURCE' && m.p3Both.observation === 'STALE_SOURCE_AND_PROFILE');
    check('another profile, no profile, a retired profile: STALE_PROFILE', ['p3Reassigned', 'p3Unassigned', 'p3ProfileRetired'].every((k) => m[k].observation === 'STALE_PROFILE'));
    check('retiring the profile keeps the observation and the confirmation; a typed confirmation stays CURRENT',
        m.retiredKeeps.observation && m.retiredKeeps.confirmation && m.p6ProfileRetired.confirmation === 'CURRENT');
    check('a binding only gets worse: CHANGED and MISSING stick', m.merge.includes('MATCHED+CHANGED=CHANGED') && m.merge.includes('MATCHED+MISSING=MISSING')
        && m.merge.includes('MISSING+CHANGED=CHANGED') && m.merge.includes('MATCHED+undefined=MATCHED') && m.merge.includes('CHANGED+MATCHED=CHANGED'));
    session('register, profile retired', r.retiredSession);

    // ------------------------------------------------------------------
    section('22. The EXTRACTION run (HDR-36-02): cancel, fail, refuse, append-only');
    const d = await call('digest');
    check('manifestDigest reference vectors (CAN-02): empty, two Sources in either order',
        d.empty === '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        && d.ab === '8fdeea72a821499e08e043456eff0e02008b83fce8bad8905a34535e4727fed0' && d.ba === d.ab);
    check('retired Sources are not in it', d.withRetired === d.ab && d.onlyRetired === d.empty);
    const lc = await call('lifecycle', { geometry: geo, register: reg });
    const a1 = lc.cancelDuringOcr;
    check('cancelled while the recogniser was busy: stops at once, not after the recognition timeout', a1.cancelMs < 5000, `${a1.cancelMs.toFixed(0)} ms`);
    check('...nothing was written while it ran', a1.duringOcr.runs === 0 && a1.duringOcr.observed === 0 && a1.duringOcr.pdf === 1);
    check('...CANCELLED, the finished Source kept (8), the interrupted one contributes nothing (4 CANCELLED)',
        a1.report.outcome === 'CANCELLED' && a1.firstSourceObserved === 8 && a1.secondSourceObserved === 0
        && a1.report.run.coverage.sheetsEvaluated === 8 && a1.report.run.coverage.sheetsExcluded === 4 && countBy(a1.report.excluded, 'code').CANCELLED === 4);
    check('...one run appended, one change to the model', a1.runsAdded === 1 && a1.applyCalls === 1);
    check('...the recogniser terminated and the document destroyed at once; the abandoned recognition starts no worker again',
        a1.afterCancel.pdf === 0 && a1.afterCancel.ocr === 0 && a1.afterRelease.ocr === 0 && a1.afterRelease.ocrCounts.refusedAfterClose >= 1);
    const b1 = lc.cancelBeforeRead;
    check('cancelled before anything was read: a CANCELLED run, nothing evaluated, still appended once',
        b1.report.outcome === 'CANCELLED' && b1.report.run.coverage.sheetsEvaluated === 0 && b1.report.run.coverage.sheetsExcluded === 12 && b1.observed === 0 && b1.runs === 1);
    const ao = lc.appendOnly;
    check('append-only: with every earlier object frozen, new runs are added and none is rewritten or removed',
        ao.again === 'COMPLETED' && ao.third === 'COMPLETED' && ao.runs === 3 && ao.oldRunsSame);
    check('runs nothing refers to any more stay (no save-time pruning in P2)', ao.unreferencedKept === 2);
    const c1 = lc.destroyFailed;
    check('PDF.js could not destroy a document: FAILED; the Source read to the end is kept, the rest RUN_FAILED',
        c1.report.outcome === 'FAILED' && c1.report.failure === 'RELEASE_UNCONFIRMED' && c1.firstKept === 8 && c1.secondNone === 0 && countBy(c1.report.excluded, 'code').RUN_FAILED === 4);
    check('...and from then on nothing opens: preview, extraction and intake refused, no getDocument()',
        c1.releaseUnconfirmed && c1.preview === 'RELEASE_UNCONFIRMED' && c1.secondExtraction.code === 'RELEASE_UNCONFIRMED' && c1.intake === 'RELEASE_UNCONFIRMED'
        && c1.getDocs === 1 && c1.getDocsAfterRefusals === 0 && c1.gate.destroyFailed === 1 && c1.leakReleased === 0);
    const d1 = lc.unexpected;
    check('an unexpected failure: FAILED, the finished Source kept; the gate is not left held', d1.report.outcome === 'FAILED'
        && d1.report.failure === 'UNEXPECTED' && d1.firstKept === 8 && d1.secondNone === 0 && d1.next === 'COMPLETED');
    const e1 = lc.sourceChanged;
    check('the File changed after intake (same size, one byte): refused before PDF.js opens it', e1.changed.excluded[0]?.code === 'SOURCE_CHANGED'
        && e1.resized.excluded[0]?.code === 'SOURCE_CHANGED' && e1.opened === 0);
    check('...its observation is left as it was; the binding is CHANGED; the reading is UNVERIFIED', e1.observationKept && e1.binding === 'CHANGED' && e1.currency === 'UNVERIFIED');
    check('no File for the Source: SOURCE_MISSING, binding MISSING', lc.sourceMissing.report.excluded.every((x) => x.code === 'SOURCE_MISSING') && lc.sourceMissing.binding === 'MISSING');
    check('2000 runs: refused before anything starts', lc.runLimit.report.code === 'RUN_LIMIT' && lc.runLimit.gate.extractionsStarted === 0 && lc.runLimit.runs === 2000);
    check('the session replaced mid-run: nothing written into the new one', lc.sessionReplaced.report.applied === false
        && lc.sessionReplaced.report.notApplied === 'SESSION_REPLACED' && lc.sessionReplaced.freshRuns === 0 && lc.sessionReplaced.freshUntouched && lc.sessionReplaced.applyCalls === 0);
    check('a Source removed mid-run: its finished results are not written (CHANGED_DURING_RUN); the run says so',
        lc.sourceRemovedMidRun.firstObserved === 0 && lc.sourceRemovedMidRun.secondObserved === 4 && lc.sourceRemovedMidRun.report.run.coverage.sheetsEvaluated === 4
        && countBy(lc.sourceRemovedMidRun.report.excluded, 'code').CHANGED_DURING_RUN === 8);
    for (const [label, value] of [['cancelled run', a1.session], ['append-only', ao.session], ['failed run', c1.session], ['source removed mid-run', lc.sourceRemovedMidRun.session]]) session(label, value);

    section('23. PDF.js document ownership while extracting');
    const x = lc.exclusive;
    check('extraction does not start while intake holds the gate', x.whileIntake.code === 'INTAKE_ACTIVE');
    check('while it runs: the preview, intake and a second extraction are refused', x.during?.previewOpen === 'EXTRACTION_ACTIVE'
        && x.during.intake === 'EXTRACTION_ACTIVE' && x.during.nested === 'EXTRACTION_ACTIVE', JSON.stringify(x.during));
    const ev = x.events;
    const firstEnd = ev.indexOf('pdf-end');
    const nextStart = ev.indexOf('pdf-start');
    check('the preview\'s document is destroyed (slowly) before the extraction document starts', firstEnd >= 0 && nextStart > firstEnd && ev[0] === 'destroy-asked', ev.join(' > '));
    check('never more than one PDF.js document while extracting', x.peak === 1 && x.gate.peakLive === 1 && x.gate.live === 0);
    check('afterwards the preview opens again', x.previewAfter === 'opened');
    check('every PDF.js document and recogniser of these runs ended', lc.workersAfter.pdf.live === 0 && lc.workersAfter.ocr.live === 0 && lc.workersAfter.ocr.started > 0);

    // ------------------------------------------------------------------
    section('24. CMap and standard fonts: the same pages without and with the data files');
    const cm = truth('p2a-cmap');
    const cx = await call('cmap', cm);
    const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);
    check('today (P1 intake, no data files): C1 and C2 count as having no text', JSON.stringify(cx.before.p1IntakeKinds) === '["scanned","scanned","text-native","text-native"]'
        && JSON.stringify(cx.before.kinds) === JSON.stringify(cx.before.p1IntakeKinds));
    check('with them every page has its text (what P2-B will give intake)', JSON.stringify(cx.after.kinds) === '["text-native","text-native","text-native","text-native"]');
    check('C1 (non-embedded CID font, UniJIS-UCS2-H, no ToUnicode): nothing drawn and nothing read before; exact native text after',
        sum(cx.before.pixels[0]) === 0 && FIELDS.every((f) => cx.after.values[0][f].value === cm.pages[0].values[f] && cx.after.values[0][f].source === 'native')
        && FIELDS.every((f) => cx.before.values[0][f].value !== cm.pages[0].values[f]));
    note('C1 drawn after (dark pixels per field; needs a CJK system font, as non-embedded fonts do)', JSON.stringify(cx.after.pixels[0]));
    check('C2 (embedded, Adobe-Japan1, no ToUnicode): not even drawn before; drawn after', sum(cx.before.pixels[1]) === 0 && sum(cx.after.pixels[1]) > 0,
        `${sum(cx.before.pixels[1])} -> ${sum(cx.after.pixels[1])}`);
    check('C2 after: text is there but not the sheet\'s -- a wrong reading from the text layer (the residual risk a person must catch)',
        cx.after.values[1].drawingTitle.source === 'native' && cx.after.values[1].drawingTitle.value !== '' && cx.after.values[1].drawingTitle.value !== cm.pages[1].values.drawingTitle,
        JSON.stringify(cx.after.values[1].drawingTitle.value));
    check('C3 (embedded with ToUnicode) and C4 (standard fonts): identical before and after, drawn and read',
        [2, 3].every((i) => JSON.stringify(cx.before.pixels[i]) === JSON.stringify(cx.after.pixels[i]) && sum(cx.after.pixels[i]) > 0
            && FIELDS.every((f) => cx.before.values[i][f].value === cm.pages[i].values[f] && cx.after.values[i][f].value === cm.pages[i].values[f])));
    session('cmap', cx.session);

    section('25. JPX (JPEG 2000) scans: the same block without and with the decoders');
    const jt = truth('p2a-jpx');
    const jx = await call('jpx', jt);
    check('without the decoders the JPX block draws nothing; its PNG twin draws', sum(jx.pixels.before[0]) === 0 && sum(jx.pixels.before[1]) > 0);
    check('with them the JPX block draws like its PNG twin (within 2%)', Math.abs(sum(jx.pixels.after[0]) - sum(jx.pixels.after[1])) <= 0.02 * sum(jx.pixels.after[1])
        && JSON.stringify(jx.pixels.after[1]) === JSON.stringify(jx.pixels.before[1]), `${sum(jx.pixels.after[0])} vs ${sum(jx.pixels.after[1])}`);
    const jhits = (vals) => FIELDS.filter((f) => vals && norm(vals[f].value).includes(norm(jt.pages[0].values[f]))).length;
    check('recognition: nothing from the JPX block before; after, as much as from the PNG twin (>= 3 of 4)',
        jhits(jx.beforeValues[0]) === 0 && jhits(jx.afterValues[0]) >= 3 && jhits(jx.afterValues[0]) === jhits(jx.afterValues[1]),
        `before ${jhits(jx.beforeValues[0])}, after ${jhits(jx.afterValues[0])}, PNG ${jhits(jx.afterValues[1])}`);
    const pathsServed = [...new Set(assetRequests.map((u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/\/[^/]*$/, '/')))];
    check('the data files came from this origin: CMaps, standard fonts and the JPX decoder were fetched under /pdfjs/',
        assetRequests.some((u) => u.includes('/pdfjs/cmaps/')) && assetRequests.some((u) => u.includes('/pdfjs/wasm/openjpeg')) && assetRequests.every((u) => u.startsWith(ORIGIN)),
        pathsServed.join(' '));
    session('jpx', jx.session);

    // ------------------------------------------------------------------
    section('26. Live P2-A sessions against the canonical contract');
    for (const [label, value] of sessions) {
        const fileValue = envelope(value);
        const errors = validate(schema, fileValue);
        check(`"${label}" is valid against portable-project.schema.json`, errors.length === 0, errors.slice(0, 3).join(' | '));
        const relations = checkRelations(fileValue, { now: Date.now() });
        check(`"${label}" passes portable-project.semantic.mjs`, relations.problems.length === 0 && relations.warnings.length === 0, JSON.stringify(relations).slice(0, 300));
    }
    const base = envelope(r.session);
    const mutate = (fn) => { const copy = structuredClone(base); fn(copy); return copy; };
    const first = (f) => f.drawingSet.sheets.find((s) => s.observation);
    const rejects = (label, fn) => probe(`the schema check rejects ${label}`, validate(schema, mutate(fn)).length > 0);
    rejects('a 1001-character raw text', (f) => { first(f).observation.fields.drawingTitle.rawText = 'x'.repeat(1001); });
    rejects('a value with a line feed', (f) => { first(f).observation.fields.drawingNumber.value = 'a\nb'; });
    rejects('an ocrScore of 101', (f) => { first(f).observation.fields.drawingTitle.ocrScore = 101; });
    rejects('a run outcome that is not terminal', (f) => { f.drawingSet.analysisRuns[0].outcome = 'RUNNING'; });
    const relationProblem = (fn) => checkRelations(mutate(fn), { now: Date.now() }).problems.map((pr) => pr.code);
    probe('the semantic check rejects an observation naming no run', relationProblem((f) => { first(f).observation.runId = crypto.randomUUID(); }).includes(RELATION_PROBLEM.DANGLING_RUN));
    probe('...a reading under a revision the profile never had', relationProblem((f) => { first(f).observation.profile.profileRevision = 99; }).includes(RELATION_PROBLEM.PROFILE_REVISION));
    probe('...a live Sheet on a retired profile', relationProblem((f) => { f.drawingSet.titleBlockProfiles[0].retiredAt = f.drawingSet.titleBlockProfiles[0].updatedAt; }).includes(RELATION_PROBLEM.RETIRED_STATE));
    probe('...a COMPLETED run with no completedAt', relationProblem((f) => { f.drawingSet.analysisRuns[0].completedAt = null; }).includes(RELATION_PROBLEM.RUN_STATE));

    // ------------------------------------------------------------------
    section('27. P2-A privacy and storage');
    const storage = await call('storage');
    const everything = JSON.stringify(collected);
    check('no sentinel (text outside every field rectangle) in anything the harness returned: model, reports, reasons',
        !everything.includes(SENTINEL), `${everything.length} characters scanned`);
    check('no sentinel on the page', !storage.bodyText.includes(SENTINEL));
    check('no page text kept: every raw text in every live session is one field\'s, at most 1000 characters', sessions.every(([, s]) =>
        s.drawingSet.sheets.every((sh) => !sh.observation || FIELDS.every((f) => [...sh.observation.fields[f].rawText].length <= 1000))));
    const emptyStorage = (s) => s.databases.length === 0 && s.cacheNames.length === 0 && s.local === 0 && s.session === 0;
    const storageLine = (s) => JSON.stringify({ databases: s.contents, caches: s.cacheNames, local: s.local, session: s.session });
    check('before the first P2-A recognition this origin held no IndexedDB database, no Cache API cache and no localStorage / sessionStorage entry',
        emptyStorage(storageAtStart), storageLine(storageAtStart));
    check('the harness page wrote nothing to localStorage, sessionStorage, IndexedDB or the Cache API (instrumented)',
        storage.writes.writes === 0 && storage.local === 0 && storage.session === 0, JSON.stringify(storage.writes.calls));
    note('IndexedDB databases present, with their stores and keys', JSON.stringify(storage.contents));
    check('IndexedDB holds nothing (Gate: IndexedDB writes 0)', storage.databases.length === 0,
        storage.databases.length ? `${storage.databases.join(',')}: ${JSON.stringify(storage.contents)}` : '');
    check('the Cache API holds nothing', storage.cacheNames.length === 0, storage.cacheNames.join(','));
    // The language data cache is written inside the tesseract worker, where
    // nothing on this page can intercept it. What can be seen is what each
    // worker was told: its cacheMethod, as the worker received it.
    const ocrWorkers = await call('workers');
    check('every tesseract worker M7 started was told cacheMethod \'none\' (neither read nor write its IndexedDB cache), and none is left running',
        ocrWorkers.ocrCacheMethods.length > 0 && ocrWorkers.ocrCacheMethods.every((m) => m === 'none') && ocrWorkers.ocr.live === 0,
        `${ocrWorkers.ocrCacheMethods.length} workers loaded languages: ${JSON.stringify(countBy(ocrWorkers.ocrCacheMethods.map((m) => ({ m })), 'm'))}; started ${ocrWorkers.ocr.started}, live ${ocrWorkers.ocr.live}`);

    // Controls, each in a fresh browser context with storage of its own: the
    // existing tools' engines, with their defaults, must still write the cache
    // where the checks above would see it (so an empty IndexedDB above means
    // nothing was written, not that nothing could be seen), and M7's engine,
    // alone in a clean context, must leave nothing behind a real recognition.
    const controlRequests = [];
    const controlErrors = [];
    const inFreshContext = async (kind) => {
        const context = await page.browser().createBrowserContext();
        try {
            const control = await context.newPage();
            control.setDefaultTimeout(0);
            control.on('request', (r) => controlRequests.push(r.url()));
            control.on('pageerror', (e) => controlErrors.push(e.message));
            await control.goto(`${ORIGIN}/scripts/smoke-m7-p2a-harness.html`, { waitUntil: 'networkidle0' });
            await control.waitForFunction(() => window.__m7p2aReady === true, { timeout: 300000 });
            return await control.evaluate((k, t) => window.__m7p2a.ocrCacheProbe(k, t), kind, truth('p2a-jpx'));
        } finally {
            await context.close().catch(() => { });
        }
    };
    const cachedLanguages = (s) => {
        const keys = s.contents['keyval-store']?.keyval ?? [];
        return keys.includes('./eng.traineddata') && keys.includes('./jpn.traineddata');
    };
    for (const [kind, label] of [
        ['register-default', 'the Drawing Register tool\'s engine, new RegisterOcrEngine()'],
        ['register-langs', 'new RegisterOcrEngine(\'jpn+eng\')'],
        ['pipeline-default', 'the OCR / text-extraction pipelines\' engine, new OcrEngine(\'jpn+eng\')'],
    ]) {
        const r = await inFreshContext(kind);
        check(`control, fresh context: ${label} keeps tesseract.js's default and still caches -- keyval-store holds ./eng.traineddata and ./jpn.traineddata after one start`,
            emptyStorage(r.before) && r.cacheMethods.length === 1 && r.cacheMethods[0] === 'default' && cachedLanguages(r.after) && r.workersLive === 0,
            `cacheMethod ${JSON.stringify(r.cacheMethods)}; before ${storageLine(r.before)}; after ${storageLine(r.after)}`);
    }
    const m7Control = await inFreshContext('m7');
    check('control, fresh context: M7\'s extraction recognises the JPX scans and leaves this origin\'s storage exactly as empty as it found it',
        emptyStorage(m7Control.before) && emptyStorage(m7Control.after) && m7Control.extraction.outcome === 'COMPLETED' && m7Control.extraction.ocrValues > 0
        && m7Control.cacheMethods.length > 0 && m7Control.cacheMethods.every((m) => m === 'none') && m7Control.workersLive === 0,
        `${JSON.stringify(m7Control.extraction)}; cacheMethod ${JSON.stringify(m7Control.cacheMethods)}; before ${storageLine(m7Control.before)}; after ${storageLine(m7Control.after)}`);
    const controlExternal = controlRequests.filter((url) => !url.startsWith(ORIGIN) && /^https?:/.test(url));
    check('the control contexts made no request off this origin and raised no page error',
        controlExternal.length === 0 && controlErrors.length === 0, [...controlExternal, ...controlErrors].join(' | '));
}
