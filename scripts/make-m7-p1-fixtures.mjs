/**
 * Synthetic documents for the M7-P1 Drawing Set gates.
 *
 * Nothing here is a customer or project file and nothing is downloaded. Every
 * document is built through pdf-lib or byte by byte, deterministically, so two
 * runs write the same bytes. The manifest records each file's SHA-256 (from
 * node:crypto, an implementation independent of the app's) and the page facts
 * the generator itself put there, so the gates compare the app against what
 * was built rather than against what the app read last time.
 *
 * The set:
 *   A  p1-native-a          4 pages with native text: A4 portrait, A3 landscape,
 *                           A4 with /Rotate 90, and a CropBox inside a larger
 *                           MediaBox with /Rotate 180
 *   B  p1-image-only-b      2 pages, no text: an embedded raster, and vector lines
 *   C  p1-second-c          3 pages A2 landscape with text
 *   D  p1-native-a-copy     the bytes of A under another name (duplicate content)
 *   and the boundary cases: empty, not a PDF, password-protected, a page at the
 *   page-size bound and one past it (alone, and as page 2 after a good page 1),
 *   a UserUnit page, 5000 and 5001 pages.
 *
 * The M7-P2-A documents (scripts/make-m7-p2a-fixtures.mjs) are built at the
 * end, into test-fixtures/m7-p2a, so the one step that prepares the M7 gates
 * prepares both.
 *
 * Run:  node scripts/make-m7-p1-fixtures.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { degrees, PDFDocument, PDFName, PDFNumber, rgb, StandardFonts } from 'pdf-lib';
import { generateP2aFixtures } from './make-m7-p2a-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm7-p1');

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const A4 = [595.28, 841.89];
const A3 = [841.89, 1190.55];
const A2 = [1190.55, 1683.78];

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const written = [];
const write = (name, bytes, facts = null) => {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push({ name, file: `${name}.pdf`, bytes: bytes.length, sha256: sha256(bytes), ...(facts ? { facts } : {}) });
};

async function newDoc(title) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setCreator('PDF ArchiTools synthetic fixture');
    doc.setProducer('pdf-lib');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    return doc;
}

const save = (doc) => doc.save({ useObjectStreams: false });

/** A deterministic RGB gradient with a grid, as a PNG. */
function syntheticPng(width, height) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x++) {
            const grid = x % 32 === 0 || y % 32 === 0;
            const i = row + 1 + x * 3;
            raw[i] = grid ? 30 : (x * 255) / width;
            raw[i + 1] = grid ? 30 : (y * 255) / height;
            raw[i + 2] = grid ? 30 : 160;
        }
    }
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(body) >>> 0);
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function nativeA() {
    const doc = await newDoc('M7 P1 fixture A');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const label = (page, text) => page.drawText(text, { x: 60, y: page.getHeight() - 90, size: 28, font, color: rgb(0, 0, 0) });

    label(doc.addPage(A4), 'FIXTURE A PAGE 1 A4 PORTRAIT');
    label(doc.addPage([A3[1], A3[0]]), 'FIXTURE A PAGE 2 A3 LANDSCAPE');
    const turned = doc.addPage(A4);
    label(turned, 'FIXTURE A PAGE 3 ROTATE 90');
    turned.setRotation(degrees(90));
    const cropped = doc.addPage([1000, 800]);
    cropped.setCropBox(100, 100, 500, 400);
    cropped.drawText('FIXTURE A PAGE 4 CROPBOX', { x: 140, y: 440, size: 24, font });
    cropped.setRotation(degrees(180));
    return {
        bytes: await save(doc),
        facts: [
            { uprightWidthPt: A4[0], uprightHeightPt: A4[1], rotate: 0, kind: 'text-native' },
            { uprightWidthPt: A3[1], uprightHeightPt: A3[0], rotate: 0, kind: 'text-native' },
            { uprightWidthPt: A4[0], uprightHeightPt: A4[1], rotate: 90, kind: 'text-native' },
            { uprightWidthPt: 500, uprightHeightPt: 400, rotate: 180, kind: 'text-native' },
        ],
    };
}

async function imageOnlyB() {
    const doc = await newDoc('M7 P1 fixture B');
    const png = await doc.embedPng(syntheticPng(320, 452));
    const scan = doc.addPage(A4);
    scan.drawImage(png, { x: 0, y: 0, width: A4[0], height: A4[1] });
    const lines = doc.addPage([A3[1], A3[0]]);
    for (let i = 0; i < 12; i++) {
        lines.drawLine({ start: { x: 40, y: 40 + i * 60 }, end: { x: 1150, y: 40 + i * 60 }, thickness: 2 });
    }
    lines.drawRectangle({ x: 900, y: 40, width: 250, height: 120, borderWidth: 2, borderColor: rgb(0, 0, 0) });
    return {
        bytes: await save(doc),
        facts: [
            { uprightWidthPt: A4[0], uprightHeightPt: A4[1], rotate: 0, kind: 'scanned' },
            { uprightWidthPt: A3[1], uprightHeightPt: A3[0], rotate: 0, kind: 'scanned' },
        ],
    };
}

async function secondC() {
    const doc = await newDoc('M7 P1 fixture C');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const facts = [];
    for (let i = 1; i <= 3; i++) {
        const page = doc.addPage([A2[1], A2[0]]);
        page.drawText(`FIXTURE C SHEET ${i} A2 LANDSCAPE`, { x: 80, y: A2[0] - 120, size: 40, font });
        facts.push({ uprightWidthPt: A2[1], uprightHeightPt: A2[0], rotate: 0, kind: 'text-native' });
    }
    return { bytes: await save(doc), facts };
}

async function pages(count, withText) {
    const doc = await newDoc(`M7 P1 fixture ${count} pages`);
    const font = withText ? await doc.embedFont(StandardFonts.Helvetica) : null;
    for (let i = 1; i <= count; i++) {
        const page = doc.addPage([200, 140]);
        if (font) page.drawText(`S-${i}`, { x: 20, y: 100, size: 18, font });
    }
    return save(doc);
}

async function singlePage(width, height, extra) {
    const doc = await newDoc(`M7 P1 fixture page ${width}x${height}`);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([width, height]);
    page.drawText('BOUNDARY', { x: 10, y: Math.max(10, height - 40), size: 20, font });
    extra?.(page);
    return save(doc);
}

/**
 * A PDF whose user password is not empty (Standard Security Handler, R2, RC4
 * 40-bit), so a reader has to ask for one. Only the encryption dictionary has
 * to be right for that; the content is never reached.
 */
function passwordProtected() {
    const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
    const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
    const rc4 = (key, data) => {
        const s = Array.from({ length: 256 }, (_, i) => i);
        for (let i = 0, j = 0; i < 256; i++) {
            j = (j + s[i] + key[i % key.length]) & 255;
            [s[i], s[j]] = [s[j], s[i]];
        }
        const out = Buffer.alloc(data.length);
        for (let n = 0, i = 0, j = 0; n < data.length; n++) {
            i = (i + 1) & 255;
            j = (j + s[i]) & 255;
            [s[i], s[j]] = [s[j], s[i]];
            out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
        }
        return out;
    };
    const pad = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);
    const id = Buffer.from('6d372d70312d70617373776f72642d31', 'hex');
    const permissions = -44;
    const p = Buffer.alloc(4);
    p.writeInt32LE(permissions);
    const owner = rc4(md5(pad('owner-secret')).subarray(0, 5), pad('user-secret'));
    const key = md5(pad('user-secret'), owner, p, id).subarray(0, 5);
    const user = rc4(key, PAD);

    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
        `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P ${permissions} >>`,
    ];
    let body = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((object, index) => {
        offsets.push(body.length);
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\n`;
    body += `startxref\n${xref}\n%%EOF\n`;
    return latin1(body);
}

/** Bytes that are not a PDF, whatever the extension says. */
function notAPdf() {
    const text = 'This is a synthetic file that is not a PDF.\n';
    const bytes = new Uint8Array(4096);
    let x = 0x2545f491;
    for (let i = 0; i < bytes.length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        bytes[i] = i < text.length ? text.charCodeAt(i) : x & 0xff;
    }
    return bytes;
}

async function main() {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });

    const a = await nativeA();
    write('p1-native-a', a.bytes, a.facts);
    const b = await imageOnlyB();
    write('p1-image-only-b', b.bytes, b.facts);
    const c = await secondC();
    write('p1-second-c', c.bytes, c.facts);
    write('p1-native-a-copy', a.bytes, a.facts);

    write('p1-empty', new Uint8Array(0));
    write('p1-not-a-pdf', notAPdf());
    write('p1-password', passwordProtected());
    write('p1-page-at-bound', await singlePage(14400, 14400), [
        { uprightWidthPt: 14400, uprightHeightPt: 14400, rotate: 0, kind: 'text-native' },
    ]);
    write('p1-page-past-bound', await singlePage(14401, 200));
    write('p1-mixed-past-bound', await (async () => {
        // Page 1 is fine, page 2 is past the bound: the first page's facts are
        // read before the refusal, and must not survive it.
        const doc = await newDoc('M7 P1 fixture mixed');
        const font = await doc.embedFont(StandardFonts.Helvetica);
        doc.addPage(A4).drawText('MIXED PAGE 1', { x: 60, y: 760, size: 24, font });
        doc.addPage([14401, 200]).drawText('MIXED PAGE 2', { x: 60, y: 100, size: 24, font });
        return save(doc);
    })());
    write('p1-user-unit', await singlePage(595, 842, (page) => page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))));
    write('p1-5000-pages', await pages(5000, true));
    write('p1-5001-pages', await pages(5001, false));

    const manifest = {
        generatedBy: 'scripts/make-m7-p1-fixtures.mjs',
        note: 'Synthetic only. No customer or project document, no network, no secret. SHA-256 from node:crypto.',
        count: written.length,
        files: written,
    };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`m7-p1 fixtures: ${written.length} documents in ${path.relative(ROOT, OUT)}`);
    for (const f of written) console.log(`  ${f.name.padEnd(22)} ${String(f.bytes).padStart(9)} B  ${f.sha256.slice(0, 12)}`);

    await generateP2aFixtures();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
