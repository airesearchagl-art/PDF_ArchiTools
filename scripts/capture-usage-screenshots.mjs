/**
 * Recapture every usage-guide screenshot, and measure where its markers go.
 *
 * The guide's numbered boxes used to be hand-tuned percentages, which is why
 * they drifted a little further out of place with each recapture. Here the
 * boxes are measured: the script drives the real app, reads the bounding
 * rectangle of each `data-usage-target`, converts it to a fraction of the
 * captured frame, and writes those numbers out. Nothing is eyeballed.
 *
 * Synthetic fixtures only. No customer document, no local path, no username and
 * no project name ever reaches an image.
 *
 * Run:  npm run build && node scripts/capture-usage-screenshots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';
import { readUsageScreenshotConfig, screenTargets, readPng } from './usage-screenshot-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5200;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures');
const SHOTS = path.join(ROOT, 'public', 'screenshots');
const GEOMETRY = path.join(ROOT, 'src', 'components', 'usage-screenshot-geometry.json');

const FRAME = { width: 1280, height: 900 };
/** A taller frame for screens whose controls run past the fold. */
const TALL = { width: 1280, height: 1150 };

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, 'mixed-multipage.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const CONFIG = readUsageScreenshotConfig();

const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

const clickNav = async (page, label) => {
    await page.evaluate((t) => {
        const b = [...document.querySelectorAll('nav button')].find((x) => (x.textContent || '').includes(t));
        if (!b) throw new Error(`nav button not found: ${t}`);
        b.click();
    }, label);
};

const upload = async (page, selector, ...fixtures) => {
    const input = await page.$(selector);
    if (!input) throw new Error(`file input not found: ${selector}`);
    await input.uploadFile(...fixtures.map((f) => path.join(FIXTURES, f)));
};

/**
 * Where each target sits, as a fraction of the captured frame.
 *
 * A badge may name several targets; the union is taken here so a group of
 * controls with no shared wrapper can still be boxed without inventing one.
 */
const measure = (page, targets) => page.evaluate((names) => {
    const out = {};
    for (const name of names) {
        const els = [...document.querySelectorAll(`[data-usage-target="${name}"]`)];
        if (els.length === 0) { out[name] = null; continue; }
        let box = null;
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            box = box
                ? {
                    left: Math.min(box.left, r.left), top: Math.min(box.top, r.top),
                    right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom),
                }
                : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        }
        out[name] = box && {
            left: +(100 * box.left / window.innerWidth).toFixed(2),
            top: +(100 * box.top / window.innerHeight).toFixed(2),
            width: +(100 * (box.right - box.left) / window.innerWidth).toFixed(2),
            height: +(100 * (box.bottom - box.top) / window.innerHeight).toFixed(2),
        };
    }
    return out;
}, targets);

/**
 * How to reach each screen, and nothing else.
 *
 * The targets a screen has to expose are not written here: they come from the
 * badge definitions, so there is no second inventory to fall out of step with
 * the first.
 */
const SCREENS = [
    {
        key: 'annotator',
        file: 'annotator.png',
        frame: FRAME,
        async setup(page) {
            await clickNav(page, 'PDF加筆');
            await page.waitForSelector('.upload-section input[type="file"]');
            await upload(page, '.upload-section input[type="file"]', 'text-native-ja-en.pdf');
            await page.waitForSelector('.viewer-controls', { timeout: 60_000 });
            await page.waitForSelector('.pdf-page-container canvas', { timeout: 60_000 });
        },
    },
    {
        key: 'comparator',
        file: 'comparator.png',
        frame: TALL,
        async setup(page) {
            await clickNav(page, 'PDF比較');
            await page.waitForSelector('.file-slot input[type="file"]');
            const inputs = await page.$$('.file-slot input[type="file"]');
            await inputs[0].uploadFile(path.join(FIXTURES, 'text-native-ja-en.pdf'));
            await page.waitForFunction(() => document.querySelectorAll('.file-slot input[type="file"]').length >= 3,
                { timeout: 60_000 });
            // Index 1, not 0: slot 0 now holds a "Change" input of its own, so
            // reusing index 0 would replace the file just loaded instead of
            // filling the next slot, and the screen would show one PDF where
            // the guide describes comparing several.
            const after = await page.$$('.file-slot input[type="file"]');
            await after[1].uploadFile(path.join(FIXTURES, 'mixed-multipage.pdf'));
            await page.waitForSelector('.canvas-container canvas', { timeout: 60_000 });
        },
    },
    {
        key: 'processor',
        file: 'processor.png',
        frame: FRAME,
        async setup(page) {
            await clickNav(page, 'PDF加工');
            await page.waitForSelector('.tools-sidebar');
            await upload(page, '#file-input', 'mixed-multipage.pdf');
            await page.waitForFunction(() => document.body.innerText.includes('mixed-multipage.pdf'),
                { timeout: 30_000 });
        },
    },
    {
        key: 'split_extract',
        file: 'split_extract.png',
        frame: FRAME,
        async setup(page) {
            await clickNav(page, 'PDF抽出・統合');
            await page.waitForSelector('[data-usage-target="split-tabs"]');
            await upload(page, 'input[type="file"]', 'mixed-multipage.pdf');
            await page.waitForSelector('[data-usage-target="extract-pages"] img', { timeout: 60_000 });
            // One page selected, so the export button is on screen to be boxed.
            await page.evaluate(() => {
                const card = document.querySelector('[data-usage-target="extract-pages"] > div');
                if (card) card.click();
            });
            await page.waitForSelector('[data-usage-target="extract-export"]', { timeout: 30_000 });
        },
    },
    {
        key: 'split_merge',
        file: 'split_merge.png',
        frame: FRAME,
        async setup(page) {
            await clickNav(page, 'PDF抽出・統合');
            await page.waitForSelector('[data-usage-target="split-tabs"]');
            await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('PDF統合'));
                if (!b) throw new Error('merge tab not found');
                b.click();
            });
            await page.waitForSelector('[data-usage-target="merge-source"]', { timeout: 30_000 });
            await upload(page, '[data-usage-target="merge-source"] input[type="file"]',
                'mixed-multipage.pdf', 'text-native-ja-en.pdf');
            await page.waitForSelector('[data-usage-target="merge-list"]', { timeout: 60_000 });
            await page.waitForFunction(
                () => document.querySelectorAll('[data-usage-target="merge-list"] > div').length >= 2,
                { timeout: 60_000 });
        },
    },
    {
        key: 'textifier',
        file: 'textifier.png',
        frame: TALL,
        async setup(page) {
            await clickNav(page, 'PDFテキスト化');
            await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));
            await upload(page, 'input[type="file"]', 'scanned-skew-noisy.pdf');
            await page.waitForFunction((n) => document.body.innerText.includes(n), {}, 'scanned-skew-noisy.pdf');
            // The preview has to be painted, not merely present.
            await page.waitForFunction(() => {
                const c = document.querySelector('canvas');
                if (!c || !c.width) return false;
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] !== 0 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 200) return true;
                }
                return false;
            }, { timeout: 30_000 });
            await page.evaluate(() => {
                const radio = [...document.querySelectorAll('input[name="mode"]')].find((r) => r.value === 'extract');
                radio.click();
            });
            await page.waitForFunction(() => document.querySelector('select')?.value === 'txt');
            await page.evaluate(() => {
                const select = document.querySelector('select');
                const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                setter.call(select, 'word');
                select.dispatchEvent(new Event('change', { bubbles: true }));
                for (const name of ['deskew', 'noiseReduction']) {
                    const box = document.querySelector(`input[name="${name}"]`);
                    if (box && !box.checked) box.click();
                }
            });
            await page.waitForFunction(() => document.querySelector('select')?.value === 'word');
        },
    },
];

const geometry = {};
let exitCode = 0;

try {
    fs.mkdirSync(SHOTS, { recursive: true });
    console.log(`${'screen'.padEnd(16)} ${'frame'.padEnd(11)} targets  missing`);
    console.log('-'.repeat(60));

    for (const screen of SCREENS) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        try {
            await page.setViewport(screen.frame);
            await page.bringToFront();
            await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
            await screen.setup(page);
            // Let any last transition settle before the shutter.
            await new Promise((r) => setTimeout(r, 500));

            const targets = screenTargets(CONFIG, screen.key);
            const rects = await measure(page, targets);
            const missing = targets.filter((t) => !rects[t]);

            const file = path.join(SHOTS, screen.file);
            await page.screenshot({ path: file });
            // The digest binds this geometry to this picture. Recapturing one
            // without the other is then a failure rather than a silence.
            const png = readPng(file);

            geometry[screen.key] = {
                frame: screen.frame,
                screenshot: {
                    file: screen.file,
                    width: png?.width ?? 0,
                    height: png?.height ?? 0,
                    sha256: png?.sha256 ?? '',
                },
                targets: rects,
            };
            console.log(`${screen.key.padEnd(16)} ${`${screen.frame.width}x${screen.frame.height}`.padEnd(11)} ${String(targets.length).padStart(7)}  ${missing.length ? missing.join(', ') : '-'}`);
            if (png && (png.width !== screen.frame.width || png.height !== screen.frame.height)) {
                console.log(`  image is ${png.width}x${png.height}, frame is ${screen.frame.width}x${screen.frame.height}`);
                exitCode = 1;
            }
            if (missing.length) exitCode = 1;
            if (errors.length) {
                console.log(`  page errors: ${errors.slice(0, 2).join(' | ')}`);
                exitCode = 1;
            }
        } catch (error) {
            console.log(`${screen.key.padEnd(16)} FAILED: ${error?.message ?? error}`);
            exitCode = 1;
        } finally {
            await page.close().catch(() => { });
        }
    }

    // No capture timestamp is stored: it would make the file change on every
    // run and say nothing about whether the numbers are still right. The digest
    // above is the identity that matters.
    fs.writeFileSync(GEOMETRY, `${JSON.stringify(geometry, null, 4)}\n`, 'utf8');
    console.log(`\nWrote ${path.relative(ROOT, GEOMETRY)}`);
} finally {
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
