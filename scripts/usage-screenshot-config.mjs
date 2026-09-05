/**
 * The one place that knows what the usage-guide screenshots are supposed to be.
 *
 * The badge definitions in src/components/usageScreenshotBadges.ts are the
 * source of truth for which controls each marker covers. The capture script and
 * the gate both read them from here rather than keeping their own copies, so
 * there is no second list to fall out of step with the first.
 *
 * The checks below are pure functions over (config, geometry, files). Keeping
 * them free of a browser is what lets the gate run them against deliberately
 * broken inputs and prove they actually fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BADGES_TS = path.join(ROOT, 'src', 'components', 'usageScreenshotBadges.ts');
export const GEOMETRY_JSON = path.join(ROOT, 'src', 'components', 'usage-screenshot-geometry.json');
export const SCREENSHOT_DIR = path.join(ROOT, 'public', 'screenshots');

/**
 * Badge definitions, read out of the TypeScript.
 *
 * Parsed rather than imported because these scripts are plain Node and the
 * definitions live in a .ts file the app compiles. Duplicating them here would
 * defeat the point of having one source.
 */
export function readUsageScreenshotConfig(source = fs.readFileSync(BADGES_TS, 'utf8')) {
    const out = {};
    const screenRe = /(\w+):\s*\{\s*src:\s*'([^']+)',\s*state:\s*'([^']*)',\s*badges:\s*\[([\s\S]*?)\n {8}\],/g;
    let m;
    while ((m = screenRe.exec(source)) !== null) {
        const [, key, src, state, body] = m;
        const badges = [];
        const badgeRe = /targets:\s*\[([^\]]*)\][\s\S]*?desc:\s*'([^']*)'/g;
        let b;
        while ((b = badgeRe.exec(body)) !== null) {
            badges.push({
                targets: b[1].split(',').map((t) => t.trim().replace(/^'|'$/g, '')).filter(Boolean),
                desc: b[2],
            });
        }
        out[key] = { src, state, badges };
    }
    if (Object.keys(out).length === 0) {
        throw new Error('no screenshots parsed from usageScreenshotBadges.ts');
    }
    return out;
}

/** Every target one screen's badges name, deduplicated, in first-seen order. */
export function screenTargets(config, key) {
    return [...new Set((config[key]?.badges ?? []).flatMap((b) => b.targets))];
}

/** PNG dimensions straight from the header, plus the digest of the bytes. */
export function readPng(file) {
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file);
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
    return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
}

const setsEqual = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Everything that can be judged without a browser.
 *
 * Returns a list of problems; an empty list is the only pass. Written to fail
 * closed: a screen present on one side and missing on the other, a badge whose
 * targets are not all measured, a committed image whose bytes or dimensions do
 * not match what the capture recorded -- each is a problem, not a warning.
 */
export function validateArtifacts({ config, geometry, screenshotDir = SCREENSHOT_DIR }) {
    const problems = [];
    const configKeys = Object.keys(config).sort();
    const geometryKeys = Object.keys(geometry).sort();

    if (!setsEqual(configKeys, geometryKeys)) {
        problems.push({
            kind: 'screen-set',
            detail: `config ${JSON.stringify(configKeys)} vs geometry ${JSON.stringify(geometryKeys)}`,
        });
    }

    for (const key of configKeys) {
        const stored = geometry[key];
        if (!stored) continue;

        // RF1: the semantic target set and the measured target set must be the
        // same set. An extra measurement is as wrong as a missing one -- it
        // means the two lists have started to drift apart.
        const semantic = screenTargets(config, key).sort();
        const measured = Object.keys(stored.targets ?? {}).sort();
        if (!setsEqual(semantic, measured)) {
            problems.push({
                kind: 'target-set',
                screen: key,
                detail: `semantic ${JSON.stringify(semantic)} vs measured ${JSON.stringify(measured)}`,
                missing: semantic.filter((t) => !measured.includes(t)),
                extra: measured.filter((t) => !semantic.includes(t)),
            });
        }

        // RF2: a badge is drawn from all of its targets or none of them. A box
        // built from the half that happened to be measured points somewhere
        // nobody chose.
        for (const [i, badge] of (config[key].badges ?? []).entries()) {
            const absent = badge.targets.filter((t) => !stored.targets?.[t]);
            if (absent.length) {
                problems.push({
                    kind: 'partial-badge',
                    screen: key,
                    badge: i + 1,
                    detail: `badge ${i + 1} (${badge.desc}) has no geometry for ${JSON.stringify(absent)}`,
                });
            }
        }

        // RF3: the picture in the repository has to be the picture that was
        // measured. Without this, geometry can be recaptured while a stale PNG
        // stays committed, and every box would be right about a screen nobody
        // can see.
        const record = stored.screenshot;
        if (!record?.file || !record?.sha256) {
            problems.push({ kind: 'no-screenshot-record', screen: key, detail: JSON.stringify(record ?? null) });
            continue;
        }

        // The picture the guide asks for and the picture that was measured must
        // be the same file by name, before any question of its contents. A
        // correct digest of the wrong image is still the wrong image, and the
        // filename is the only thing that ties the served path to the record.
        const served = config[key].src;
        const expected = path.posix.basename(served);
        if (served !== `/screenshots/${expected}` || record.file !== expected) {
            problems.push({
                kind: 'screenshot-identity',
                screen: key,
                detail: `config src ${JSON.stringify(served)} vs record file ${JSON.stringify(record.file)}`,
            });
            continue;
        }
        const png = readPng(path.join(screenshotDir, record.file));
        if (!png) {
            problems.push({ kind: 'missing-png', screen: key, detail: record.file });
            continue;
        }
        if (png.sha256 !== record.sha256) {
            problems.push({
                kind: 'png-digest',
                screen: key,
                detail: `${record.file}: committed ${png.sha256.slice(0, 16)}… vs recorded ${record.sha256.slice(0, 16)}…`,
            });
        }
        if (png.width !== record.width || png.height !== record.height) {
            problems.push({
                kind: 'png-record-size',
                screen: key,
                detail: `${record.file}: file ${png.width}x${png.height} vs recorded ${record.width}x${record.height}`,
            });
        }
        if (png.width !== stored.frame?.width || png.height !== stored.frame?.height) {
            problems.push({
                kind: 'png-frame-size',
                screen: key,
                detail: `${record.file}: file ${png.width}x${png.height} vs frame ${stored.frame?.width}x${stored.frame?.height}`,
            });
        }
    }
    return problems;
}

/**
 * How far the live app has moved from what was recorded.
 *
 * A target that cannot be measured now counts as drift of its own: the control
 * it pointed at is gone, which is exactly the case a numbered box would go on
 * quietly mislabelling.
 */
export function compareLiveGeometry({ stored, live, tolerance }) {
    const drift = [];
    for (const name of Object.keys(stored.targets ?? {})) {
        const a = stored.targets[name];
        const b = live[name];
        if (!a) { drift.push({ name, reason: 'no stored rect' }); continue; }
        if (!b) { drift.push({ name, reason: 'not found in the live app' }); continue; }
        const edges = {
            left: Math.abs(a.left - b.left),
            top: Math.abs(a.top - b.top),
            right: Math.abs((a.left + a.width) - (b.left + b.width)),
            bottom: Math.abs((a.top + a.height) - (b.top + b.height)),
        };
        const max = Math.max(...Object.values(edges));
        if (max > tolerance) drift.push({ name, max: +max.toFixed(2), edges });
    }
    return drift;
}

/** Worst edge movement seen, whether or not it is past the tolerance. */
export function worstDrift({ stored, live }) {
    let worst = 0;
    let where = '-';
    for (const name of Object.keys(stored.targets ?? {})) {
        const a = stored.targets[name];
        const b = live[name];
        if (!a || !b) continue;
        const max = Math.max(
            Math.abs(a.left - b.left),
            Math.abs(a.top - b.top),
            Math.abs((a.left + a.width) - (b.left + b.width)),
            Math.abs((a.top + a.height) - (b.top + b.height)),
        );
        if (max > worst) { worst = max; where = name; }
    }
    return { worst, where };
}
