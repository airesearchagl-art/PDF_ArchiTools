/**
 * Read-only image census of any PDF, run locally. Nothing is uploaded or
 * written.
 *
 * Built so the question "what did Acrobat do to reach ~2 MB?" can be answered
 * on the real (customer) file without that file ever leaving the user's
 * machine or entering this repository. For every Image XObject it prints the
 * pixel size, effective ppi on the page(s) that draw it, colour space, bits,
 * filter chain, predictor, and stream bytes. Downsampling shows up as ppi below
 * the export DPI; lossy recompression as DCTDecode / JPXDecode / JBIG2Decode;
 * lossless as FlateDecode (with or without a predictor).
 *
 * Run: node research/m4-large-set-output-writer/harness/inspect-images.mjs <file.pdf>
 */
import fs from 'node:fs';
import {
    PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, PDFRef, PDFNumber,
} from 'pdf-lib';

const file = process.argv[2];
if (!file) {
    console.error('usage: inspect-images.mjs <file.pdf>');
    process.exit(2);
}
const bytes = fs.readFileSync(file);
const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
const ctx = doc.context;

const show = (v) => {
    if (v === undefined) return '-';
    const r = v instanceof PDFRef ? ctx.lookup(v) : v;
    if (r instanceof PDFArray) return `[${r.asArray().map(show).join(' ')}]`;
    if (r instanceof PDFDict) return `<<${[...r.entries()].map(([k, x]) => `${k}${show(x)}`).join(' ')}>>`;
    if (r instanceof PDFRawStream) return 'stream';
    return String(r);
};

// Page placement: largest ppi per image across the pages that draw it, from
// the page size (full-bleed images, which is what every comparison page is).
const drawnOn = new Map();
doc.getPages().forEach((page, i) => {
    const res = page.node.Resources();
    const xo = res?.lookup(PDFName.of('XObject'));
    if (!(xo instanceof PDFDict)) return;
    for (const [, ref] of xo.entries()) {
        if (!(ref instanceof PDFRef)) continue;
        const list = drawnOn.get(ref.toString()) ?? [];
        list.push({ page: i + 1, w: page.getWidth(), h: page.getHeight() });
        drawnOn.set(ref.toString(), list);
    }
});

let images = 0;
let imageBytes = 0;
const byFilter = {};
for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    images += 1;
    const w = d.lookup(PDFName.of('Width'), PDFNumber).asNumber();
    const h = d.lookup(PDFName.of('Height'), PDFNumber).asNumber();
    const len = obj.contents.length;
    imageBytes += len;
    const filter = show(d.get(PDFName.of('Filter')));
    byFilter[filter] = (byFilter[filter] ?? 0) + len;
    const pages = drawnOn.get(ref.toString()) ?? [];
    const ppi = pages.map((p) => Math.round(Math.max(w / (p.w / 72), h / (p.h / 72))));
    console.log([
        `obj ${ref}`, `${w}x${h}`, `pages ${pages.map((p) => p.page).join(',') || '?'}`,
        `ppi ${ppi.join(',') || '?'}`,
        `cs ${show(d.get(PDFName.of('ColorSpace'))).slice(0, 60)}`,
        `bpc ${show(d.get(PDFName.of('BitsPerComponent')))}`,
        `filter ${filter}`, `parms ${show(d.get(PDFName.of('DecodeParms')))}`,
        `smask ${d.get(PDFName.of('SMask')) ? 'yes' : 'no'}`,
        `${len} bytes (${(len * 8 / (w * h)).toFixed(3)} bits/px)`,
    ].join(' | '));
}
console.log('\n(pages = pages whose Resources reference the image; a writer that shares one Resources dict, as jsPDF does, makes this a superset)');
console.log(`file ${bytes.length} bytes, ${doc.getPageCount()} pages, ${images} images, ${imageBytes} image bytes`);
console.log('image bytes by filter:', byFilter);
