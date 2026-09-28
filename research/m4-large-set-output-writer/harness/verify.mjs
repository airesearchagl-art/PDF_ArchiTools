/**
 * Independent reopen of a written Comparison PDF.
 *
 * Two parsers that share no code with any writer here: pdf-lib (structure,
 * xref, MediaBox) and pdf.js (page count, text, and the decoded image pixels a
 * viewer would show). Pixels are compared with the stage-1 composite: exact
 * equality for lossless candidates, and state-class metrics for lossy ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

function objsGet(objs, name) {
    return new Promise((resolve) => objs.get(name, resolve));
}

function toRgb(img) {
    const { width, height, kind, data } = img;
    if (kind === 2) return data; // RGB_24BPP
    if (kind === 3) { // RGBA_32BPP
        const out = new Uint8Array(width * height * 3);
        for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
            out[q] = data[p]; out[q + 1] = data[p + 1]; out[q + 2] = data[p + 2];
        }
        return out;
    }
    throw new Error(`unsupported pdf.js image kind ${kind}`);
}

/** Colour classes of a palette: equal colours are one class. */
function classes(palette) {
    const keys = [];
    const cls = palette.map(([r, g, b]) => {
        const k = `${r},${g},${b}`;
        let i = keys.indexOf(k);
        if (i < 0) { keys.push(k); i = keys.length - 1; }
        return i;
    });
    const colours = keys.map((k) => k.split(',').map(Number));
    // A class is a "change" class when any state mapping to it has an unmatched layer.
    const change = colours.map((_, c) => palette.some((_, s) => cls[s] === c && (Math.floor(s / 3) === 2 || s % 3 === 2)));
    return { cls, colours, change };
}

function nearest(colours, r, g, b) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < colours.length; i += 1) {
        const c = colours[i];
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < bd) { bd = d; best = i; }
    }
    return best;
}

export async function verifyPdf(file, expected) {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const report = { file: path.basename(file), fileBytes: bytes.length, pages: [], errors: [] };

    const lib = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    report.pdfLibPageCount = lib.getPageCount();
    const libSizes = lib.getPages().map((p) => [p.getWidth(), p.getHeight()]);

    const warnings = [];
    const doc = await pdfjs.getDocument({
        data: bytes, isOffscreenCanvasSupported: false, verbosity: 1,
        stopAtErrors: true,
    }).promise;
    report.pdfjsPageCount = doc.numPages;
    if (doc.numPages !== expected.pages.length) report.errors.push(`page count ${doc.numPages} != ${expected.pages.length}`);

    for (let n = 1; n <= doc.numPages; n += 1) {
        const exp = expected.pages[n - 1];
        const page = await doc.getPage(n);
        const [, , vw, vh] = page.view;
        const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
        const ops = await page.getOperatorList();
        const imgNames = [];
        ops.fnArray.forEach((fn, i) => {
            if (fn === pdfjs.OPS.paintImageXObject) imgNames.push(ops.argsArray[i][0]);
        });
        const pr = {
            page: n, widthPt: +vw.toFixed(2), heightPt: +vh.toFixed(2),
            pdfLibWidthPt: +libSizes[n - 1][0].toFixed(2), pdfLibHeightPt: +libSizes[n - 1][1].toFixed(2),
            orientation: vw > vh ? 'landscape' : 'portrait', images: imgNames.length, text,
        };
        if (Math.abs(vw - exp.widthPt) > 0.01 || Math.abs(vh - exp.heightPt) > 0.01) {
            report.errors.push(`p${n} size ${vw}x${vh} != ${exp.widthPt}x${exp.heightPt}`);
        }
        if (!text.includes(`p${exp.page}:`) || !text.includes(exp.verdict)) {
            report.errors.push(`p${n} title "${text}" lacks p${exp.page} / ${exp.verdict}`);
        }
        if (imgNames.length !== 1) report.errors.push(`p${n} has ${imgNames.length} images`);
        const img = await objsGet(page.objs, imgNames[0]);
        pr.imageWidth = img.width;
        pr.imageHeight = img.height;
        const rgb = toRgb(img);
        const comp = new Uint8Array(fs.readFileSync(exp.compositeFile));
        const mode = expected.mode;
        if (mode === 'lossless') {
            if (img.width !== exp.width || img.height !== exp.height) {
                report.errors.push(`p${n} image ${img.width}x${img.height} != ${exp.width}x${exp.height}`);
            } else {
                let diff = 0;
                let ink = 0;
                for (let p = 0, q = 0; q < rgb.length; p += 4, q += 3) {
                    if (comp[p] !== rgb[q] || comp[p + 1] !== rgb[q + 1] || comp[p + 2] !== rgb[q + 2]) diff += 1;
                    if (rgb[q] !== 255 || rgb[q + 1] !== 255 || rgb[q + 2] !== 255) ink += 1;
                }
                pr.pixelMismatches = diff;
                pr.nonWhitePixels = ink;
                if (diff) report.errors.push(`p${n} ${diff} pixels differ from the composite`);
                if (!ink && exp.inkPixels) report.errors.push(`p${n} decoded blank`);
            }
        } else {
            // Lossy or reduced: classify each composite pixel and its decoded
            // counterpart (nearest-neighbour when the image is smaller).
            const { cls, colours, change } = classes(expected.palette);
            const toClass = new Map(expected.palette.map(([r, g, b], s) => [(r << 16) | (g << 8) | b, cls[s]]));
            const sx = img.width / exp.width;
            const sy = img.height / exp.height;
            let wrong = 0;
            let changeOrig = 0;
            let changeKept = 0;
            let falseChange = 0;
            for (let y = 0; y < exp.height; y += 1) {
                const yy = Math.min(img.height - 1, Math.floor(y * sy));
                for (let x = 0; x < exp.width; x += 1) {
                    const p = (y * exp.width + x) * 4;
                    const oc = toClass.get((comp[p] << 16) | (comp[p + 1] << 8) | comp[p + 2]);
                    const xx = Math.min(img.width - 1, Math.floor(x * sx));
                    const q = (yy * img.width + xx) * 3;
                    const dc = nearest(colours, rgb[q], rgb[q + 1], rgb[q + 2]);
                    if (dc !== oc) wrong += 1;
                    if (change[oc]) {
                        changeOrig += 1;
                        if (dc === oc) changeKept += 1;
                    } else if (change[dc]) {
                        falseChange += 1;
                    }
                }
            }
            pr.classMismatchPixels = wrong;
            pr.classMismatchRatio = wrong / (exp.width * exp.height);
            pr.changePixels = changeOrig;
            pr.changeRecall = changeOrig ? changeKept / changeOrig : null;
            pr.falseChangePixels = falseChange;
        }
        report.pages.push(pr);
        page.cleanup();
    }
    await doc.destroy();
    report.warnings = warnings;
    report.ok = report.errors.length === 0;
    return report;
}
