/**
 * Prove a minimal Office Open XML package can be built with the JSZip already
 * in this repository, before any of it is written into the app.
 *
 * The question is not "will Word probably open this". It is whether the three
 * parts a wordprocessing package actually requires are present and agree with
 * each other: a content type for every part, a package relationship pointing at
 * the main document, and a document that parses. Anything beyond that is weight
 * this feature does not need.
 *
 * It also answers the determinism question by measurement rather than by hope:
 * ZIP entries carry timestamps, so the same document built twice is only
 * byte-identical if those are pinned.
 *
 * Run:  node scripts/research-ooxml.mjs
 */
import JSZip from 'jszip';
import puppeteer from 'puppeteer';

const FIXED_DATE = new Date(Date.UTC(2026, 8, 5, 0, 0, 0));

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const body = [
    '<w:p><w:r><w:t xml:space="preserve">建築図面 Architectural Drawing</w:t></w:r></w:p>',
    '<w:p><w:r><w:t xml:space="preserve">A&amp;B &lt;drawing&gt; &quot;quoted&quot;</w:t></w:r></w:p>',
    '<w:p/>',
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    '<w:p><w:r><w:t xml:space="preserve">第二ページ Page Two</w:t></w:r></w:p>',
].join('');

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;

async function build() {
    const zip = new JSZip();
    // Order and options identical every time; the date is the only thing JSZip
    // would otherwise take from the clock.
    zip.file('[Content_Types].xml', CONTENT_TYPES, { date: FIXED_DATE });
    zip.file('_rels/.rels', PACKAGE_RELS, { date: FIXED_DATE });
    zip.file('word/document.xml', DOCUMENT, { date: FIXED_DATE });
    return zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        platform: 'DOS',
    });
}

const a = await build();
const b = await build();

console.log(`bytes            : ${a.length}`);
console.log(`byte-identical   : ${Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0}`);

// ---- reopen and inspect ----------------------------------------------------
const reopened = await JSZip.loadAsync(a);
const names = Object.keys(reopened.files).sort();
console.log(`entries          : ${JSON.stringify(names)}`);

const required = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
console.log(`required present : ${required.every((n) => names.includes(n))}`);

const docXml = await reopened.file('word/document.xml').async('string');
const relsXml = await reopened.file('_rels/.rels').async('string');
const typesXml = await reopened.file('[Content_Types].xml').async('string');

// Parsed by a real XML parser, in the environment the app itself runs in.
// No dependency is added for this: the browser already has one.
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
const inspection = await page.evaluate((parts) => {
    const parseXml = (xml) => {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const err = doc.querySelector('parsererror');
        return { ok: !err, error: err ? err.textContent.slice(0, 120) : null, doc };
    };
    const out = { parsed: {} };
    for (const [label, xml] of Object.entries(parts)) {
        const { ok, error } = parseXml(xml);
        out.parsed[label] = ok ? 'yes' : error;
    }
    const relsDoc = parseXml(parts.rels).doc;
    out.relationships = [...relsDoc.getElementsByTagName('Relationship')].map((r) => ({
        id: r.getAttribute('Id'),
        target: r.getAttribute('Target'),
        mode: r.getAttribute('TargetMode') ?? 'Internal',
        type: r.getAttribute('Type'),
    }));
    const typesDoc = parseXml(parts.types).doc;
    out.overrides = [...typesDoc.getElementsByTagName('Override')].map((o) => ({
        part: o.getAttribute('PartName'),
        contentType: o.getAttribute('ContentType'),
    }));
    return out;
}, { document: docXml, rels: relsXml, types: typesXml });
await browser.close();

for (const [label, verdict] of Object.entries(inspection.parsed)) {
    console.log(`valid XML        : ${label.padEnd(20)} ${verdict}`);
}
console.log(`relationships    : ${JSON.stringify(inspection.relationships.map((r) => ({ id: r.id, target: r.target, mode: r.mode })))}`);
console.log(`targets resolve  : ${inspection.relationships.every((r) => names.includes(r.target.replace(/^\//, '')))}`);
console.log(`external rels    : ${inspection.relationships.filter((r) => r.mode === 'External').length}`);
console.log(`overrides        : ${JSON.stringify(inspection.overrides.map((o) => o.part))}`);
console.log(`document typed   : ${inspection.overrides.some((o) => o.part === '/word/document.xml'
    && o.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')}`);

// ---- content survives ------------------------------------------------------
console.log(`japanese kept    : ${docXml.includes('建築図面')}`);
console.log(`english kept     : ${docXml.includes('Architectural Drawing')}`);
console.log(`escaped ampersand: ${docXml.includes('A&amp;B')} (raw "A&B" absent: ${!/A&B/.test(docXml)})`);
console.log(`page breaks      : ${(docXml.match(/<w:br w:type="page"\/>/g) ?? []).length}`);
console.log(`macros           : ${names.some((n) => /\.bin$|vbaProject/i.test(n)) ? 'PRESENT' : 'none'}`);
