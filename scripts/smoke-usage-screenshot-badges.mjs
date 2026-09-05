/**
 * Gate for the usage guide's screenshot annotations.
 *
 * The numbered boxes used to be hand-tuned percentages, and every recapture
 * left them a little further from the controls they were pointing at. They are
 * now measured, which fixes today -- this gate is what notices tomorrow: it
 * drives the live app into the same states the capture used, re-measures every
 * target, and fails when the stored geometry no longer matches. A stale badge
 * stops being something a reader has to spot.
 *
 * Run:  npm run build && node scripts/smoke-usage-screenshot-badges.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5202;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURES = path.join(ROOT, 'test-fixtures');
const SHOTS = path.join(ROOT, 'public', 'screenshots');
const GEOMETRY = path.join(ROOT, 'src', 'components', 'usage-screenshot-geometry.json');
const BADGES = path.join(ROOT, 'src', 'components', 'usageScreenshotBadges.ts');

/**
 * How far a measured edge may move before the annotation counts as stale.
 *
 * In percentage points of the frame. Two is about 25 px across a 1280-wide
 * capture: comfortably more than the sub-pixel wobble of a re-render, and far
 * less than any real layout change.
 */
const TOLERANCE = 2;

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('No dist/ found. Run: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.join(FIXTURES, 'mixed-multipage.pdf'))) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-test-fixtures.mjs')], { stdio: 'inherit' });
}

const checks = [];
const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/** PNG dimensions, straight from the header. No decoder needed. */
function pngSize(file) {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

const geometry = JSON.parse(fs.readFileSync(GEOMETRY, 'utf8'));
const badgeSource = fs.readFileSync(BADGES, 'utf8');

/**
 * The badge definitions, read out of the TypeScript rather than duplicated.
 *
 * A copy here would be one more thing to keep in step; the gate should fail
 * when the guide changes, not when someone forgets to update the gate.
 */
function parseBadges() {
    const out = {};
    const screenRe = /(\w+):\s*\{\s*src:\s*'([^']+)',\s*state:\s*'[^']*',\s*badges:\s*\[([\s\S]*?)\n {8}\],/g;
    let m;
    while ((m = screenRe.exec(badgeSource)) !== null) {
        const [, key, src, body] = m;
        const badges = [];
        const badgeRe = /targets:\s*\[([^\]]*)\][\s\S]*?desc:\s*'([^']*)'/g;
        let b;
        while ((b = badgeRe.exec(body)) !== null) {
            badges.push({
                targets: b[1].split(',').map((t) => t.trim().replace(/^'|'$/g, '')).filter(Boolean),
                desc: b[2],
            });
        }
        out[key] = { src, badges };
    }
    return out;
}

const BADGE_CONFIG = parseBadges();

const server = await preview({ root: ROOT, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

const clickNav = (page, label) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('nav button')].find((x) => (x.textContent || '').includes(t));
    if (!b) throw new Error(`nav button not found: ${t}`);
    b.click();
}, label);

const measure = (page, names) => page.evaluate((targets) => {
    const out = {};
    for (const name of targets) {
        const els = [...document.querySelectorAll(`[data-usage-target="${name}"]`)];
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
}, names);

/** The same states the capture script puts the app into. */
const SETUPS = {
    async annotator(page) {
        await clickNav(page, 'PDF加筆');
        await page.waitForSelector('.upload-section input[type="file"]');
        const input = await page.$('.upload-section input[type="file"]');
        await input.uploadFile(path.join(FIXTURES, 'text-native-ja-en.pdf'));
        await page.waitForSelector('.viewer-controls', { timeout: 60_000 });
        await page.waitForSelector('.pdf-page-container canvas', { timeout: 60_000 });
    },
    async comparator(page) {
        await clickNav(page, 'PDF比較');
        await page.waitForSelector('.file-slot input[type="file"]');
        const first = await page.$$('.file-slot input[type="file"]');
        await first[0].uploadFile(path.join(FIXTURES, 'text-native-ja-en.pdf'));
        await page.waitForFunction(() => document.querySelectorAll('.file-slot input[type="file"]').length >= 3,
            { timeout: 60_000 });
        const after = await page.$$('.file-slot input[type="file"]');
        await after[1].uploadFile(path.join(FIXTURES, 'mixed-multipage.pdf'));
        await page.waitForSelector('.canvas-container canvas', { timeout: 60_000 });
    },
    async processor(page) {
        await clickNav(page, 'PDF加工');
        await page.waitForSelector('.tools-sidebar');
        const input = await page.$('#file-input');
        await input.uploadFile(path.join(FIXTURES, 'mixed-multipage.pdf'));
        await page.waitForFunction(() => document.body.innerText.includes('mixed-multipage.pdf'), { timeout: 30_000 });
    },
    async split_extract(page) {
        await clickNav(page, 'PDF抽出・統合');
        await page.waitForSelector('[data-usage-target="split-tabs"]');
        const input = await page.$('input[type="file"]');
        await input.uploadFile(path.join(FIXTURES, 'mixed-multipage.pdf'));
        await page.waitForSelector('[data-usage-target="extract-pages"] img', { timeout: 60_000 });
        await page.evaluate(() => document.querySelector('[data-usage-target="extract-pages"] > div')?.click());
        await page.waitForSelector('[data-usage-target="extract-export"]', { timeout: 30_000 });
    },
    async split_merge(page) {
        await clickNav(page, 'PDF抽出・統合');
        await page.waitForSelector('[data-usage-target="split-tabs"]');
        await page.evaluate(() => {
            [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('PDF統合'))?.click();
        });
        await page.waitForSelector('[data-usage-target="merge-source"]', { timeout: 30_000 });
        const input = await page.$('[data-usage-target="merge-source"] input[type="file"]');
        await input.uploadFile(path.join(FIXTURES, 'mixed-multipage.pdf'), path.join(FIXTURES, 'text-native-ja-en.pdf'));
        await page.waitForFunction(
            () => document.querySelectorAll('[data-usage-target="merge-list"] > div').length >= 2, { timeout: 60_000 });
    },
    async textifier(page) {
        await clickNav(page, 'PDFテキスト化');
        await page.waitForFunction(() => document.body.innerText.includes('PDF Textification'));
        const input = await page.$('input[type="file"]');
        await input.uploadFile(path.join(FIXTURES, 'scanned-skew-noisy.pdf'));
        await page.waitForFunction((n) => document.body.innerText.includes(n), {}, 'scanned-skew-noisy.pdf');
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
            [...document.querySelectorAll('input[name="mode"]')].find((r) => r.value === 'extract')?.click();
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
};

let exitCode = 1;
try {
    const keys = Object.keys(BADGE_CONFIG);
    console.log(`\n=== the six screenshots exist and are real images ===`);
    check('the badge config names six screenshots', keys.length === 6, keys.join(', '));
    for (const key of keys) {
        const file = path.join(SHOTS, path.basename(BADGE_CONFIG[key].src));
        const size = fs.existsSync(file) ? pngSize(file) : null;
        console.log(`  ${key.padEnd(16)} ${size ? `${size.width}x${size.height}  ${size.bytes} bytes` : 'MISSING'}`);
        check(`${key}: the screenshot exists with real dimensions`,
            Boolean(size) && size.width > 0 && size.height > 0, size ? `${size.width}x${size.height}` : 'missing');
    }

    console.log(`\n=== badges are well formed ===`);
    for (const key of keys) {
        const badges = BADGE_CONFIG[key].badges;
        check(`${key}: has at least one badge`, badges.length > 0, String(badges.length));
        check(`${key}: every badge names at least one target and a description`,
            badges.every((b) => b.targets.length > 0 && b.desc.length > 0),
            JSON.stringify(badges.map((b) => b.targets.length)));
        // Numbers are the array index, so uniqueness is really "no duplicate
        // meanings mapped onto the same number".
        const descs = badges.map((b) => b.desc);
        check(`${key}: no two badges say the same thing`, new Set(descs).size === descs.length,
            JSON.stringify(descs));
        const stored = geometry[key];
        check(`${key}: measured geometry exists for it`, Boolean(stored), stored ? 'yes' : 'missing');
    }

    console.log(`\n=== stored boxes stay inside the image ===`);
    for (const key of keys) {
        const stored = geometry[key];
        if (!stored) continue;
        const rects = BADGE_CONFIG[key].badges.map((badge) => {
            const parts = badge.targets.map((t) => stored.targets[t]).filter(Boolean);
            if (!parts.length) return null;
            const left = Math.min(...parts.map((r) => r.left));
            const top = Math.min(...parts.map((r) => r.top));
            return {
                left, top,
                right: Math.max(...parts.map((r) => r.left + r.width)),
                bottom: Math.max(...parts.map((r) => r.top + r.height)),
            };
        });
        check(`${key}: every badge resolves to a box`, rects.every(Boolean),
            JSON.stringify(rects.map((r) => Boolean(r))));
        check(`${key}: no box falls outside the frame`,
            rects.every((r) => r && r.left >= 0 && r.top >= 0 && r.right <= 100.5 && r.bottom <= 100.5),
            JSON.stringify(rects.map((r) => r && [r.left, r.top, +r.right.toFixed(1), +r.bottom.toFixed(1)])));
    }

    console.log(`\n=== stored geometry still matches the live app ===`);
    let worst = 0;
    let worstWhere = '-';
    for (const key of keys) {
        const stored = geometry[key];
        const setup = SETUPS[key];
        if (!stored || !setup) {
            check(`${key}: has a way to be re-measured`, false, 'no setup');
            continue;
        }
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        try {
            await page.setViewport(stored.frame);
            await page.bringToFront();
            await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
            await setup(page);
            await new Promise((r) => setTimeout(r, 400));

            const names = Object.keys(stored.targets);
            const live = await measure(page, names);
            const drift = [];
            for (const name of names) {
                const a = stored.targets[name];
                const b = live[name];
                if (!a) continue;
                if (!b) { drift.push({ name, gone: true }); continue; }
                const edges = {
                    left: Math.abs(a.left - b.left),
                    top: Math.abs(a.top - b.top),
                    right: Math.abs((a.left + a.width) - (b.left + b.width)),
                    bottom: Math.abs((a.top + a.height) - (b.top + b.height)),
                };
                const max = Math.max(...Object.values(edges));
                if (max > worst) { worst = max; worstWhere = `${key}/${name}`; }
                if (max > TOLERANCE) drift.push({ name, edges, max: +max.toFixed(2) });
            }
            console.log(`  ${key.padEnd(16)} ${names.length} targets  worst drift so far ${worst.toFixed(2)}pp`);
            check(`${key}: every target still exists on screen`,
                names.every((n) => !stored.targets[n] || live[n]),
                JSON.stringify(names.filter((n) => stored.targets[n] && !live[n])));
            check(`${key}: stored boxes still sit on the controls (within ${TOLERANCE}pp)`,
                drift.length === 0, JSON.stringify(drift));
            check(`${key}: no page errors while reaching that state`, pageErrors.length === 0,
                pageErrors.slice(0, 2).join(' | '));
        } catch (error) {
            check(`${key}: can be driven into its captured state`, false, String(error?.message ?? error));
        } finally {
            await page.close().catch(() => { });
        }
    }
    console.log(`\n  worst edge drift across every target: ${worst.toFixed(2)} percentage points (${worstWhere})`);
    check('nothing has drifted past the tolerance', worst <= TOLERANCE, `${worst.toFixed(2)}pp at ${worstWhere}`);

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
    exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
    console.error('\nSMOKE DRIVER ERROR:', error?.stack ?? error);
    exitCode = 1;
} finally {
    await browser.close().catch(() => { });
    await server.close().catch(() => { });
    process.exit(exitCode);
}
