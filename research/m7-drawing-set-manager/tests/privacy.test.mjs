/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * What a Portable Project JSON must never contain, checked two ways: the schema
 * has nowhere to put it, and the writer does not carry it even when it is
 * sitting on the in-memory model.
 *
 * None of this makes the file non-sensitive. It holds a project's name, its
 * drawing numbers and titles, revisions, QA results and a reviewer's comments.
 * The last test states that, so it is not lost among the things that are absent.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { seededUuidSource } from '../prototype/ids.mjs';
import { CANDIDATE_LIMITS } from '../prototype/limits.proposed.mjs';
import { sanitizeDisplayName, sanitizeMultiLine, sanitizeSingleLine } from '../prototype/model-ops.mjs';
import { exportProject, importProject, loadSchema } from '../prototype/project-io.mjs';
import { CHAR, smallProject } from './helpers.mjs';

const schema = loadSchema();

/** Every property name the schema declares, anywhere. */
function declaredPropertyNames(node, names = new Set()) {
    if (node === null || typeof node !== 'object') return names;
    if (node.properties) for (const name of Object.keys(node.properties)) names.add(name);
    for (const value of Object.values(node)) declaredPropertyNames(value, names);
    return names;
}

/** Every string schema, with the path it was found at. */
function stringSchemas(node, path = '#', out = []) {
    if (node === null || typeof node !== 'object') return out;
    if (node.type === 'string') out.push({ path, node });
    for (const [key, value] of Object.entries(node)) stringSchemas(value, `${path}/${key}`, out);
    return out;
}

test('the schema declares no property for bytes, images, text dumps, paths, handles, URLs or credentials', () => {
    const names = [...declaredPropertyNames(schema)];
    const forbidden = /byte(s)?$|base64|blob|buffer|image|thumbnail|preview|raster|pixel|canvas|fulltext|pagetext|ocrtext|words|tokens|path|dir|folder|handle|url|uri|href|link|token$|secret|password|credential|apikey|cookie|session|debug|dump|objectgraph|xref/i;
    const hits = names.filter((name) => forbidden.test(name));
    // `byteLength` is a number of bytes, not bytes; `rawText` is one field's excerpt, bounded below.
    assert.deepEqual(hits, []);
    assert.ok(names.includes('byteLength') && names.includes('rawText'));
});

test('every string in the schema is bounded, and the bounds leave no room for a document', () => {
    const strings = stringSchemas(schema);
    assert.ok(strings.length > 20);
    let longest = 0;
    for (const { path, node } of strings) {
        const bounded = node.maxLength !== undefined || node.enum !== undefined || node.const !== undefined;
        assert.ok(bounded, `${path} is unbounded`);
        if (node.maxLength !== undefined) longest = Math.max(longest, node.maxLength);
    }
    // The largest single string is a reviewer's comment.
    assert.equal(longest, CANDIDATE_LIMITS.maxCommentLength);
    // The only machine-extracted text is one title-block field's excerpt. A whole
    // page of text, or an OCR page result, does not fit and has no property.
    assert.equal(schema.$defs.FieldRawText.maxLength, CANDIDATE_LIMITS.maxFieldRawTextLength);
    assert.ok(CANDIDATE_LIMITS.maxFieldRawTextLength <= 1000);
});

test('the writer is an allow-list: runtime state on the model does not reach the file', () => {
    const { model, now } = smallProject();
    // Everything a session might hang on the model while it works.
    const B = CHAR.BACKSLASH;
    const source = model.drawingSet.sources[0];
    source.file = { name: 'set.pdf', path: `C:${B}Users${B}someone${B}set.pdf` };
    source.bytes = new Uint8Array(1024).fill(0x25);
    source.handle = { kind: 'file', name: 'set.pdf' };
    source.blobUrl = 'blob:http://localhost/3f6f1f3e-0000-4000-8000-000000000000';
    source.bindingState = 'MATCHED';
    source.absolutePath = `${B}${B}fileserver${B}projects${B}set.pdf`;
    const sheet = model.drawingSet.sheets[0];
    sheet.thumbnail = `data:image/png;base64,${'iVBORw0KGgo='.repeat(50)}`;
    sheet.pageText = 'every word on the sheet '.repeat(200);
    sheet.ocrWords = [{ text: 'word', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, confidence: 90 }];
    sheet.tokens = [{ text: 'token', x0: 0, y0: 0, x1: 1, y1: 1 }];
    sheet.pdfPage = { _pageIndex: 0, _transport: { secretToken: 'sk-live-do-not-leak' } };
    model.session = { authToken: 'Bearer do-not-leak', cookies: 'sid=do-not-leak' };
    model.drawingSet.debug = { objectGraph: { xref: [1, 2, 3] } };

    const ids = seededUuidSource(11);
    const { text, bytes } = exportProject(model, { now, newFileId: ids() });
    for (const leak of ['do-not-leak', 'blob:', 'data:image', 'base64', 'fileserver', 'someone', 'every word on the sheet', 'thumbnail', 'pageText', 'ocrWords', 'tokens', 'bindingState', 'absolutePath', 'objectGraph', '_transport', 'authToken']) {
        assert.ok(!text.includes(leak), `"${leak}" reached the file`);
    }
    // And the file that was written is an ordinary, importable one.
    assert.equal(importProject(bytes, { now: now + 1 }).status, 'ACCEPTED');
});

test('the saved file contains no path-like, URL-like or data-like string anywhere', () => {
    const { exported } = smallProject();
    const suspicious = [];
    const visit = (value, path) => {
        if (typeof value === 'string') {
            if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || /^(blob|data|file|https?):/i.test(value) || /^[A-Za-z0-9+/]{200,}={0,2}$/.test(value)) suspicious.push(path);
        } else if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}/${i}`));
        else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, `${path}/${key}`);
    };
    visit(exported.document, '');
    assert.deepEqual(suspicious, []);
});

test('a file name from any system is stored as a bare label that cannot be read as a path', () => {
    const B = CHAR.BACKSLASH;
    assert.equal(sanitizeDisplayName(`C:${B}Users${B}someone${B}set.pdf`), 'C__Users_someone_set.pdf');
    assert.equal(sanitizeDisplayName(`${B}${B}server${B}share${B}set.pdf`), '__server_share_set.pdf');
    assert.equal(sanitizeDisplayName('/home/someone/set.pdf'), '_home_someone_set.pdf');
    assert.equal(sanitizeDisplayName('..'), '_');
    assert.equal(sanitizeDisplayName(''), '_');
    assert.equal(sanitizeDisplayName(`evil${CHAR.RLO}fdp.exe`), 'evil fdp.exe');
    assert.equal(sanitizeDisplayName('意匠図 第3版.pdf'), '意匠図 第3版.pdf');
    assert.equal(sanitizeDisplayName('x'.repeat(400)).length, 255);
    // Whatever goes in, the result satisfies the schema's FileName.
    const pattern = new RegExp(schema.$defs.FileName.pattern, 'u');
    for (const input of [`a${B}b`, 'a/b', 'a:b', `a${CHAR.NUL}b`, `a${CHAR.LINE_SEPARATOR}b`, '.', '   ', 'ok.pdf']) {
        assert.ok(pattern.test(sanitizeDisplayName(input)), JSON.stringify(input));
    }
});

test('text read from a PDF is brought into the storable domain before it enters the model', () => {
    const single = new RegExp(schema.$defs.FieldValue.pattern, 'u');
    const multi = new RegExp(schema.$defs.FieldRawText.pattern, 'u');
    const dirty = `図面番号${CHAR.NUL}${CHAR.BEL}\r\nA-101${CHAR.RLO}${CHAR.LINE_SEPARATOR}\tend`;
    assert.ok(single.test(sanitizeSingleLine(dirty, 300)));
    assert.ok(multi.test(sanitizeMultiLine(dirty, 1000)));
    // Line structure survives in the multi-line form, because the label/value split depends on it.
    assert.ok(sanitizeMultiLine(dirty, 1000).includes('\n'));
    assert.equal(sanitizeSingleLine('x'.repeat(1000), 300).length, 300);
    assert.equal(sanitizeMultiLine('x'.repeat(5000), 1000).length, 1000);
    // A lone surrogate is replaced rather than stored.
    assert.ok(sanitizeSingleLine(`a${String.fromCharCode(0xd800)}b`, 300).isWellFormed());
});

test('what the file DOES contain is confidential project metadata, and must be described as such', () => {
    const { exported } = smallProject();
    const set = exported.document.drawingSet;
    // Project name, drawing numbers, titles, revisions, dates:
    assert.ok(exported.document.project.name.length > 0);
    const confirmed = set.sheets.find((s) => s.confirmation);
    assert.ok(confirmed.confirmation.values.drawingNumber.length > 0);
    assert.ok(confirmed.confirmation.values.drawingTitle.length > 0);
    // Source file names (which often name the project or the client):
    assert.ok(set.sources[0].displayName.endsWith('.pdf'));
    // QA results and a reviewer's own words:
    assert.ok(set.findings.length > 0);
    assert.ok(set.decisions.some((d) => d.comment.length > 0));
    // Field excerpts as read from the title block:
    assert.ok(set.sheets.some((s) => s.observation && s.observation.fields.drawingTitle.rawText.length > 0));
});
