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
import {
    readUsageScreenshotConfig, screenTargets, readPng,
    validateArtifacts, compareLiveGeometry, worstDrift,
} from './usage-screenshot-config.mjs';

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

const geometry = JSON.parse(fs.readFileSync(GEOMETRY, 'utf8'));
const BADGE_CONFIG = readUsageScreenshotConfig();

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

    // ---- the artifacts agree with each other -------------------------------
    console.log('\n=== artifact contract ===');
    check('the badge config names six screenshots', keys.length === 6, keys.join(', '));

    const problems = validateArtifacts({ config: BADGE_CONFIG, geometry, screenshotDir: SHOTS });
    for (const p of problems) console.log(`  PROBLEM ${p.kind} ${p.screen ?? ''}: ${p.detail}`);
    const of = (...kinds) => problems.filter((p) => kinds.includes(p.kind));
    check('the semantic targets and the measured targets are the same set, per screen',
        of('target-set', 'screen-set').length === 0, JSON.stringify(of('target-set', 'screen-set')));
    check('every badge has geometry for all of its targets, not some',
        of('partial-badge').length === 0, JSON.stringify(of('partial-badge')));
    check('the image the guide asks for is the image that was measured',
        of('screenshot-identity').length === 0, JSON.stringify(of('screenshot-identity')));
    check('every committed image matches the digest and size that were recorded',
        of('png-digest', 'png-record-size', 'png-frame-size', 'missing-png', 'no-screenshot-record').length === 0,
        JSON.stringify(of('png-digest', 'png-record-size', 'png-frame-size', 'missing-png', 'no-screenshot-record')));
    check('nothing at all is wrong with the stored artifacts', problems.length === 0,
        `${problems.length} problems`);

    for (const key of keys) {
        const record = geometry[key]?.screenshot;
        const png = record && readPng(path.join(SHOTS, record.file));
        console.log(`  ${key.padEnd(16)} ${(record?.file ?? '?').padEnd(20)} ${png ? `${png.width}x${png.height}` : 'missing'}  sha ${(record?.sha256 ?? '?').slice(0, 12)}  ${screenTargets(BADGE_CONFIG, key).length} targets`);
    }

    // ---- badges are well formed ---------------------------------------------
    console.log('\n=== badges ===');
    for (const key of keys) {
        const badges = BADGE_CONFIG[key].badges;
        check(`${key}: has at least one badge`, badges.length > 0, String(badges.length));
        check(`${key}: every badge names targets and says what it means`,
            badges.every((b) => b.targets.length > 0 && b.desc.length > 0),
            JSON.stringify(badges.map((b) => b.targets.length)));
        const descs = badges.map((b) => b.desc);
        check(`${key}: no two badges say the same thing`, new Set(descs).size === descs.length,
            JSON.stringify(descs));
    }

    console.log('\n=== stored boxes stay inside the image ===');
    for (const key of keys) {
        const stored = geometry[key];
        if (!stored) continue;
        // Every target, not the ones that happen to be there: a badge with a
        // missing target has already failed above and must not be drawn here.
        const rects = BADGE_CONFIG[key].badges.map((badge) => {
            const parts = badge.targets.map((t) => stored.targets?.[t]);
            if (parts.some((r) => !r)) return null;
            return {
                left: Math.min(...parts.map((r) => r.left)),
                top: Math.min(...parts.map((r) => r.top)),
                right: Math.max(...parts.map((r) => r.left + r.width)),
                bottom: Math.max(...parts.map((r) => r.top + r.height)),
            };
        });
        check(`${key}: every badge resolves to a complete box`, rects.every(Boolean),
            JSON.stringify(rects.map((r) => Boolean(r))));
        check(`${key}: no box falls outside the frame`,
            rects.every((r) => r && r.left >= 0 && r.top >= 0 && r.right <= 100.5 && r.bottom <= 100.5),
            JSON.stringify(rects.map((r) => r && [r.left, r.top, +r.right.toFixed(1), +r.bottom.toFixed(1)])));
    }

    // ---- stored geometry still matches the live app -------------------------
    console.log('\n=== live app ===');
    let worst = 0;
    let worstWhere = '-';
    const liveByScreen = {};
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

            // Measured from the semantic list, so a target that exists only in
            // the stored geometry is caught by the comparison below rather than
            // quietly never being looked for.
            const live = await measure(page, screenTargets(BADGE_CONFIG, key));
            liveByScreen[key] = live;

            const drift = compareLiveGeometry({ stored, live, tolerance: TOLERANCE });
            const w = worstDrift({ stored, live });
            if (w.worst > worst) { worst = w.worst; worstWhere = `${key}/${w.where}`; }
            console.log(`  ${key.padEnd(16)} ${Object.keys(stored.targets).length} targets  worst ${w.worst.toFixed(2)}pp  ${drift.length ? JSON.stringify(drift) : 'aligned'}`);

            check(`${key}: every target is still on screen and still where it was (within ${TOLERANCE}pp)`,
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

    // ---- the checks above have to be able to fail ---------------------------
    //
    // A gate that only ever runs against correct inputs says nothing about what
    // it would do with wrong ones. Each probe breaks one thing in a copy of the
    // artifacts and requires the matching check to reject it.
    console.log('\n=== negative probes ===');
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const probeScreen = 'processor';

    // A. a target the badges ask for, missing from the measured set.
    const missingTarget = clone(geometry);
    const dropped = screenTargets(BADGE_CONFIG, probeScreen)[0];
    delete missingTarget[probeScreen].targets[dropped];
    const aKinds = validateArtifacts({ config: BADGE_CONFIG, geometry: missingTarget, screenshotDir: SHOTS })
        .map((p) => p.kind);
    console.log(`  A  missing target "${dropped}": ${aKinds.join(', ') || 'none'}`);
    check('A: a missing semantic target is rejected',
        aKinds.includes('target-set') && aKinds.includes('partial-badge'), JSON.stringify(aKinds));

    // A2. a measurement nothing asks for.
    const extraTarget = clone(geometry);
    extraTarget[probeScreen].targets['not-a-real-target'] = { left: 1, top: 1, width: 1, height: 1 };
    const a2Kinds = validateArtifacts({ config: BADGE_CONFIG, geometry: extraTarget, screenshotDir: SHOTS })
        .map((p) => p.kind);
    console.log(`  A2 extra target: ${a2Kinds.join(', ') || 'none'}`);
    check('A2: an extra measured target is rejected too', a2Kinds.includes('target-set'), JSON.stringify(a2Kinds));

    // A3. a screen in one place and not the other.
    const missingScreen = clone(geometry);
    delete missingScreen[probeScreen];
    const a3Kinds = validateArtifacts({ config: BADGE_CONFIG, geometry: missingScreen, screenshotDir: SHOTS })
        .map((p) => p.kind);
    console.log(`  A3 missing screen: ${a3Kinds.join(', ') || 'none'}`);
    check('A3: a screen with no geometry at all is rejected', a3Kinds.includes('screen-set'), JSON.stringify(a3Kinds));

    // B. the committed picture is not the one that was measured.
    const wrongDigest = clone(geometry);
    wrongDigest[probeScreen].screenshot.sha256 = '0'.repeat(64);
    const b1Kinds = validateArtifacts({ config: BADGE_CONFIG, geometry: wrongDigest, screenshotDir: SHOTS })
        .map((p) => p.kind);
    console.log(`  B1 wrong digest: ${b1Kinds.join(', ') || 'none'}`);
    check('B1: a screenshot whose bytes do not match the record is rejected',
        b1Kinds.includes('png-digest'), JSON.stringify(b1Kinds));

    const wrongFrame = clone(geometry);
    wrongFrame[probeScreen].frame.height += 100;
    const b2Kinds = validateArtifacts({ config: BADGE_CONFIG, geometry: wrongFrame, screenshotDir: SHOTS })
        .map((p) => p.kind);
    console.log(`  B2 frame mismatch: ${b2Kinds.join(', ') || 'none'}`);
    check('B2: a frame size that disagrees with the image is rejected',
        b2Kinds.includes('png-frame-size'), JSON.stringify(b2Kinds));

    // B3. the bytes themselves change, with the record left alone.
    const scratch = fs.mkdtempSync(path.join(ROOT, 'test-fixtures', 'badge-probe-'));
    try {
        for (const key of keys) {
            const rec = geometry[key].screenshot;
            fs.copyFileSync(path.join(SHOTS, rec.file), path.join(scratch, rec.file));
        }
        const tampered = path.join(scratch, geometry[probeScreen].screenshot.file);
        const bytes = fs.readFileSync(tampered);
        bytes[bytes.length - 1] ^= 0xff;
        fs.writeFileSync(tampered, bytes);
        const b3Kinds = validateArtifacts({ config: BADGE_CONFIG, geometry, screenshotDir: scratch })
            .map((p) => p.kind);
        console.log(`  B3 tampered bytes: ${b3Kinds.join(', ') || 'none'}`);
        check('B3: a screenshot edited after capture is rejected',
            b3Kinds.includes('png-digest'), JSON.stringify(b3Kinds));

        // The same copies, restored: proof the probe detects the edit and not
        // the copying.
        fs.copyFileSync(path.join(SHOTS, geometry[probeScreen].screenshot.file), tampered);
        const cleanKinds = validateArtifacts({ config: BADGE_CONFIG, geometry, screenshotDir: scratch })
            .map((p) => p.kind);
        check('B3 control: the same copies pass once restored', cleanKinds.length === 0,
            JSON.stringify(cleanKinds));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }

    // D. the record names a different picture from the one the guide shows.
    // A correct digest of the wrong image is still the wrong image.
    const wrongFile = clone(geometry);
    wrongFile.annotator.screenshot.file = 'processor.png';
    const dKinds = validateArtifacts({ config: BADGE_CONFIG, geometry: wrongFile, screenshotDir: SHOTS })
        .map((p) => p.kind);
    console.log(`  D  record names another screenshot: ${dKinds.join(', ') || 'none'}`);
    check('D: a record naming a different screenshot is rejected',
        dKinds.includes('screenshot-identity'), JSON.stringify(dKinds));

    // D2. and the served path itself has to be the one the guide can request.
    const wrongSrc = clone(BADGE_CONFIG);
    wrongSrc.annotator.src = '/elsewhere/annotator.png';
    const d2Kinds = validateArtifacts({ config: wrongSrc, geometry, screenshotDir: SHOTS })
        .map((p) => p.kind);
    console.log(`  D2 served path moved: ${d2Kinds.join(', ') || 'none'}`);
    check('D2: a served path outside /screenshots is rejected',
        d2Kinds.includes('screenshot-identity'), JSON.stringify(d2Kinds));

    // C. geometry that no longer matches the live app.
    const probeLive = liveByScreen[probeScreen];
    if (probeLive) {
        const shifted = clone(geometry[probeScreen]);
        const first = Object.keys(shifted.targets)[0];
        shifted.targets[first].top += 5;
        const cDrift = compareLiveGeometry({ stored: shifted, live: probeLive, tolerance: TOLERANCE });
        console.log(`  C  5pp shift on ${first}: ${JSON.stringify(cDrift)}`);
        check('C: a five-point shift is rejected as drift',
            cDrift.some((d) => d.name === first && d.max >= 5), JSON.stringify(cDrift));

        const cClean = compareLiveGeometry({ stored: geometry[probeScreen], live: probeLive, tolerance: TOLERANCE });
        check('C control: the real geometry still passes the same comparison',
            cClean.length === 0, JSON.stringify(cClean));

        // A control that disappeared is drift too, not a silent pass.
        const withoutLive = { ...probeLive };
        delete withoutLive[first];
        check('C2: a target that vanished from the app is rejected',
            compareLiveGeometry({ stored: geometry[probeScreen], live: withoutLive, tolerance: TOLERANCE })
                .some((d) => d.name === first), 'vanished target');
    } else {
        check('C: the live measurement needed for the drift probe exists', false, 'no live data');
    }

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
