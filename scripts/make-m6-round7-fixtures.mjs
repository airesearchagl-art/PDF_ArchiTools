/**
 * The documents Round 7's two compatibility workstreams are proven against.
 *
 * **R7-1** is an indirect stream `/Length`. pdf-lib's writer always emits a
 * direct one — `PDFStream.updateDict()` rewrites the key on the way out — so
 * these cannot be built with pdf-lib at all and are written by hand. That is
 * also exactly why the defect existed: every fixture the milestone had was
 * pdf-lib's own output, and none of them carried the shape a real producer
 * writes. `copyPages` copies the stream and the number it points at, the sweep
 * correctly calls the number reachable, and `save()` then rewrites `/Length`
 * direct and leaves the number behind with nothing pointing at it.
 *
 * **R7-2** is optional content that a real drawing carries and M6 refused: a
 * group named by a form XObject's `/OC` rather than through the page's
 * `/Properties`, a one-group `/OCMD`, `/D /AS` and an empty `/D /RBGroups`.
 * Each supported shape has a refused neighbour here, because an envelope that
 * is never seen to refuse is not an envelope.
 *
 * Run:  node scripts/make-m6-round7-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
fs.mkdirSync(OUT, { recursive: true });

const written = [];
const N = (s) => PDFName.of(s);

const writeBytes = (name, bytes) => {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};
const save = async (name, doc) => {
    writeBytes(name, await doc.save({ useObjectStreams: false }));
};

const latin1 = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
    return out;
};

// ---------------------------------------------------------------------------
// R7-1 — indirect stream /Length, written by hand
// ---------------------------------------------------------------------------

const CONTENT = '0 0 1 RG 4 w 10 10 100 100 re S\n';

/**
 * A document whose page content streams declare `/Length` as a reference.
 *
 * `direct` writes the ordinary shape instead, `stale` makes the referenced
 * number disagree with the bytes, and `shared` points a second, legitimate key
 * at the same number so the sweep has a reason to keep it.
 */
function indirectLengthDoc({ pages = 1, direct = false, stale = false, shared = false, mixed = false }) {
    const kids = [];
    const parts = [];
    let obj = 4;
    for (let i = 0; i < pages; i += 1) {
        const pageObj = obj;
        const streamObj = obj + 1;
        const lenObj = obj + 2;
        kids.push(`${pageObj} 0 R`);
        // `mixed` alternates: even pages direct, odd pages indirect.
        const useDirect = mixed ? i % 2 === 0 : direct;
        const lengthEntry = useDirect ? `${CONTENT.length}` : `${lenObj} 0 R`;
        parts.push(
            `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> `
            + `/Contents ${streamObj} 0 R${shared ? ` /UserUnit ${lenObj} 0 R` : ''} >>\nendobj\n`,
        );
        parts.push(`${streamObj} 0 obj\n<< /Length ${lengthEntry} >>\nstream\n${CONTENT}endstream\nendobj\n`);
        parts.push(`${lenObj} 0 obj\n${stale ? CONTENT.length + 7 : CONTENT.length}\nendobj\n`);
        obj += 3;
    }
    const body = '%PDF-1.7\n'
        + '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
        + `2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>\nendobj\n`
        + parts.join('')
        + `trailer\n<< /Size ${obj} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`;
    return latin1(body);
}

// ---------------------------------------------------------------------------
// R7-2 — optional content
// ---------------------------------------------------------------------------

/** A page that draws a blue square through a named form XObject. */
const FORM_CONTENT = '0 0 1 rg 20 20 160 160 re f\n';

async function ocDoc(build) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([200, 200]);
    const ocg = (label) => doc.context.register(doc.context.obj({
        Type: 'OCG',
        Name: PDFString.of(label),
    }));
    const form = (dict) => doc.context.register(doc.context.stream(FORM_CONTENT, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 200],
        Resources: {},
        ...dict,
    }));
    const setResources = (resources) => page.node.set(N('Resources'), doc.context.obj(resources));
    const setContents = (text) => page.node.set(
        N('Contents'),
        doc.context.register(doc.context.stream(text)),
    );
    const ocProperties = (value) => doc.catalog.set(N('OCProperties'), doc.context.obj(value));
    return { doc, page, ocg, form, setResources, setContents, ocProperties, ...build };
}

/** The common supported shape: one group, one form that carries it. */
async function formOcDoc({ off = false, nested = false, ocFor = (ref) => ref, extraD = {} }) {
    const f = await ocDoc({});
    const group = f.ocg('Layer 1');
    if (nested) {
        const inner = f.form({ OC: ocFor(group, f) });
        const outer = f.form({ Resources: { XObject: { Fm1: inner } } });
        f.setResources({ XObject: { Fm0: outer } });
        f.setContents('q /Fm0 Do Q\n');
    } else {
        const only = f.form({ OC: ocFor(group, f) });
        f.setResources({ XObject: { Fm0: only } });
        f.setContents('q /Fm0 Do Q\n');
    }
    f.ocProperties({
        OCGs: [group],
        D: { Name: PDFString.of('Default'), BaseState: 'ON', ...(off ? { OFF: [group] } : { ON: [group] }), ...extraD },
    });
    return { ...f, group };
}

const main = async () => {
    // ---- R7-1 -------------------------------------------------------------
    writeBytes('r7-len-indirect', indirectLengthDoc({ pages: 1 }));
    writeBytes('r7-len-indirect-many', indirectLengthDoc({ pages: 5 }));
    writeBytes('r7-len-mixed', indirectLengthDoc({ pages: 4, mixed: true }));
    writeBytes('r7-len-direct', indirectLengthDoc({ pages: 1, direct: true }));
    writeBytes('r7-len-shared', indirectLengthDoc({ pages: 1, shared: true }));
    writeBytes('r7-len-stale', indirectLengthDoc({ pages: 1, stale: true }));

    // ---- OC-A: a form XObject's /OC names a registered group --------------
    await save('r7-oc-form-on', (await formOcDoc({ off: false })).doc);
    await save('r7-oc-form-off', (await formOcDoc({ off: true })).doc);
    await save('r7-oc-form-nested', (await formOcDoc({ nested: true })).doc);

    {
        // An /OC naming a group /OCProperties does not register.
        const f = await ocDoc({});
        const registered = f.ocg('Registered');
        const stranger = f.ocg('Unregistered');
        f.setResources({ XObject: { Fm0: f.form({ OC: stranger }) } });
        f.setContents('q /Fm0 Do Q\n');
        f.ocProperties({ OCGs: [registered], D: { ON: [registered] } });
        await save('r7-oc-unregistered', f.doc);
    }
    {
        // An /OC pointing at an object that is not in the document.
        const f = await ocDoc({});
        const group = f.ocg('Layer 1');
        // The next free object number, never assigned: a reference into nothing.
        const dangling = f.doc.context.nextRef();
        f.setResources({ XObject: { Fm0: f.form({ OC: dangling }) } });
        f.setContents('q /Fm0 Do Q\n');
        f.ocProperties({ OCGs: [group], D: { ON: [group] } });
        await save('r7-oc-dangling', f.doc);
    }
    {
        // /OC on an image XObject — a type this reader does not carry.
        const f = await ocDoc({});
        const group = f.ocg('Layer 1');
        const image = f.doc.context.register(f.doc.context.stream(
            latin1('\x00\x00\x00'),
            {
                Type: 'XObject',
                Subtype: 'Image',
                Width: 1,
                Height: 1,
                ColorSpace: 'DeviceRGB',
                BitsPerComponent: 8,
                OC: group,
            },
        ));
        f.setResources({ XObject: { Im0: image } });
        f.setContents('q 100 0 0 100 10 10 cm /Im0 Do Q\n');
        f.ocProperties({ OCGs: [group], D: { ON: [group] } });
        await save('r7-oc-image', f.doc);
    }
    {
        // /OC on an annotation stays refused.
        const f = await ocDoc({});
        const group = f.ocg('Layer 1');
        f.setResources({ XObject: { Fm0: f.form({}) } });
        f.setContents('q /Fm0 Do Q\n');
        const annot = f.doc.context.register(f.doc.context.obj({
            Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 60, 60], F: 4, OC: group,
        }));
        f.page.node.set(N('Annots'), f.doc.context.obj([annot]));
        f.ocProperties({ OCGs: [group], D: { ON: [group] } });
        await save('r7-oc-annot', f.doc);
    }

    // ---- OC-B: the one-group /OCMD ----------------------------------------
    {
        const f = await ocDoc({});
        const group = f.ocg('Layer 1');
        const ocmd = f.doc.context.register(f.doc.context.obj({ Type: 'OCMD', OCGs: [group] }));
        f.setResources({ XObject: { Fm0: f.form({ OC: ocmd }) } });
        f.setContents('q /Fm0 Do Q\n');
        f.ocProperties({ OCGs: [group], D: { Name: PDFString.of('Default'), ON: [group] } });
        await save('r7-ocmd-simple', f.doc);
    }
    for (const [name, extra] of [
        ['r7-ocmd-ve', { VE: ['Not', 'ref'] }],
        ['r7-ocmd-p', { P: 'AllOn' }],
    ]) {
        const f = await ocDoc({});
        const group = f.ocg('Layer 1');
        const body = { Type: 'OCMD', OCGs: [group] };
        if (extra.VE) body.VE = [PDFName.of('Not'), group];
        if (extra.P) body.P = PDFName.of('AllOn');
        const ocmd = f.doc.context.register(f.doc.context.obj(body));
        f.setResources({ XObject: { Fm0: f.form({ OC: ocmd }) } });
        f.setContents('q /Fm0 Do Q\n');
        f.ocProperties({ OCGs: [group], D: { ON: [group] } });
        await save(name, f.doc);
    }
    {
        const f = await ocDoc({});
        const a = f.ocg('Layer A');
        const b = f.ocg('Layer B');
        const ocmd = f.doc.context.register(f.doc.context.obj({ Type: 'OCMD', OCGs: [a, b] }));
        f.setResources({ XObject: { Fm0: f.form({ OC: ocmd }) } });
        f.setContents('q /Fm0 Do Q\n');
        f.ocProperties({ OCGs: [a, b], D: { ON: [a, b] } });
        await save('r7-ocmd-two', f.doc);
    }
    {
        const f = await ocDoc({});
        const group = f.ocg('Layer 1');
        // /OCGs holding something that is not a reference to a group.
        const ocmd = f.doc.context.register(f.doc.context.obj({
            Type: 'OCMD', OCGs: [PDFNumber.of(7)],
        }));
        f.setResources({ XObject: { Fm0: f.form({ OC: ocmd }) } });
        f.setContents('q /Fm0 Do Q\n');
        f.ocProperties({ OCGs: [group], D: { ON: [group] } });
        await save('r7-ocmd-malformed', f.doc);
    }

    // ---- OC-C: /D /AS ------------------------------------------------------
    for (const event of ['View', 'Print', 'Export']) {
        const f = await formOcDoc({});
        // The entry names the group the page actually uses.
        f.doc.catalog.set(N('OCProperties'), f.doc.context.obj({
            OCGs: [f.group],
            D: {
                Name: PDFString.of('Default'),
                ON: [f.group],
                AS: [{ Event: PDFName.of(event), Category: [PDFName.of(event)], OCGs: [f.group] }],
            },
        }));
        await save(`r7-as-${event.toLowerCase()}`, f.doc);
    }
    {
        const f = await formOcDoc({});
        f.doc.catalog.set(N('OCProperties'), f.doc.context.obj({
            OCGs: [f.group],
            D: {
                ON: [f.group],
                AS: [
                    { Event: PDFName.of('View'), Category: [PDFName.of('View')], OCGs: [f.group] },
                    { Event: PDFName.of('Print'), Category: [PDFName.of('Print')], OCGs: [f.group] },
                ],
            },
        }));
        await save('r7-as-multi', f.doc);
    }
    {
        // An /AS naming a registered group no page uses.
        const f = await formOcDoc({});
        const unused = f.ocg('Unused');
        f.doc.catalog.set(N('OCProperties'), f.doc.context.obj({
            OCGs: [f.group, unused],
            D: {
                ON: [f.group, unused],
                AS: [{ Event: PDFName.of('View'), Category: [PDFName.of('View')], OCGs: [f.group, unused] }],
            },
        }));
        await save('r7-as-unmapped', f.doc);
    }
    for (const [name, entry] of [
        ['r7-as-bad-category', { Event: PDFName.of('View'), Category: [PDFNumber.of(3)] }],
        ['r7-as-bad-event', { Event: PDFName.of('Zoom'), Category: [PDFName.of('View')] }],
        ['r7-as-extra-key', { Event: PDFName.of('View'), Category: [PDFName.of('View')], Intent: PDFName.of('Design') }],
    ]) {
        const f = await formOcDoc({});
        f.doc.catalog.set(N('OCProperties'), f.doc.context.obj({
            OCGs: [f.group],
            D: { ON: [f.group], AS: [{ ...entry, OCGs: [f.group] }] },
        }));
        await save(name, f.doc);
    }

    // ---- OC-D: /D /RBGroups ------------------------------------------------
    {
        const f = await formOcDoc({ extraD: { RBGroups: [] } });
        await save('r7-rb-empty', f.doc);
    }
    {
        const f = await formOcDoc({});
        const other = f.ocg('Layer 2');
        f.doc.catalog.set(N('OCProperties'), f.doc.context.obj({
            OCGs: [f.group, other],
            D: { ON: [f.group, other], RBGroups: [[f.group, other]] },
        }));
        await save('r7-rb-nonempty', f.doc);
    }

    console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}`);
    for (const name of written) console.log(`  ${name}`);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
