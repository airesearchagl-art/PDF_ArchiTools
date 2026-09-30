/**
 * The verifier must catch what it claims to catch. Each probe takes a known-
 * good lossless output (f10-structure / ll-chunked) and breaks exactly one
 * property with pdf-lib; `compare()` must report it. A verifier that passes a
 * broken file proves nothing about the ones it passes.
 *
 * Run: node harness/verify-selftest.mjs -> prints one JSON line
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFString } from 'pdf-lib';
import { compare } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(REPO, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs')).href;

const src = new Uint8Array(fs.readFileSync(path.join(ROOT, 'out', 'corpus', 'f10-structure.pdf')));
const good = new Uint8Array(fs.readFileSync(path.join(ROOT, 'out', 'results', 'f10-structure', 'll-chunked.pdf')));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'corpus', 'manifest.json'), 'utf8'))['f10-structure'];

async function mutate(fn) {
    const doc = await PDFDocument.load(good, { updateMetadata: false });
    await fn(doc);
    return doc.save({ useObjectStreams: false });
}
const firstImage = (doc) => {
    for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
        if (o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') return [ref, o];
    }
    return null;
};

const probes = {
    'one image sample changed': async (doc) => {
        // Replace the image with raw RGB of the same size, one sample flipped.
        const [ref, o] = firstImage(doc);
        const w = o.dict.get(PDFName.of('Width')).asNumber();
        const h = o.dict.get(PDFName.of('Height')).asNumber();
        const s = await import('node:zlib');
        const d = o.dict.clone(doc.context);
        const probeDoc = await PDFDocument.load(src, { updateMetadata: false });
        const [, orig] = firstImage(probeDoc);
        const raw = Buffer.from(orig.contents);
        raw[(Math.floor(h / 2) * w + Math.floor(w / 2)) * 3] ^= 0x40;
        ['Filter', 'DecodeParms'].forEach((k) => d.delete(PDFName.of(k)));
        d.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
        d.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
        d.set(PDFName.of('Length'), PDFNumber.of(raw.length));
        doc.context.assign(ref, PDFRawStream.of(d, new Uint8Array(raw)));
        void s;
    },
    'an annotation removed': (doc) => {
        const page = doc.getPages()[0];
        const annots = page.node.get(PDFName.of('Annots'));
        const arr = doc.context.lookup(annots);
        const kept = doc.context.obj(arr.asArray().slice(1));
        page.node.set(PDFName.of('Annots'), kept);
    },
    'a link target changed': (doc) => {
        const page = doc.getPages()[0];
        const arr = doc.context.lookup(page.node.get(PDFName.of('Annots')));
        for (const r of arr.asArray()) {
            const a = doc.context.lookup(r);
            const act = a.get(PDFName.of('A'));
            if (act) doc.context.lookup(act) ? doc.context.lookup(act).set(PDFName.of('URI'), PDFString.of('https://example.invalid/other')) : a.lookup(PDFName.of('A')).set(PDFName.of('URI'), PDFString.of('https://example.invalid/other'));
        }
    },
    'a form value changed': (doc) => { doc.getForm().getTextField('drawing.number').setText('A-102'); },
    'the title changed': (doc) => { doc.setTitle('Something else'); },
    'a text string changed': (doc) => {
        const page = doc.getPages()[0];
        const contents = page.node.get(PDFName.of('Contents'));
        const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
        for (const r of refs) {
            const s = doc.context.lookup(r);
            const text = Buffer.from(s.getContents ? s.getContents() : s.contents).toString('latin1');
            if (text.includes('Native text survives')) {
                const next = Buffer.from(text.replace('Native text survives', 'Native text changed!'), 'latin1');
                const d = s.dict.clone(doc.context);
                d.delete(PDFName.of('Filter'));
                d.set(PDFName.of('Length'), PDFNumber.of(next.length));
                doc.context.assign(r, PDFRawStream.of(d, new Uint8Array(next)));
            }
        }
    },
    'the page rotated': (doc) => { doc.getPages()[0].setRotation({ type: 'degrees', angle: 90 }); },
    'the CropBox moved': (doc) => { doc.getPages()[0].setCropBox(10, 10, 500, 700); },
    'a vector path added': (doc) => { doc.getPages()[0].drawLine({ start: { x: 10, y: 10 }, end: { x: 100, y: 10 }, thickness: 1 }); },
};

const results = {};
const baseline = await compare(src, good, { mode: 'lossless', manifest });
results['the unbroken output passes'] = baseline.ok;
for (const [name, fn] of Object.entries(probes)) {
    let caught;
    try {
        const broken = await mutate(fn);
        const r = await compare(src, broken, { mode: 'lossless', manifest });
        const srcFields = (await compare(src, src, { mode: 'lossless' })).fields;
        caught = !r.ok || JSON.stringify(r.fields) !== JSON.stringify(srcFields);
        results[name] = { caught, by: r.errors[0] ?? (caught ? 'form fields' : null) };
    } catch (e) {
        results[name] = { caught: false, by: `probe failed: ${e.message}` };
    }
}
const ok = results['the unbroken output passes'] && Object.entries(results).filter(([k]) => k !== 'the unbroken output passes').every(([, v]) => v.caught);
console.log(JSON.stringify({ ok, results }));
