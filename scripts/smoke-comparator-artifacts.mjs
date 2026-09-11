/**
 * The Comparator artifact gate: what the user actually receives.
 *
 * The reliability gate next door drives the engine and proves it declines what
 * it cannot compare. That leaves one thing unproven, and it is the thing the
 * user takes away: the file. A comparison can be correct in memory and still
 * reach the disk with its pages in the wrong order, with the changed pair
 * missing, with a notice in glyphs the PDF has no font for, or — worst — as a
 * partial artifact from a run the user had already replaced.
 *
 * So nothing here is asserted from the run that produced it. Files are driven
 * out of the real UI by uploading real PDFs and clicking the real buttons, the
 * download is captured off the disk, and every claim is then measured by
 * reopening that file with PDF.js and counting ink in it.
 *
 * Several checks assert that *no* file appeared. Those are the point: an export
 * that always produces something cannot be trusted to produce the right thing.
 *
 * Run:  node scripts/make-comparator-fixtures.mjs
 *       node scripts/smoke-comparator-artifacts.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5205;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures', 'comparator');
const DOWNLOADS = path.join(ROOT, 'test-fixtures', 'comparator-downloads');

if (!fs.existsSync(path.join(FIXTURES, 'three-pages-changed.pdf'))) {
    execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'make-comparator-fixtures.mjs')],
        { stdio: 'inherit' },
    );
}
fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const probe = (name, ok, detail = '') => check(`negative probe: ${name}`, ok, detail);

const server = await createServer({
    root: ROOT, server: { port: PORT, strictPort: true }, logLevel: 'warn',
});
await server.listen();
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // Reopening a multi-page artifact means decoding several megabytes of
    // stored-DEFLATE PNG per page. That is slower than the default protocol
    // timeout allows, and a timeout here would fail the gate for the size of
    // the file rather than for anything in it.
    protocolTimeout: 0,
});

// Downloads land on the disk, where this script can read them, rather than
// being intercepted in the page -- the point is to inspect the bytes Chrome
// actually wrote for the user.
const browserSession = await browser.target().createCDPSession();
await browserSession.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true,
});

const external = [];
const pageErrors = [];
const dialogs = [];
const record = (url) => {
    if (!url || url.startsWith(ORIGIN)) return;
    try {
        const { protocol } = new URL(url);
        if (protocol === 'http:' || protocol === 'https:') external.push(url);
    } catch { /* relative, data:, blob: */ }
};
browser.on('targetcreated', async (target) => {
    if (!['worker', 'service_worker', 'shared_worker'].includes(target.type())) return;
    try {
        const session = await target.createCDPSession();
        await session.send('Network.enable');
        session.on('Network.requestWillBeSent', (e) => record(e.request?.url));
    } catch { /* gone */ }
});

/** A page wired to the same guards, so nothing it does escapes unnoticed. */
async function newPage() {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('request', (r) => record(r.url()));
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // The app talks to the user with window.alert. Left unanswered it would
    // block the page and every later step with it.
    page.on('dialog', async (d) => {
        dialogs.push(d.message());
        await d.dismiss();
    });
    return page;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Open the app and switch to the comparator. */
async function openComparator() {
    const page = await newPage();
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('PDF比較'))?.click();
    });
    await page.waitForSelector('[data-testid="file-input-0"]');
    return page;
}

/** Put real PDFs into the real file inputs, and let the preview settle. */
async function upload(page, names) {
    for (let i = 0; i < names.length; i += 1) {
        const input = await page.waitForSelector(`[data-testid="file-input-${i}"]`);
        await input.uploadFile(path.join(FIXTURES, `${names[i]}.pdf`));
        await page.waitForFunction(
            (n) => document.body.textContent?.includes(n),
            {}, `${names[i]}.pdf`,
        );
    }
    await settle(page);
}

/** Wait until nothing is running: no comparison, no export. */
async function settle(page, timeoutMs = 120000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const busy = await page.evaluate(() => (
            document.querySelector('[data-testid="comparator-busy"]') !== null
            || document.querySelector('[data-testid="exporting-overlay"]') !== null
        ));
        if (!busy) break;
        if (Date.now() > until) throw new Error('the comparator never settled');
        await wait(100);
    }
    await wait(250);
}

// A file that has been set aside for later inspection is no longer a download
// this run is waiting for, but it is still needed on disk.
const finished = () => fs.readdirSync(DOWNLOADS)
    .filter((f) => !f.endsWith('.crdownload') && !f.startsWith('kept-'));

/** Set a captured artifact aside, so the next click starts from an empty tray. */
function keep(name) {
    fs.renameSync(path.join(DOWNLOADS, name), path.join(DOWNLOADS, `kept-${name}`));
    return `kept-${name}`;
}

/** Wait for Chrome to finish writing a download, or report that none came. */
async function download(timeoutMs = 120000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const [name] = finished();
        if (name) {
            const file = path.join(DOWNLOADS, name);
            const size = fs.statSync(file).size;
            await wait(150);
            if (fs.statSync(file).size === size) return { name, size };
        }
        if (Date.now() > until) return null;
        await wait(150);
    }
}

/** No download, proven by waiting long enough for one to have arrived. */
async function noDownload(ms = 6000) {
    await wait(ms);
    return finished();
}

function clearDownloads() {
    for (const name of fs.readdirSync(DOWNLOADS)) {
        fs.rmSync(path.join(DOWNLOADS, name), { force: true });
    }
}

let inspector = null;
/** The harness that reopens a written file and measures it. */
async function inspectorPage() {
    if (inspector) return inspector;
    inspector = await newPage();
    await inspector.goto(`${ORIGIN}/scripts/smoke-comparator-artifacts-harness.html`,
        { waitUntil: 'networkidle0' });
    await inspector.waitForFunction(() => window.__artifactsReady === true,
        { timeout: 300000 });
    return inspector;
}

const inspect = async (name) => (await inspectorPage()).evaluate(
    (url) => window.__artifacts.inspect(url),
    `/test-fixtures/comparator-downloads/${name}`,
);

/** Put a document into a slot without waiting: the point is to interrupt. */
async function replace(page, slot, name) {
    const input = await page.waitForSelector(`[data-testid="file-input-${slot}"]`);
    await input.uploadFile(path.join(FIXTURES, `${name}.pdf`));
}

/** Is anything running -- a comparison, or an export? */
const busyNow = (page) => page.evaluate(() => (
    document.querySelector('[data-testid="comparator-busy"]') !== null
    || document.querySelector('[data-testid="exporting-overlay"]') !== null
));

/**
 * Wait until a comparison is actually running.
 *
 * A probe that interrupts after a fixed delay proves nothing if the run had
 * already finished: it would pass by never having raced anything.
 */
async function waitForBusy(page, timeoutMs = 60000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const running = await page.evaluate(() =>
            document.querySelector('[data-testid="comparator-busy"]') !== null);
        if (running) return true;
        if (Date.now() > until) return false;
        await wait(25);
    }
}

/** Wait for a state panel to actually say something, not merely to be quiet. */
async function waitForStatus(page, selector, timeoutMs = 60000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const text = await page.evaluate(
            (sel) => document.querySelector(sel)?.textContent ?? null, selector,
        );
        if (text) return text;
        if (Date.now() > until) return null;
        await wait(50);
    }
}

/** Wait for the export overlay to come up, so an interruption lands mid-build. */
async function waitForOverlay(page, timeoutMs = 60000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const up = await page.evaluate(() =>
            document.querySelector('[data-testid="exporting-overlay"]') !== null);
        if (up) return true;
        if (Date.now() > until) return false;
        await wait(50);
    }
}

/** Choose a render resolution through the panel a user would open. */
async function setDpi(page, value) {
    await page.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.getAttribute('title') === 'Export Settings')?.click();
    });
    await page.waitForSelector('[data-testid="dpi"]');
    await page.select('[data-testid="dpi"]', String(value));
}

/**
 * Count every comparison painted onto a canvas, from before anything runs.
 *
 * "The superseded run published nothing" is only worth asserting if publishing
 * would have been visible. A comparison reaches the screen through
 * putImageData and through nothing else, so this is where it would show.
 */
const countPaints = (page) => page.evaluate(() => {
    window.__paints = 0;
    const original = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function patched(...args) {
        window.__paints += 1;
        return original.apply(this, args);
    };
});
const paints = (page) => page.evaluate(() => window.__paints);

let exitCode = 1;
try {
    // ---- the file a four-member comparison writes ----------------------------
    //
    // Four members, one comparable sheet. The contract says three pairs, each
    // against slot 1, each with its own visual -- so this is where "reference
    // pairs" stops being a word in a document and becomes three pages in a file
    // the user can open.
    console.log('\n=== the Comparison PDF ===');
    const four = ['base-a4', 'base-a4-copy', 'wall-at-y-a4', 'wall-at-y-a4-copy'];
    const app = await openComparator();
    await upload(app, four);
    await app.click('[data-testid="export-pdf"]');
    const written = await download();
    check('clicking Export writes a file',
        written !== null,
        written ? `${written.name}, ${(written.size / 1e6).toFixed(1)} MB` : 'nothing arrived');
    check('and it is named after the reference document and the resolution',
        written !== null && /^comparison_base-a4_\d+dpi\.pdf$/.test(written.name),
        written?.name ?? '');
    // The tool is closed before the file is reopened. What is measured below is
    // the artifact, not a page still holding the run that produced it.
    await app.close();

    const comparison = await inspect(written.name);
    const expected = await (await inspectorPage()).evaluate(
        (names) => window.__artifacts.expected(
            names.map((n) => `${n}`), [1], 150, 0,
        ),
        four,
    );
    for (const p of comparison.pages) {
        console.log(`  page ${p.index}: ${p.widthPt}x${p.heightPt}pt  `
            + `ink ${p.inked}  colour ${p.coloured}  "${p.text}"`);
    }

    check('the file opens, and holds one page per pair -- three, for four members',
        comparison.numPages === 3,
        `${comparison.numPages} pages`);
    const titles = comparison.pages.map((p) => p.text);
    check('in slot order, each against the reference and no other member',
        titles[0]?.startsWith('p1: base-a4.pdf vs base-a4-copy.pdf')
        && titles[1]?.startsWith('p1: base-a4.pdf vs wall-at-y-a4.pdf')
        && titles[2]?.startsWith('p1: base-a4.pdf vs wall-at-y-a4-copy.pdf'),
        titles.join(' | '));
    probe('no page compares two members with each other',
        comparison.pages.every((p) => p.text.startsWith('p1: base-a4.pdf vs'))
        && !titles.some((t) => /wall-at-y-a4\.pdf vs/.test(t)),
        'the composite that used to hide a two-against-two split');
    check('every page is upright, portrait, and the size of the source sheet',
        comparison.pages.every((p) => p.rotation === 0 && !p.landscape
            && Math.abs(p.widthPt - 595.28) < 1 && Math.abs(p.heightPt - 841.89) < 1),
        `${comparison.pages[0].widthPt}x${comparison.pages[0].heightPt}pt `
        + 'against A4 at 595.28x841.89pt');
    check('and every page has the drawing on it, not an empty sheet',
        comparison.pages.every((p) => p.inked > 3000),
        `${comparison.pages.map((p) => p.inked).join(', ')} ink pixels`);

    // Two members show one drawing and two show another. The old composite made
    // that look like a single change; three pairs make it two.
    const verdicts = expected.pages[0].pairs.map((p) => p.verdict);
    check('the engine calls this two-against-two split one MATCH and two CHANGEs',
        verdicts.join(',') === 'MATCH,CHANGE,CHANGE', verdicts.join(','));
    probe('and both disagreeing pairs are visibly changed in the written file',
        comparison.pages[1].coloured > 1000 && comparison.pages[2].coloured > 1000,
        `${comparison.pages[1].coloured} and ${comparison.pages[2].coloured} `
        + 'coloured pixels');
    check('while the matching pair is not painted as a change',
        comparison.pages[0].coloured === 0,
        'grey ink only, which is what MATCH looks like');
    clearDownloads();

    // ---- the order the pages come in ------------------------------------------
    //
    // Three members over three pages is six pairs, and there are two orders to
    // get wrong: the sheet, and the slot within the sheet. Only one member
    // differs, and only on page 2, so a reader can see from the file itself
    // which axis the file is sorted on.
    console.log('\n=== source page, then slot ===');
    const threeWay = ['three-pages', 'three-pages-copy', 'three-pages-changed'];
    const ordered = await openComparator();
    await upload(ordered, threeWay);
    await ordered.click('[data-testid="export-pdf"]');
    const orderedFile = await download();
    check('a three-page, three-member job writes a file', orderedFile !== null,
        orderedFile ? `${(orderedFile.size / 1e6).toFixed(1)} MB` : 'nothing arrived');
    await ordered.close();
    const byOrder = await inspect(orderedFile.name);
    const orderTitles = byOrder.pages.map((p) => p.text.split(' — ')[0]);
    for (const p of byOrder.pages) {
        console.log(`  page ${p.index}: colour ${p.coloured}  "${p.text}"`);
    }
    check('six pairs for three members over three pages',
        byOrder.numPages === 6, `${byOrder.numPages} pages`);
    check('sheet 1 first, both its slots, then sheet 2, then sheet 3',
        orderTitles.join(' | ') === [
            'p1: three-pages.pdf vs three-pages-copy.pdf',
            'p1: three-pages.pdf vs three-pages-changed.pdf',
            'p2: three-pages.pdf vs three-pages-copy.pdf',
            'p2: three-pages.pdf vs three-pages-changed.pdf',
            'p3: three-pages.pdf vs three-pages-copy.pdf',
            'p3: three-pages.pdf vs three-pages-changed.pdf',
        ].join(' | '),
        orderTitles.join(' | '));
    probe('and the one changed sheet is the one page painted as changed',
        byOrder.pages.filter((p) => p.coloured > 500).map((p) => p.index)
            .join(',') === '4',
        'page 4 of the file is p2 against the member that differs on p2');
    clearDownloads();

    // ---- the Change Report ----------------------------------------------------
    //
    // The report is the presentation that crops. A crop is a claim about where
    // the change is, so the caption's numbers have to be the comparison's
    // numbers, and the picture above them has to be that rectangle.
    console.log('\n=== the Change Report ===');
    const reporter = await openComparator();
    await upload(reporter, ['base-a4', 'added-line-a4']);
    await reporter.click('[data-testid="change-report"]');
    const reportFile = await download();
    check('clicking Change Report writes a file', reportFile !== null,
        reportFile ? `${reportFile.name}, ${(reportFile.size / 1e6).toFixed(1)} MB`
            : 'nothing arrived');
    await reporter.close();
    const report = await inspect(reportFile.name);
    const reportExpected = await (await inspectorPage()).evaluate(
        (names) => window.__artifacts.expected(names, [1], 150, 0),
        ['base-a4', 'added-line-a4'],
    );
    const bounds = reportExpected.pages[0].pairs[0].bounds;
    const caption = report.pages[0].text;
    console.log(`  "${caption}"`);
    console.log(`  engine bounds: x=${bounds.x} y=${bounds.y} `
        + `w=${bounds.width} h=${bounds.height}`);
    check('one CHANGE pair, one page in the report',
        report.numPages === 1, `${report.numPages} pages`);
    check('the page names the pair and its verdict',
        caption.includes('p1: base-a4.pdf vs added-line-a4.pdf — CHANGE'), caption);
    check('and the crop it captions is the rectangle the comparison found',
        caption.includes(`x=${bounds.x} y=${bounds.y} `
            + `w=${bounds.width} h=${bounds.height}`),
        'the caption is the comparison, not a rounding of it');
    probe('the crop is a crop, not the whole sheet relabelled',
        bounds.width < reportExpected.pages[0].pairs[0].width
        && bounds.height < reportExpected.pages[0].pairs[0].height,
        `${bounds.width}x${bounds.height} of `
        + `${reportExpected.pages[0].pairs[0].width}x`
        + `${reportExpected.pages[0].pairs[0].height}`);
    const box = await (await inspectorPage()).evaluate(
        (url) => window.__artifacts.colouredBox(url, 1),
        `/test-fixtures/comparator-downloads/${reportFile.name}`,
    );
    const drawnAspect = box.width / box.height;
    const claimedAspect = bounds.width / bounds.height;
    check('and the picture above the caption is that rectangle',
        box.coloured > 500
        && Math.abs(drawnAspect - claimedAspect) / claimedAspect < 0.1,
        `drawn ${drawnAspect.toFixed(2)} against claimed `
        + `${claimedAspect.toFixed(2)}`);
    clearDownloads();

    // ---- a page one document does not have ------------------------------------
    //
    // The missing page has to reach the file, in its place, in words the reader
    // can read. jsPDF's standard fonts have no Japanese glyphs, so the notice is
    // drawn as an image -- and that claim is worth nothing unless the sentence
    // is really in the image, which is what this measures.
    console.log('\n=== the page that was not there ===');
    const absent = await openComparator();
    await upload(absent, ['three-pages', 'two-pages']);
    await absent.click('[data-testid="export-pdf"]');
    const absentFile = await download();
    // The report is the other presentation that has to keep it. Pages 1 and 2
    // match, so without the notice there would be nothing in the file at all --
    // and "no changes found" is not what happened.
    const keptExport = keep(absentFile.name);
    await absent.click('[data-testid="change-report"]');
    const absentReport = await download();
    await absent.close();
    const absentReportPdf = await inspect(absentReport.name);
    const absentPdf = await inspect(keptExport);
    for (const p of absentPdf.pages) {
        console.log(`  page ${p.index}: ${p.widthPt}x${p.heightPt}pt  ink ${p.inked}`
            + `  "${p.text}"`);
    }
    check('the pages that could be compared are still compared',
        absentPdf.numPages === 3
        && absentPdf.pages[0].text.startsWith('p1: three-pages.pdf vs two-pages.pdf')
        && absentPdf.pages[1].text.startsWith('p2: three-pages.pdf vs two-pages.pdf'),
        `${absentPdf.numPages} pages`);
    probe('and the page that could not be is kept, in its own place, unjudged',
        absentPdf.pages[2].text === '' && absentPdf.pages[2].inked > 200,
        'a notice with no text object: it was not written through a font that '
        + 'has no glyphs for it');
    const glyphs = await (await inspectorPage()).evaluate(
        (args) => window.__artifacts.noticeProof(...args),
        [`/test-fixtures/comparator-downloads/${keptExport}`, 3,
            ['Page 3 — MISSING_PAGE', 'ページ 3 — two-pages.pdf に対応ページがありません'],
            ['Page 9 — RENDER_FAILED', 'ページ 9 — 比較は正常に完了しました'],
            1240, 1754],
    );
    console.log(`  notice ${glyphs.renderedWidth}x${glyphs.renderedHeight}, `
        + `${glyphs.inked} ink pixels (${glyphs.japaneseInk} of them from the `
        + `Japanese line); agreement with the sentence `
        + `${(glyphs.sameSentence * 100).toFixed(1)}%, with a different one `
        + `${(glyphs.otherSentence * 100).toFixed(1)}%`);
    check('the machine can draw the sentence in the first place',
        glyphs.japaneseInk > 200,
        `${glyphs.japaneseInk} ink pixels from the Japanese line alone; without `
        + 'this, agreeing with it would be two blanks agreeing');
    check('the Japanese sentence survived into the file as the sentence it was',
        glyphs.inked > 200 && glyphs.sameSentence > 0.9,
        `${(glyphs.sameSentence * 100).toFixed(1)}% of the ink agrees, `
        + 'drawn again here and compared pixel for pixel');
    probe('and a different sentence does not match it, so this measures glyphs',
        glyphs.otherSentence < 0.75,
        `${(glyphs.otherSentence * 100).toFixed(1)}%`);
    console.log(`  report: ${absentReportPdf.numPages} page(s), `
        + `ink ${absentReportPdf.pages[0].inked}, text "${
            absentReportPdf.pages[0].text}"`);
    probe('the Change Report keeps it too, rather than reporting no changes',
        absentReportPdf.numPages === 1
        && absentReportPdf.pages[0].text === ''
        && absentReportPdf.pages[0].inked > 200,
        'two matching pages and one page nobody could compare is not '
        + '"no changes found"');
    clearDownloads();

    // ---- a member that cannot be drawn ----------------------------------------
    //
    // A render that fails is not a smaller comparison. With one layer left
    // nothing matches and the whole sheet paints as revised, which is the most
    // alarming wrong answer the tool can give -- so the operation fails, and
    // there is no partial file to mistake for a result.
    console.log('\n=== when a member cannot be rendered ===');
    const broken = await openComparator();
    await upload(broken, ['base-a4', 'added-line-a4']);
    // Injected at the boundary the engine actually depends on: the second
    // full-size canvas a run asks for comes back without a context. The
    // reference renders; the member it would be compared against cannot.
    await broken.evaluate(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        let seen = new WeakSet();
        let large = 0;
        window.__armRenderFailure = () => { seen = new WeakSet(); large = 0; };
        window.__disarmRenderFailure = () => {
            HTMLCanvasElement.prototype.getContext = original;
        };
        HTMLCanvasElement.prototype.getContext = function patched(...args) {
            if (this.width > 1000 && this.height > 1000 && !seen.has(this)) {
                seen.add(this);
                large += 1;
                if (large === 2) return null;
            }
            return original.apply(this, args);
        };
    });

    await broken.evaluate(() => window.__armRenderFailure());
    await broken.click('[data-testid="export-pdf"]');
    const afterFailedExport = await noDownload();
    probe('a member that cannot be drawn writes no Comparison PDF at all',
        afterFailedExport.length === 0,
        afterFailedExport.length === 0 ? 'no file'
            : `a partial artifact appeared: ${afterFailedExport.join(', ')}`);
    const failureNotice = await broken.evaluate(() => ({
        status: document.querySelector('[data-testid="refusal-status"]')?.textContent
            ?? null,
        panel: document.querySelector('[data-testid="preflight-refusal"]')
            ?.textContent ?? '',
    }));
    check('and the tool says which page and which document could not be drawn',
        failureNotice.status === 'RENDER_FAILED'
        && /ページ 1/.test(failureNotice.panel)
        && /added-line-a4\.pdf|base-a4\.pdf/.test(failureNotice.panel),
        `${failureNotice.status}: ${failureNotice.panel.slice(0, 120)}`);

    await broken.evaluate(() => window.__armRenderFailure());
    await broken.click('[data-testid="change-report"]');
    const afterFailedReport = await noDownload();
    probe('nor a Change Report', afterFailedReport.length === 0,
        afterFailedReport.length === 0 ? 'no file'
            : afterFailedReport.join(', '));
    await broken.evaluate(() => window.__disarmRenderFailure());
    clearDownloads();
    await broken.close();

    // ---- a run the user has already replaced -----------------------------------
    //
    // Everything below is about one thing: a result that arrives after the user
    // has moved on is worse than no result, because it is indistinguishable
    // from a current one. The paint counter is installed before anything runs,
    // so "nothing was published" is measured rather than inferred.
    console.log('\n=== a run the user has already replaced ===');

    // (1) a comparison superseded by hiding members
    //
    // Hidden down to a single document there is nothing to compare, so the
    // replacement cannot paint: every paint after this moment would have to
    // have come from the run the user just discarded.
    const hidden = await openComparator();
    await countPaints(hidden);
    await setDpi(hidden, 300);
    await upload(hidden, ['base-a4', 'added-line-a4', 'wall-at-y-a4']);
    await replace(hidden, 0, 'dense-a');
    const busyWhenHidden = await waitForBusy(hidden);
    await hidden.click('[data-testid="visibility-1"]');
    await hidden.click('[data-testid="visibility-2"]');
    const atHide = await paints(hidden);
    await settle(hidden);
    // Long enough that a run which had not been stopped would have finished and
    // painted: "nothing was published" is a claim about time, not about an
    // instant.
    await wait(4000);
    const afterHide = await paints(hidden);
    probe('hiding members while a comparison runs publishes nothing from it',
        busyWhenHidden === true && afterHide === atHide,
        busyWhenHidden
            ? `${afterHide - atHide} paint(s) after the run was discarded`
            : 'the comparison was not running, so nothing was raced');
    await hidden.close();

    // (2) a comparison superseded by replacing a document
    const replaced = await openComparator();
    await countPaints(replaced);
    await setDpi(replaced, 300);
    await upload(replaced, ['base-a4', 'added-line-a4']);
    await replace(replaced, 1, 'dense-b');
    const busyWhenReplaced = await waitForBusy(replaced);
    // A3 against A4 cannot be overlaid at all, so the replacement reaches a
    // state with no picture in it: any paint after this moment came from the
    // run the user had already discarded.
    await replace(replaced, 1, 'base-a3');
    const atReplace = await paints(replaced);
    const stateAfter = await waitForStatus(
        replaced, '[data-testid="page-state-status"]',
    );
    await settle(replaced);
    await wait(4000);
    const afterReplace = await paints(replaced);
    probe('replacing a document while a comparison runs publishes nothing from it',
        busyWhenReplaced === true && afterReplace === atReplace
        && stateAfter === 'GEOMETRY_MISMATCH',
        busyWhenReplaced
            ? `the replacement came to rest at ${stateAfter}, with `
                + `${afterReplace - atReplace} paint(s) from the run it replaced`
            : 'the comparison was not running, so nothing was raced');
    await replaced.close();

    // (3) superseded while the Comparison PDF is being built
    const duringExport = await openComparator();
    await upload(duringExport, threeWay);
    await duringExport.click('[data-testid="export-pdf"]');
    const exportOverlay = await waitForOverlay(duringExport);
    await replace(duringExport, 1, 'base-a3');
    const afterExportSupersede = await noDownload(15000);
    probe('a Comparison PDF is not saved by a run the user superseded',
        exportOverlay === true && afterExportSupersede.length === 0,
        afterExportSupersede.length === 0 ? 'nothing was written'
            : `a stale file appeared: ${afterExportSupersede.join(', ')}`);
    check('and the tool is not left looking busy',
        (await busyNow(duringExport)) === false,
        'no overlay, no spinner, after an abandoned export');
    await duringExport.close();

    // (4) superseded while the Change Report is being built
    const duringReport = await openComparator();
    await upload(duringReport, threeWay);
    await duringReport.click('[data-testid="change-report"]');
    const reportOverlay = await waitForOverlay(duringReport);
    await replace(duringReport, 1, 'base-a3');
    const afterReportSupersede = await noDownload(15000);
    probe('nor is a Change Report',
        reportOverlay === true && afterReportSupersede.length === 0,
        afterReportSupersede.length === 0 ? 'nothing was written'
            : `a stale file appeared: ${afterReportSupersede.join(', ')}`);
    check('and that path clears its overlay too',
        (await busyNow(duringReport)) === false,
        'the report used to leave the tool looking busy for the session');
    await duringReport.close();

    // (5) navigated away while an artifact was being built
    const leaving = await openComparator();
    await upload(leaving, threeWay);
    await leaving.click('[data-testid="export-pdf"]');
    const leavingOverlay = await waitForOverlay(leaving);
    await leaving.evaluate(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent?.trim() === 'PDF加筆')?.click();
    });
    const afterLeaving = await noDownload(15000);
    const gone = await leaving.evaluate(() =>
        document.querySelector('[data-testid="file-input-0"]') === null);
    probe('leaving the tool mid-export saves nothing after it is gone',
        leavingOverlay === true && gone === true && afterLeaving.length === 0,
        afterLeaving.length === 0 ? 'the comparator unmounted and wrote nothing'
            : `a file arrived after the tool was closed: ${afterLeaving.join(', ')}`);
    await leaving.close();

    // ---- and when it finishes, it lets go --------------------------------------
    //
    // The other half of an overlay that clears on abandonment: one that clears
    // on success. A report that left it up would leave the tool unusable for
    // the rest of the session, with nothing on screen to say why.
    console.log('\n=== the tool is usable afterwards ===');
    const after = await openComparator();
    await upload(after, ['base-a4', 'added-line-a4']);
    await after.click('[data-testid="change-report"]');
    const reportWritten = await download();
    await settle(after);
    const state = await after.evaluate(() => ({
        overlay: document.querySelector('[data-testid="exporting-overlay"]') !== null,
        busy: document.querySelector('[data-testid="comparator-busy"]') !== null,
        exportDisabled: document.querySelector('[data-testid="export-pdf"]')?.disabled
            ?? null,
        reportDisabled: document.querySelector('[data-testid="change-report"]')
            ?.disabled ?? null,
    }));
    check('a finished Change Report leaves no overlay and no spinner',
        reportWritten !== null && state.overlay === false && state.busy === false,
        `${reportWritten?.name ?? 'no file'}`);
    check('and both controls are usable again',
        state.exportDisabled === false && state.reportDisabled === false,
        'Export and Change Report both enabled');
    clearDownloads();
    // Usable is a claim about the next click, so this makes it.
    await after.click('[data-testid="export-pdf"]');
    const second = await download();
    check('so the next export still works',
        second !== null, second?.name ?? 'nothing arrived');
    clearDownloads();
    await after.close();

    // ---- nothing left the machine --------------------------------------------
    console.log('\n=== the artifacts were built locally ===');
    probe('no external HTTP(S) request while the files were produced',
        external.length === 0,
        external.length === 0 ? '0 requests' : external.join(' '));
    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    fs.writeFileSync(
        path.join(ROOT, 'test-fixtures', 'smoke-comparator-artifacts-results.json'),
        `${JSON.stringify({
            ranAt: new Date().toISOString(), checks, dialogs,
            external: [...new Set(external)], pageErrors,
        }, null, 2)}\n`,
    );

    const failed = checks.filter((c) => !c.ok);
    const probes = checks.filter((c) => c.name.startsWith('negative probe')).length;
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed, `
        + `${probes} of them negative probes`);
    if (failed.length === 0) {
        console.log('\nThe files the user receives say what the comparison found, '
            + 'and no file appears from a run the user replaced.\n');
        exitCode = 0;
    } else {
        console.error(`\n${failed.length} check(s) failed.\n`);
    }
} catch (error) {
    console.error(`\nArtifact run failed: ${error?.stack ?? error}\n`);
} finally {
    await browser.close();
    await server.close();
}

process.exit(exitCode);
