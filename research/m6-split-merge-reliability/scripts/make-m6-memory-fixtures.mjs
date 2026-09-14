/**
 * Synthetic documents for the M6 Object-Graph Memory Sub-Spike (B2).
 *
 * The question these exist for is narrow: can what a Split or Merge keeps in
 * memory be bounded *before* the work starts, and from what? A corpus that only
 * varies file size cannot answer that, because file size is one of the things
 * under suspicion. So the shapes here are chosen in pairs that hold one
 * candidate term steady while another moves:
 *
 *   B1 / C     about the same file size; thousands of objects against a handful
 *   B1 / B2    the same object graph; plain against packed into object streams
 *   G1 / G2    the same image dimensions; incompressible against flate-packed
 *   I1 / I2    one selected page each; a page that reaches every other page
 *              through links against a page that reaches nothing
 *   D          fifty pages sharing one large stream and one resource dictionary
 *   E          a two-hundred-deep chain of forms that closes into a cycle
 *   F          a thousand plain pages
 *
 * Every byte is generated here, deterministically — no customer document, no
 * network, no clock. Pseudo-random payloads come from a fixed-seed xorshift so a
 * regenerated corpus is the same corpus.
 *
 * Output goes to `test-fixtures/m6-object-graph-memory/`, which is ignored, and
 * is kept apart from the main M6 corpus so that nothing here moves the evidence
 * the other two gates record.
 *
 * Run:  node research/m6-split-merge-reliability/scripts/make-m6-memory-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument, PDFName, StandardFonts, rgb,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-object-graph-memory');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const A4 = { w: 595.28, h: 841.89 };
const written = [];

/** Deterministic bytes that deflate cannot shrink much. */
function noise(length, seed) {
    const out = new Uint8Array(length);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < length; i += 1) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        out[i] = x & 0xff;
    }
    return out;
}

async function write(name, doc, shape, note, { useObjectStreams = false } = {}) {
    const bytes = await doc.save({ useObjectStreams, addDefaultPage: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes);
    written.push({ name, bytes: bytes.length, shape, note, useObjectStreams });
}

const newDoc = () => PDFDocument.create({ updateMetadata: false });

/** A gray image XObject of `w` x `h` samples, registered, uncompressed unless `flate`. */
function grayImage(doc, w, h, samples, flate = false) {
    const dict = {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    };
    const contents = flate ? zlib.deflateSync(samples) : samples;
    if (flate) dict.Filter = 'FlateDecode';
    return doc.context.register(doc.context.stream(contents, dict));
}

/** Draw a registered XObject across the page under a fixed resource name. */
function paint(page, name, ref, size = A4) {
    page.node.setXObject(PDFName.of(name), ref);
    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(size.w, 0, 0, size.h, 0, 0),
        drawObject(name),
        popGraphicsState(),
    );
}

async function vectorPage(doc, font, marker) {
    const page = doc.addPage([A4.w, A4.h]);
    page.drawRectangle({ x: 30, y: 30, width: A4.w - 60, height: A4.h - 60, borderColor: rgb(0, 0, 0), borderWidth: 2 });
    page.drawLine({ start: { x: 60, y: 400 }, end: { x: A4.w - 60, y: 400 }, thickness: 4, color: rgb(0.8, 0.1, 0.1) });
    page.drawText(marker, { x: 60, y: 90, size: 14, font, color: rgb(0, 0, 0) });
    return page;
}

// ---- A: a small text-and-vector page ---------------------------------------
{
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    await vectorPage(doc, font, 'M6-MEM-A-1');
    await write('mem-a-small-vector', doc, 'A', 'one page of text and vector, a few objects');
}

// ---- B1 / B2: many small indirect objects, plain and packed -----------------
const LEAVES = 20000;
for (const [name, packed] of [['mem-b1-many-objects', false], ['mem-b2-many-objects-objstm', true]]) {
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = await vectorPage(doc, font, `M6-MEM-${packed ? 'B2' : 'B1'}-1`);
    const refs = [];
    for (let i = 0; i < LEAVES; i += 1) {
        refs.push(doc.context.register(doc.context.obj({ Type: 'M6Leaf', I: i, Tag: `leaf-${i}` })));
    }
    // A private page key: copyPages follows every entry of the page dictionary,
    // so these are reachable from the page without meaning anything to a viewer.
    page.node.set(PDFName.of('M6Payload'), doc.context.obj(refs));
    await write(name, doc, packed ? 'B2' : 'B1',
        `${LEAVES} small indirect dictionaries reachable from one page, ${packed ? 'packed into object streams' : 'written plainly'}`,
        { useObjectStreams: packed });
}

// ---- C: a few large streams at about B1's size -------------------------------
{
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = await vectorPage(doc, font, 'M6-MEM-C-1');
    // Three incompressible 600 x 700 images: 1.26 MB of samples, stored raw.
    for (let i = 0; i < 3; i += 1) {
        paint(page, `M6Img${i}`, grayImage(doc, 600, 700, noise(600 * 700, 0xc0ffee + i)));
    }
    await write('mem-c-few-large-streams', doc, 'C', 'three incompressible image streams, about the file size of B1');
}

// ---- D: many pages sharing one large stream and one resource dictionary -----
{
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const shared = grayImage(doc, 800, 500, noise(800 * 500, 0xd00d));
    for (let i = 1; i <= 50; i += 1) {
        const page = await vectorPage(doc, font, `M6-MEM-D-${i}`);
        paint(page, 'M6Shared', shared);
    }
    await write('mem-d-shared-refs', doc, 'D', 'fifty pages, each drawing the same 400 KB image and the same font');
}

// ---- E: a deep chain of forms that closes into a cycle -----------------------
{
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = await vectorPage(doc, font, 'M6-MEM-E-1');
    const first = doc.context.stream('q Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] });
    const firstRef = doc.context.register(first);
    let next = firstRef;
    for (let i = 0; i < 200; i += 1) {
        next = doc.context.register(doc.context.stream('q /M6N Do Q', {
            Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { XObject: { M6N: next } },
        }));
    }
    // The innermost form reaches back to the outermost: a traversal without a
    // visited set never returns.
    first.dict.set(PDFName.of('Resources'), doc.context.obj({ XObject: { M6Back: next } }));
    paint(page, 'M6Deep', next);
    await write('mem-e-deep-cycle', doc, 'E', 'a chain of 201 form XObjects whose innermost reaches back to the outermost');
}

// ---- F: a large page count ----------------------------------------------------
{
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 1000; i += 1) await vectorPage(doc, font, `M6-MEM-F-${i}`);
    await write('mem-f-1000-pages', doc, 'F', 'one thousand plain pages of text and vector');
}

// ---- G1 / G2: one large image, incompressible and flate-packed ---------------
{
    const w = 3000;
    const h = 3000;
    for (const [name, flate] of [['mem-g1-large-image-raw', false], ['mem-g2-large-image-flate', true]]) {
        const doc = await newDoc();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = await vectorPage(doc, font, `M6-MEM-${flate ? 'G2' : 'G1'}-1`);
        // G1 is noise stored raw; G2 is a flat field that deflate packs to almost
        // nothing. The decoded image is 9 MB either way.
        const samples = flate ? new Uint8Array(w * h).fill(0xd0) : noise(w * h, 0x9e3779b9);
        paint(page, 'M6Big', grayImage(doc, w, h, samples, flate));
        await write(name, doc, flate ? 'G2' : 'G1',
            `one ${w} x ${h} gray image, ${flate ? 'a flat field under FlateDecode' : 'incompressible and stored raw'}`);
    }
}

// ---- I1 / I2: one selected page, a large reachable graph and a small one -----
{
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = [];
    for (let i = 1; i <= 10; i += 1) {
        const page = await vectorPage(doc, font, `M6-MEM-I-${i}`);
        paint(page, 'M6Heavy', grayImage(doc, 700, 700, noise(700 * 700, 0x1000 + i)));
        pages.push(page);
    }
    // Page 1 links to every other page. Extracting page 1 therefore reaches all
    // ten heavy images through /Annots -> /Dest; extracting page 10 reaches one.
    const links = pages.slice(1).map((target, index) => doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [60, 700 - index * 40, 300, 730 - index * 40], Border: [0, 0, 0],
        Dest: [target.ref, 'XYZ', null, null, null],
    })));
    pages[0].node.set(PDFName.of('Annots'), doc.context.obj(links));
    await write('mem-i-linked-heavy-pages', doc, 'I',
        'ten pages with a 490 KB image each; page 1 links to pages 2-10, page 10 links to nothing');
}

// ---- J: many distinct names ---------------------------------------------------
{
    // PDFName.of interns every name in a module-level Map that is never cleared
    // (core/objects/PDFName.js:18, :100-108). Twenty thousand distinct keys are
    // twenty thousand names the process keeps after the document is gone.
    const doc = await newDoc();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = await vectorPage(doc, font, 'M6-MEM-J-1');
    const refs = [];
    for (let i = 0; i < LEAVES; i += 1) {
        refs.push(doc.context.register(doc.context.obj({ Type: 'M6Leaf', [`M6DistinctName${i}`]: i })));
    }
    page.node.set(PDFName.of('M6Payload'), doc.context.obj(refs));
    await write('mem-j-distinct-names', doc, 'J', `${LEAVES} small dictionaries, each keyed by a name no other uses`);
}

// ---- K: an object stream that inflates far past its input ---------------------
{
    // pdf-lib decodes every /ObjStm eagerly at load (core/parser/PDFParser.js:
    // 140-142), into a buffer that doubles with no upper limit
    // (core/streams/DecodeStream.js:133-145). So a few kilobytes of input can be
    // tens of megabytes of decoded bytes before any graph exists to measure.
    // Written by hand, because no writer produces padding like this.
    const PAD = 32 * 1024 * 1024;
    const head = '2 0 ';
    const body = Buffer.concat([
        Buffer.from(`${head}<< /Type /M6Padded >>`, 'latin1'),
        Buffer.alloc(PAD, 0x20),
    ]);
    const packed = zlib.deflateSync(body, { level: 9 });
    const parts = [];
    const offsets = {};
    let length = 0;
    const push = (chunk) => {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
        parts.push(b);
        length += b.length;
    };
    push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    offsets[1] = length;
    push(`1 0 obj\n<< /Type /ObjStm /N 1 /First ${head.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`);
    push(packed);
    push('\nendstream\nendobj\n');
    offsets[3] = length;
    push('3 0 obj\n<< /Type /Catalog /Pages 4 0 R >>\nendobj\n');
    offsets[4] = length;
    push('4 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj\n');
    offsets[5] = length;
    push('5 0 obj\n<< /Type /Page /Parent 4 0 R /MediaBox [0 0 595 842] /M6Padded 2 0 R >>\nendobj\n');
    const xref = length;
    const row = (n) => (offsets[n] === undefined ? '0000000000 65535 f \n' : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    push(`xref\n0 6\n${[0, 1, 2, 3, 4, 5].map(row).join('')}trailer\n<< /Size 6 /Root 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const bytes = Buffer.concat(parts);
    fs.writeFileSync(path.join(OUT, 'mem-k-objstm-inflation.pdf'), bytes);
    written.push({
        name: 'mem-k-objstm-inflation', bytes: bytes.length, shape: 'K', useObjectStreams: true,
        note: `an object stream of ${packed.length} bytes that inflates to ${body.length} bytes at load`,
        decodedObjectStreamBytes: body.length,
    });
}

fs.writeFileSync(path.join(OUT, 'corpus.json'), `${JSON.stringify(written, null, 2)}\n`);
for (const f of written) {
    console.log(`  ${f.shape.padEnd(3)} ${f.name.padEnd(30)} ${String(f.bytes).padStart(10)} B  ${f.note}`);
}
console.log(`\n${written.length} memory fixtures in ${path.relative(ROOT, OUT)}`);
