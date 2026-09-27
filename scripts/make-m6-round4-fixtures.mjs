/**
 * The documents the third Independent FULL Re-Review's findings are proven
 * against.
 *
 * Every one of the four Required Fixes in that round was the same shape as the
 * three blockers before it: a reader met a structure it did not handle and
 * answered "nothing there" instead of refusing. So these fixtures are mostly
 * **shapes a reader has to recognise it cannot read** — a name tree that
 * cycles, a `/Names` list with an odd number of entries, a destination
 * dictionary whose `/D` is a number. The gate asserts the refusal, not a count.
 *
 * The named-destination set is deliberately paired: for each shape there is a
 * document whose target page is inside the selection and one whose target is
 * outside it, because "preserved" and "reported as a loss" are two different
 * correct answers and only one of them is right for each.
 *
 * Run:  node scripts/make-m6-round4-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from 'pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
fs.mkdirSync(OUT, { recursive: true });

const written = [];
const save = async (name, doc) => {
    const bytes = await doc.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};

const blank = async (pages = 1, label = 'R4') => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i += 1) {
        const page = doc.addPage([300, 300]);
        page.drawText(`${label}${i + 1}`, { x: 20, y: 260, size: 16, font });
    }
    return doc;
};

// ---------------------------------------------------------------------------
// RF-R3-5 — named destinations, in the shapes the reader could not read
// ---------------------------------------------------------------------------

/**
 * Three pages, a named destination `M6R4_SEC` targeting page 3, and a link on
 * page 1 that reaches it by name.
 *
 * `shape` decides how `/Names /Dests` holds it. Only `flat` was ever read: the
 * others produced an empty list, which the strip then treated as "this document
 * has no named destinations" — so nothing was preserved, nothing was reported,
 * and the operation was READY.
 */
async function namedDestination(shape) {
    const doc = await blank(3, 'ND');
    const [first, , third] = doc.getPages();
    const destArray = doc.context.obj([third.ref, PDFName.of('Fit')]);

    let dests;
    if (shape === 'flat') {
        dests = doc.context.obj({ Names: [PDFString.of('M6R4_SEC'), destArray] });
    } else if (shape === 'dict') {
        // The wrapper form: a destination dictionary holding the array under /D.
        dests = doc.context.obj({
            Names: [PDFString.of('M6R4_SEC'), doc.context.obj({ D: destArray })],
        });
    } else if (shape === 'kids') {
        const leaf = doc.context.register(doc.context.obj({
            Limits: [PDFString.of('M6R4_SEC'), PDFString.of('M6R4_SEC')],
            Names: [PDFString.of('M6R4_SEC'), destArray],
        }));
        dests = doc.context.obj({ Kids: [leaf] });
    } else if (shape === 'kids-deep') {
        // Two levels, and a second name in the other branch, so the walk has to
        // reach both leaves rather than stopping at the first.
        const leafA = doc.context.register(doc.context.obj({
            Limits: [PDFString.of('M6R4_SEC'), PDFString.of('M6R4_SEC')],
            Names: [PDFString.of('M6R4_SEC'), destArray],
        }));
        const leafB = doc.context.register(doc.context.obj({
            Limits: [PDFString.of('M6R4_TAIL'), PDFString.of('M6R4_TAIL')],
            Names: [
                PDFString.of('M6R4_TAIL'),
                doc.context.obj([first.ref, PDFName.of('Fit')]),
            ],
        }));
        const branch = doc.context.register(doc.context.obj({
            Limits: [PDFString.of('M6R4_SEC'), PDFString.of('M6R4_TAIL')],
            Kids: [leafA, leafB],
        }));
        dests = doc.context.obj({ Kids: [branch] });
    } else if (shape === 'kids-cycle') {
        const branchDict = doc.context.obj({ Limits: [] });
        const branch = doc.context.register(branchDict);
        branchDict.set(PDFName.of('Kids'), doc.context.obj([branch]));
        dests = doc.context.obj({ Kids: [branch] });
    } else if (shape === 'kids-malformed') {
        // `/Kids` present and not an array: the tree is there and unreadable.
        dests = doc.context.obj({ Kids: PDFNumber.of(7) });
    } else if (shape === 'names-malformed') {
        // An odd number of entries: not name/value pairs.
        dests = doc.context.obj({
            Names: [PDFString.of('M6R4_SEC'), destArray, PDFString.of('M6R4_ODD')],
        });
    } else if (shape === 'dict-invalid') {
        // A destination dictionary whose `/D` is not a destination.
        dests = doc.context.obj({
            Names: [PDFString.of('M6R4_SEC'), doc.context.obj({ D: PDFNumber.of(3) })],
        });
    } else {
        throw new Error(`unknown shape ${shape}`);
    }

    doc.catalog.set(
        PDFName.of('Names'),
        doc.context.register(doc.context.obj({ Dests: dests })),
    );

    first.node.set(PDFName.of('Annots'), doc.context.obj([
        doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 120, 40],
            Dest: PDFString.of('M6R4_SEC'),
        })),
    ]));
    return doc;
}

/**
 * The same document written the way producers actually write holes.
 *
 * A `null` object is equivalent to an absent one in PDF, so a `null` in
 * `/Annots` or in a name tree's `/Kids` is an ordinary empty slot rather than a
 * structure that cannot be read. Refusing those would refuse ordinary
 * documents, which is the opposite mistake to the one being fixed — so this is
 * the fixture that keeps the new refusals honest about what they are for.
 */
async function nullSlots() {
    const doc = await blank(3, 'NULLS');
    const [first, , third] = doc.getPages();
    const destArray = doc.context.obj([third.ref, PDFName.of('Fit')]);
    const leaf = doc.context.register(doc.context.obj({
        Limits: [PDFString.of('M6R4_SEC'), PDFString.of('M6R4_SEC')],
        Names: [PDFString.of('M6R4_SEC'), destArray],
    }));
    doc.catalog.set(
        PDFName.of('Names'),
        doc.context.register(doc.context.obj({ Dests: { Kids: [null, leaf] } })),
    );
    first.node.set(PDFName.of('Annots'), doc.context.obj([
        null,
        doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 120, 40],
            Dest: PDFString.of('M6R4_SEC'),
        })),
    ]));
    return doc;
}

/** A page whose `/Annots` is present and is not an array. */
async function malformedAnnots() {
    const doc = await blank(2, 'ANNOTS');
    doc.getPages()[0].node.set(PDFName.of('Annots'), PDFNumber.of(4));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-R3-1 — optional-content configuration that must survive a Merge
// ---------------------------------------------------------------------------

async function ocConfig({ label, group, dName, baseState, order }) {
    const doc = await blank(1, label);
    const page = doc.getPages()[0];
    const ocg = doc.context.register(doc.context.obj({
        Type: 'OCG', Name: PDFString.of(group),
    }));
    page.node.lookup(PDFName.of('Resources')).set(
        PDFName.of('Properties'), doc.context.obj({ M6L: ocg }),
    );
    const d = { ON: [ocg] };
    if (dName) d.Name = PDFString.of(dName);
    if (baseState) d.BaseState = PDFName.of(baseState);
    if (order) d.Order = [ocg];
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: d }));
    return doc;
}

// ---------------------------------------------------------------------------
// RF-R3-2 — a typeless `/EF` carrier whose filename the confirmation must name
// ---------------------------------------------------------------------------

/**
 * `/EF` with no `/Type /Filespec`, reached through a `/Launch` action, and a
 * second copy behind a long indirect chain.
 *
 * The removal path already found these; the path that decides whether to ask
 * the person did not, because it asked about `/Type`. So the document merged
 * without a confirmation and the attachment was disclosed afterwards.
 */
async function typelessEfNamed(deep, marker, filename) {
    const doc = await blank(1, 'TYPELESS4');
    const page = doc.getPages()[0];
    const payload = doc.context.register(doc.context.stream(marker, {}));
    const annot = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 40],
        A: {
            Type: 'Action', S: 'Launch',
            F: { F: PDFString.of(filename), EF: { F: payload } },
        },
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    if (deep) {
        let tail = annot;
        for (let i = 0; i < 140; i += 1) {
            tail = doc.context.register(doc.context.obj({ M6Link: tail }));
        }
        page.node.set(PDFName.of('M6Chain'), tail);
    }
    return doc;
}

// ---------------------------------------------------------------------------

async function main() {
    for (const shape of [
        'flat', 'dict', 'kids', 'kids-deep',
        'kids-cycle', 'kids-malformed', 'names-malformed', 'dict-invalid',
    ]) {
        await save(`r4-nd-${shape}`, await namedDestination(shape));
    }
    await save('r4-annots-malformed', await malformedAnnots());
    await save('r4-nd-null-slots', await nullSlots());

    await save('r4-oc-name-c', await ocConfig({
        label: 'OCNC', group: 'M6-OC-G', dName: 'Config A', order: true,
    }));
    await save('r4-oc-basestate-b', await ocConfig({
        label: 'OCBB', group: 'M6-OC-H', baseState: 'ON', order: true,
    }));
    await save('r4-oc-plain', await ocConfig({
        label: 'OCPL', group: 'M6-OC-I', order: true,
    }));

    await save('r4-typeless-ef', await typelessEfNamed(
        false, 'M6R4_TYPELESS_SHALLOW', 'r4-hidden.bin',
    ));
    await save('r4-typeless-ef-deep', await typelessEfNamed(
        true, 'M6R4_TYPELESS_DEEP', 'r4-hidden-deep.bin',
    ));

    console.log(`m6 round-4 fixtures: ${written.length} documents`);
    for (const name of written) console.log(`  ${name}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
