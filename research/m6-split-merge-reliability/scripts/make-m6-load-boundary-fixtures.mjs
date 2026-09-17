/**
 * Synthetic documents for the M6 Load Boundary Sub-Spike (B3).
 *
 * B2 showed that pdf-lib 1.17.1 expands a document at load, before any graph
 * exists to measure. These documents are the shapes that expansion can take,
 * each written by hand so that exactly one thing about it is dangerous — or so
 * that nothing is, where the question is whether a boundary refuses too much.
 *
 * Every expansion path comes from pdf-lib's own load code, read and cited in
 * load-boundary.md rather than assumed:
 *
 *   object streams and cross-reference streams are decoded as they are met
 *   an XRef stream's declared /Size or /Index sets how many entries are built
 *   an object stream's offsets are not bounds-checked, so objects can overlap
 *   an indirect /Type, an escaped name, or junk the parser skips can each
 *     bring a stream into that decode without looking like one
 *   the encryption check runs only after all of the above
 *
 * Each refusal is expected at a named stage of the boundary (see
 * prototype/load-boundary.mjs): input, raw-name-scan, walk, attribution,
 * declared-values, decode, decoded-content. The stage matters as much as the
 * code. L16 and L16b are the pair that shows it: L16 hides the name /ObjStm
 * inside an object stream and points a later stream's /Type at it, and is
 * refused at the walk by the indirect-/Type rule, before anything is decoded;
 * L16b puts the same name in the same place with nothing pointing at it, so
 * only the decoded-content scan can refuse it.
 *
 * L21-L26 are parser ambiguities: shapes where pdf-lib would read, recover or
 * resolve something the boundary will not guess at, and must refuse instead.
 *
 * Nothing here is a customer document; every byte is generated, deterministic,
 * and written to `test-fixtures/m6-load-boundary/`, which is ignored.
 *
 * `corpus.json` records, per document, what a fail-closed boundary is expected
 * to answer and why, together with the test limits those expectations assume.
 * The limits are research test values chosen to put the boundary cases where a
 * gate can reach them. They are not product values and not memory figures.
 *
 * Run:  node research/m6-split-merge-reliability/scripts/make-m6-load-boundary-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-load-boundary');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const MIB = 1024 * 1024;

/** Research test limits. Not product values; see the header. */
export const TEST_LIMITS = {
    maxInputBytes: 64 * MIB,
    maxDecodedBytesPerStream: 4 * MIB,
    maxDecodedBytesTotal: 8 * MIB,
    maxDecodeStreams: 64,
    maxXrefEntries: 100000,
    maxObjectsPerObjectStream: 10000,
    maxNestingDepth: 64,
    inflateChunkBytes: 16384,
};

const BOMB = 32 * MIB;
const written = [];
const bin = (s) => Buffer.from(s, 'latin1');

function save(name, bytes, expect, note, extra = {}) {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, ...expect, note, ...extra });
}

/**
 * A document assembled by hand. `objects` are { num, dict, data?, raw?,
 * length? }: a stream when `data` is given, whose /Length is the data length
 * unless `length` overrides the token; otherwise `raw` is the object body.
 * `before` bytes are emitted ahead of an object, for junk between objects.
 */
function assemble({ objects, xref = 'table', trailer = '', base = null, prev = null, header = true }) {
    const parts = [];
    let length = base ? base.length : 0;
    const push = (chunk) => {
        const b = Buffer.isBuffer(chunk) ? chunk : bin(chunk);
        parts.push(b);
        length += b.length;
    };
    if (base) parts.push(base);
    if (header && !base) push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    const offsets = {};
    for (const o of objects) {
        if (o.before) push(o.before);
        offsets[o.num] = length;
        if (o.data !== undefined) {
            const lengthToken = o.length ?? String(o.data.length);
            push(`${o.num} 0 obj\n<< ${o.dict} /Length ${lengthToken} >>\nstream\n`);
            push(o.data);
            push('\nendstream\nendobj\n');
        } else {
            push(`${o.num} 0 obj\n${o.raw}\nendobj\n`);
        }
    }
    const xrefOffset = length;
    if (xref === 'table') {
        const nums = Object.keys(offsets).map(Number);
        const size = Math.max(...nums) + 1;
        const rows = [];
        for (let n = 0; n < size; n += 1) {
            rows.push(offsets[n] === undefined
                ? (n === 0 ? '0000000000 65535 f \n' : '0000000000 00000 f \n')
                : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
        }
        const prevToken = prev === null ? '' : ` /Prev ${prev === 'self' ? xrefOffset : prev}`;
        push(`xref\n0 ${size}\n${rows.join('')}trailer\n<< /Size ${size} /Root 1 0 R${prevToken} ${trailer} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    } else if (xref === 'stream-last') {
        // The last object is an XRef stream standing in for the trailer.
        const last = objects[objects.length - 1];
        push(`startxref\n${offsets[last.num]}\n%%EOF\n`);
    }
    return { bytes: Buffer.concat(parts), xrefOffset, offsets };
}

/** The pages a hand-built document needs: catalog 1, pages 2, page 3. */
const skeleton = (pageExtra = '') => [
    { num: 1, raw: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, raw: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, raw: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${pageExtra}>>` },
];

/**
 * Object-stream contents that decode to exactly `decodedLength` bytes: the
 * offset table, the objects, and trailing spaces. Returns the deflated data
 * and the /N and /First the dictionary needs.
 */
function objectStream(entries, decodedLength = null) {
    let bodies = '';
    const pairs = [];
    for (const [num, body] of entries) {
        pairs.push(`${num} ${bodies.length}`);
        bodies += `${body} `;
    }
    const head = `${pairs.join(' ')} `;
    let decoded = bin(head + bodies);
    if (decodedLength !== null) {
        if (decodedLength < decoded.length) throw new Error(`object stream needs ${decoded.length} B, asked for ${decodedLength}`);
        decoded = Buffer.concat([decoded, Buffer.alloc(decodedLength - decoded.length, 0x20)]);
    }
    return {
        data: zlib.deflateSync(decoded, { level: 9 }),
        dict: `/Type /ObjStm /N ${entries.length} /First ${head.length} /Filter /FlateDecode`,
        decodedLength: decoded.length,
    };
}

const REFUSE = (code, stage) => ({ expect: 'REFUSE', code, stage });
const PASS = { expect: 'PASS', code: null, stage: null };

// ---- L1: a small object stream that decodes to 32 MiB ------------------------------
{
    const os = objectStream([[10, '<< /M6Padded true >>']], BOMB);
    const { bytes } = assemble({ objects: [...skeleton(), { num: 9, dict: os.dict, data: os.data }] });
    save('lb-l1-objstm-inflation', bytes, REFUSE('DECODED_BYTES_PER_STREAM', 'decode'),
        `an object stream of ${os.data.length} B that decodes to ${os.decodedLength} B`,
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}

// ---- L2: a cross-reference stream that decodes to 32 MiB ---------------------------
{
    const data = zlib.deflateSync(Buffer.alloc(BOMB, 0), { level: 9 });
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 9, dict: '/Type /XRef /Size 10 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', data }],
        xref: 'stream-last',
    });
    save('lb-l2-xref-stream-inflation', bytes, REFUSE('DECODED_BYTES_PER_STREAM', 'decode'),
        `a cross-reference stream of ${data.length} B that decodes to ${BOMB} B`,
        { baselineRisk: 'decode', decodedBytes: BOMB });
}

// ---- L2b: a cross-reference stream that declares a million entries --------------------
{
    const data = zlib.deflateSync(Buffer.alloc(8, 0), { level: 9 });
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 9, dict: '/Type /XRef /Size 1000000 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', data }],
        xref: 'stream-last',
    });
    save('lb-l2b-xref-declared-entries', bytes, REFUSE('XREF_ENTRY_CAP', 'declared-values'),
        'a cross-reference stream of 8 decoded bytes whose /Size declares 1,000,000 entries',
        { baselineRisk: 'entries', declaredEntries: 1000000 });
}

// ---- L3: object streams each under the per-stream cap, over the cumulative one -------
{
    const each = 3 * MIB;
    const streams = [0, 1, 2].map((i) => objectStream([[20 + i, `<< /M6Part ${i} >>`]], each));
    const { bytes } = assemble({
        objects: [...skeleton(), ...streams.map((os, i) => ({ num: 10 + i, dict: os.dict, data: os.data }))],
    });
    save('lb-l3-cumulative-decode', bytes, REFUSE('DECODED_BYTES_TOTAL', 'decode'),
        'three object streams of 3 MiB decoded each: under the per-stream cap, 9 MiB together',
        { baselineRisk: 'decode', decodedBytes: 3 * each });
}

// ---- L4 / L4b: incremental updates ---------------------------------------------------------
{
    const base = assemble({ objects: skeleton() });
    const os = objectStream([[11, '<< /M6Update true >>']], BOMB / 2);
    const update = assemble({ base: base.bytes, prev: base.xrefOffset, objects: [{ num: 10, dict: os.dict, data: os.data }] });
    save('lb-l4-incremental-update', update.bytes, REFUSE('DECODED_BYTES_PER_STREAM', 'decode'),
        `a clean document with an appended update whose object stream decodes to ${os.decodedLength} B`,
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });

    const cleanUpdate = assemble({
        base: base.bytes, prev: 'self',
        objects: [{ num: 4, raw: '<< /M6Appended true >>' }],
    });
    save('lb-l4b-prev-cycle', cleanUpdate.bytes, PASS,
        'a clean incremental update whose trailer /Prev points at its own cross-reference section');
}

// ---- L5 / L5b: hybrid-reference files -----------------------------------------------------
{
    const rows = Buffer.alloc(10 * 4, 0);
    for (let n = 0; n < 10; n += 1) rows[n * 4] = n === 0 ? 0 : 1;
    const clean = zlib.deflateSync(rows, { level: 9 });
    const cleanDoc = assemble({
        objects: [...skeleton(), { num: 9, dict: '/Type /XRef /Size 10 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', data: clean }],
        trailer: '/XRefStm 0',
    });
    save('lb-l5-hybrid-clean', cleanDoc.bytes, PASS,
        'a classic cross-reference table whose trailer names an /XRefStm, a small cross-reference stream');

    const bomb = zlib.deflateSync(Buffer.alloc(BOMB, 0), { level: 9 });
    const bombDoc = assemble({
        objects: [...skeleton(), { num: 9, dict: '/Type /XRef /Size 10 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode', data: bomb }],
        trailer: '/XRefStm 0',
    });
    save('lb-l5b-hybrid-inflation', bombDoc.bytes, REFUSE('DECODED_BYTES_PER_STREAM', 'decode'),
        `a hybrid file whose /XRefStm stream decodes to ${BOMB} B`,
        { baselineRisk: 'decode', decodedBytes: BOMB });
}

// ---- L6 / L6b: a /Length that does not reach endstream --------------------------------------
{
    const os = objectStream([[11, '<< /M6WrongLength true >>']], BOMB);
    const wrong = String(os.data.length - 5);
    const { bytes } = assemble({ objects: [...skeleton(), { num: 10, dict: os.dict, data: os.data, length: wrong }] });
    save('lb-l6-objstm-wrong-length', bytes, REFUSE('AMBIGUOUS_STREAM_LENGTH', 'declared-values'),
        'an object stream whose /Length stops five bytes short — pdf-lib falls back to scanning for endstream and decodes it anyway',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });

    const content = bin('BT /F1 12 Tf 72 720 Td (M6-LB-L6B) Tj ET');
    const clean = assemble({
        objects: [...skeleton('/Contents 4 0 R '), { num: 4, dict: '', data: content, length: '5' }],
    });
    save('lb-l6b-content-wrong-length', clean.bytes, PASS,
        'an ordinary content stream whose /Length is wrong — found by the same fallback pdf-lib uses, and never decoded');
}

// ---- L7 / L7b: an indirect /Length -----------------------------------------------------------
{
    const os = objectStream([[11, '<< /M6IndirectLength true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 8, raw: String(os.data.length) }, { num: 10, dict: os.dict, data: os.data, length: '8 0 R' }],
    });
    save('lb-l7-objstm-indirect-length', bytes, REFUSE('AMBIGUOUS_STREAM_LENGTH', 'declared-values'),
        'an object stream whose /Length is an indirect reference — never resolved by pdf-lib, which scans for endstream',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });

    const content = bin('BT /F1 12 Tf 72 720 Td (M6-LB-L7B) Tj ET');
    const clean = assemble({
        objects: [...skeleton('/Contents 4 0 R '), { num: 5, raw: String(content.length) }, { num: 4, dict: '', data: content, length: '5 0 R' }],
    });
    save('lb-l7b-content-indirect-length', clean.bytes, PASS,
        'an ordinary content stream with an indirect /Length');
}

// ---- L8 / L8b: filters the boundary does not decode ----------------------------------------------
{
    const os = objectStream([[11, '<< /M6Chain true >>']], MIB);
    const hex = bin(`${os.data.toString('hex')}>`);
    const chained = assemble({
        objects: [...skeleton(), { num: 10, dict: os.dict.replace('/Filter /FlateDecode', '/Filter [/ASCIIHexDecode /FlateDecode]'), data: hex }],
    });
    save('lb-l8-filter-chain', chained.bytes, REFUSE('UNSUPPORTED_FILTER', 'declared-values'),
        'an object stream behind a two-filter chain');

    const lzw = assemble({
        objects: [...skeleton(), { num: 10, dict: '/Type /ObjStm /N 1 /First 5 /Filter /LZWDecode', data: bin('\x80\x0b\x60\x50\x22\x0c\x0c\x85\x01') }],
    });
    save('lb-l8b-lzw', lzw.bytes, REFUSE('UNSUPPORTED_FILTER', 'declared-values'), 'an object stream under LZWDecode');
}

// ---- L9 / L10: clean documents from pdf-lib's own writer -----------------------------------------
for (const [name, useObjectStreams, note] of [
    ['lb-l9-clean-objstm', true, 'a clean three-page document written with object streams'],
    ['lb-l10-clean-classic', false, 'a clean three-page document with a classic cross-reference table'],
]) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i += 1) {
        const page = doc.addPage([595, 842]);
        page.drawText(`M6-LB-${name}-${i}`, { x: 72, y: 720, size: 14, font, color: rgb(0, 0, 0) });
    }
    save(name, Buffer.from(await doc.save({ useObjectStreams })), PASS, note);
}

// ---- L11 / L12: exactly at the cap, and one byte over ------------------------------------------------
{
    const per = TEST_LIMITS.maxDecodedBytesPerStream;
    const total = TEST_LIMITS.maxDecodedBytesTotal;
    const single = (name, decoded, expect, note) => {
        const os = objectStream([[11, '<< /M6Threshold true >>']], decoded);
        const { bytes } = assemble({ objects: [...skeleton(), { num: 10, dict: os.dict, data: os.data }] });
        save(name, bytes, expect, note, { decodedBytes: os.decodedLength });
    };
    single('lb-l11-per-stream-exact', per, PASS, `one object stream decoding to exactly ${per} B, the per-stream cap`);
    single('lb-l12-per-stream-plus-one', per + 1, REFUSE('DECODED_BYTES_PER_STREAM', 'decode'), `one object stream decoding to ${per + 1} B`);

    const several = (name, sizes, expect, note) => {
        const streams = sizes.map((size, i) => objectStream([[30 + i, `<< /M6Sum ${i} >>`]], size));
        const { bytes } = assemble({ objects: [...skeleton(), ...streams.map((os, i) => ({ num: 10 + i, dict: os.dict, data: os.data }))] });
        save(name, bytes, expect, note, { decodedBytes: streams.reduce((s, os) => s + os.decodedLength, 0) });
    };
    several('lb-l11c-total-exact', [per, per], PASS, `two object streams decoding to ${total} B together, the cumulative cap`);
    several('lb-l12c-total-plus-one', [per, per - 40, 41], REFUSE('DECODED_BYTES_TOTAL', 'decode'),
        `three object streams, each under the per-stream cap, decoding to ${total + 1} B together`);
}

// ---- L13: slow to parse, for Worker cancellation and timeout -----------------------------------------
{
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([595, 842]);
    const refs = [];
    for (let i = 0; i < 100000; i += 1) refs.push(doc.context.register(doc.context.obj({ Type: 'M6Leaf', I: i })));
    page.node.set(PDFName.of('M6Payload'), doc.context.obj(refs));
    save('lb-l13-slow-parse', Buffer.from(await doc.save({ useObjectStreams: false })), PASS,
        '100,000 small objects, plain — nothing dangerous, only slow enough to cancel or time out');
}

// ---- Adversarial shapes found in pdf-lib's load code ---------------------------------------------
{
    // L14: /Type is a reference to a name object parsed earlier, which
    // dict.lookup resolves — no literal "/Type /ObjStm" anywhere.
    const os = objectStream([[11, '<< /M6IndirectType true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 8, raw: '/ObjStm' }, { num: 10, dict: os.dict.replace('/Type /ObjStm', '/Type 8 0 R'), data: os.data }],
    });
    save('lb-l14-indirect-type', bytes, REFUSE('INDIRECT_TYPE_ON_STREAM', 'walk'),
        'an object stream whose /Type is a reference to a name object defined earlier',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}
{
    // L15: the name written with a hex escape, which PDFName decodes.
    const os = objectStream([[11, '<< /M6EscapedName true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 10, dict: os.dict.replace('/Type /ObjStm', '/Type /Obj#53tm'), data: os.data }],
    });
    save('lb-l15-escaped-name', bytes, REFUSE('DECODED_BYTES_PER_STREAM', 'decode'),
        'an object stream whose /Type is written /Obj#53tm',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}
{
    // L16: the name object that a later /Type points at lives inside a small,
    // clean object stream, so no raw byte of the file spells it.
    const small = objectStream([[8, '/ObjStm']]);
    const bomb = objectStream([[11, '<< /M6HiddenType true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 9, dict: small.dict, data: small.data },
            { num: 10, dict: bomb.dict.replace('/Type /ObjStm', '/Type 8 0 R'), data: bomb.data }],
    });
    // Refused at the walk: the later stream's /Type is indirect, and the walk
    // runs before attribution and before any decode. The decoded-content scan
    // would also have caught the name, but it never runs here; L16b exercises
    // that scan on its own.
    save('lb-l16-type-inside-objstm', bytes, REFUSE('INDIRECT_TYPE_ON_STREAM', 'walk'),
        'a clean object stream holding the name /ObjStm, and a later stream whose /Type points at it',
        { baselineRisk: 'decode', decodedBytes: bomb.decodedLength });
}
{
    // L16b: the same name inside an object stream, with nothing pointing at it.
    // No raw byte spells it and no /Type refers to it, so the walk and the
    // attribution stage both let it through; only the decoded-content scan
    // refuses it — conservative, on purpose.
    const small = objectStream([[8, '/ObjStm']]);
    const { bytes } = assemble({ objects: [...skeleton(), { num: 9, dict: small.dict, data: small.data }] });
    if (bytes.includes(bin('/ObjStm'), bytes.indexOf(bin('stream\n')) + 7)) throw new Error('L16b: the name must not appear in the raw stream data');
    save('lb-l16b-name-inside-objstm', bytes, REFUSE('DECODE_TYPE_NAME_IN_DECODED_CONTENT', 'decoded-content'),
        'a small object stream whose decoded bytes hold the name /ObjStm, referenced by nothing',
        { rawDecodeTypeNames: 1 });
}
{
    // L17: forty offsets that all point at one 100 KB array, which pdf-lib
    // parses forty times over.
    const array = `[${'0 '.repeat(50000)}]`;
    let head = '';
    for (let i = 0; i < 40; i += 1) head += `${100 + i} 0 `;
    const decoded = bin(head + array);
    const data = zlib.deflateSync(decoded, { level: 9 });
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 10, dict: `/Type /ObjStm /N 40 /First ${head.length} /Filter /FlateDecode`, data }],
    });
    save('lb-l17-overlapping-offsets', bytes, REFUSE('OVERLAPPING_OBJECT_STREAM_OFFSETS', 'decoded-content'),
        `forty object-stream offsets pointing at one ${array.length} B array — ${decoded.length} B decoded, parsed forty times`,
        { baselineRisk: 'reparse', decodedBytes: decoded.length, reparsedBytes: 40 * array.length });
}
{
    // L18: the trailer names an encryption dictionary, and an object stream
    // decodes before pdf-lib ever looks at it.
    const os = objectStream([[11, '<< /M6Encrypted true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 7, raw: '<< /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>' }, { num: 10, dict: os.dict, data: os.data }],
        trailer: '/Encrypt 7 0 R',
    });
    save('lb-l18-encrypted-objstm', bytes, REFUSE('ENCRYPTED', 'raw-name-scan'),
        'an encrypted trailer, and an object stream pdf-lib decodes before its encryption check',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}
{
    // L19: a harmless document whose metadata string happens to spell the name.
    // A byte-level superset refuses it: a false positive, kept on purpose.
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 6, raw: '<< /Title (Notes on /ObjStm and /XRef) >>' }],
        trailer: '/Info 6 0 R',
    });
    save('lb-l19-name-in-string', bytes, REFUSE('UNATTRIBUTED_DECODE_TYPE_NAME', 'attribution'),
        'a clean document whose /Title string contains the text /ObjStm — a deliberate false positive');
}
{
    // L20: junk between objects, which pdf-lib skips until it finds the next
    // object header — here, an object stream that decodes to 32 MiB.
    const os = objectStream([[11, '<< /M6AfterJunk true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 10, dict: os.dict, data: os.data, before: '@@ this line is not PDF syntax @@\n' }],
    });
    save('lb-l20-junk-then-objstm', bytes, REFUSE('UNEXPECTED_BYTES', 'walk'),
        'unparseable bytes between objects, then an object stream pdf-lib reaches by skipping them',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}

// ---- Parser ambiguities: refused rather than resolved -------------------------------------------
{
    // L21: /Filter written with a lowercase hex escape. pdf-lib decodes only
    // uppercase #xx, so to it the stream has no filter and its stored zlib bytes
    // — larger than what they inflate to — are the object stream. A case-blind
    // reader would see FlateDecode and count the smaller inflated length.
    const decoded = bin('11 0 << /M6LowercaseEscape true >> ');
    const stored = zlib.deflateSync(decoded, { level: 0 });
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 10, dict: `/Type /ObjStm /N 1 /First 5 /Fi#6cter /FlateDecode`, data: stored }],
    });
    save('lb-l21-lowercase-escape-filter', bytes, REFUSE('AMBIGUOUS_NAME_ESCAPE', 'walk'),
        `an object stream whose /Filter key is written /Fi#6cter — no filter to pdf-lib, which takes ${stored.length} raw bytes where a case-blind decode counts ${decoded.length}`);
}
{
    // L22: a document cut off inside an object stream's data.
    const os = objectStream([[11, '<< /M6Truncated true >>']], MIB);
    const { bytes } = assemble({ objects: [...skeleton(), { num: 10, dict: os.dict, data: os.data }] });
    const cut = bytes.indexOf(bin('stream\n'), bytes.indexOf(bin('/ObjStm'))) + 7 + Math.floor(os.data.length / 2);
    save('lb-l22-truncated-in-stream', bytes.subarray(0, cut), REFUSE('MALFORMED_SYNTAX', 'walk'),
        'a document that ends halfway through an object stream, with no endstream to find');
}
{
    // L23: arrays nested deeper than the boundary's own recursion limit.
    const depth = TEST_LIMITS.maxNestingDepth + 16;
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 6, raw: `<< /M6Deep ${'['.repeat(depth)}0${']'.repeat(depth)} >>` }],
    });
    save('lb-l23-deep-nesting', bytes, REFUSE('NESTING_DEPTH', 'walk'),
        `an unreferenced object with arrays nested ${depth} deep — past the boundary's own depth limit of ${TEST_LIMITS.maxNestingDepth}`);
}
{
    // L24: /Type given twice on a stream; pdf-lib keeps the last.
    const os = objectStream([[11, '<< /M6DuplicateType true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 10, dict: os.dict.replace('/Type /ObjStm', '/Type /M6Other /Type /ObjStm'), data: os.data }],
    });
    save('lb-l24-duplicate-type', bytes, REFUSE('DUPLICATE_KEY_ON_DECODE_STREAM', 'walk'),
        'an object stream that declares /Type twice, the second time as /ObjStm',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}
{
    // L25: /N as an indirect reference, which pdf-lib resolves after decoding.
    const os = objectStream([[11, '<< /M6IndirectN true >>']], BOMB);
    const { bytes } = assemble({
        objects: [...skeleton(), { num: 8, raw: '1' }, { num: 10, dict: os.dict.replace('/N 1', '/N 8 0 R'), data: os.data }],
    });
    save('lb-l25-indirect-declared-n', bytes, REFUSE('AMBIGUOUS_DECLARED_VALUE', 'declared-values'),
        'an object stream whose /N is an indirect reference — refused before the decode it would follow',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}
{
    // L26: an object with no endobj, which pdf-lib tolerates, then an object
    // stream that decodes to 32 MiB.
    const os = objectStream([[11, '<< /M6NoEndobj true >>']], BOMB);
    const { bytes } = assemble({ objects: [...skeleton(), { num: 10, dict: os.dict, data: os.data }] });
    const noEndobj = Buffer.from(bytes.toString('latin1').replace('/Count 1 >>\nendobj\n', '/Count 1 >>\n'), 'latin1');
    if (noEndobj.length !== bytes.length - 'endobj\n'.length) throw new Error('L26: endobj was not removed');
    save('lb-l26-missing-endobj', noEndobj, REFUSE('MALFORMED_SYNTAX', 'walk'),
        'a page-tree object with no endobj, which pdf-lib skips past, followed by a 32 MiB object stream',
        { baselineRisk: 'decode', decodedBytes: os.decodedLength });
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify({ testLimits: TEST_LIMITS, fixtureCount: written.length, fixtures: written }, null, 2)}\n`);
for (const f of written) {
    console.log(`  ${f.expect.padEnd(6)} ${(f.code ?? '').padEnd(36)} ${(f.stage ?? '').padEnd(15)} ${f.name.padEnd(34)} ${String(f.bytes).padStart(9)} B`);
}
console.log(`\n${written.length} load-boundary fixtures in ${path.relative(ROOT, OUT)}`);
