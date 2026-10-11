/**
 * Populate public/pdfjs/ with the PDF.js data files 図面管理 (M7) opens its
 * documents with: the built-in CMaps, the standard font data, and the
 * WebAssembly decoders (OpenJPEG for JPX images, with its no-WebAssembly
 * fallback, and QCMS for ICC colour).
 *
 * Committed rather than fetched at run time, for the same reason as the OCR
 * assets (scripts/setup-ocr-assets.mjs): nothing a PDF needs may come from a
 * third party -- no unpkg, no jsDelivr, no CDN. They are copied byte for byte
 * out of the installed pdfjs-dist so they always match the PDF.js that reads
 * them, and ASSETS.json records which pdfjs-dist that was and the SHA-256 of
 * every file. The M7 foundation gate (scripts/smoke-m7-p1.mjs) fails when a
 * file differs from the installed pdfjs-dist, is missing, or is extra.
 *
 * Run after changing the pdfjs-dist version:  node scripts/setup-pdfjs-assets.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const OUT = path.join(ROOT, 'public', 'pdfjs');

/** The pdfjs-dist directories M7 serves: built-in CMaps, standard font data, and the JPX / ICC decoders. */
export const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm'];

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Every file under the served directories of `base`, as sorted forward-slash paths. */
export function listAssets(base, dirs = PDFJS_ASSET_DIRS) {
    const out = [];
    for (const dir of dirs) {
        const walk = (rel) => {
            for (const entry of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
                const child = `${rel}/${entry.name}`;
                if (entry.isDirectory()) walk(child);
                else out.push(child);
            }
        };
        walk(dir);
    }
    return out.sort();
}

function main() {
    const version = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8')).version;
    for (const dir of PDFJS_ASSET_DIRS) fs.rmSync(path.join(OUT, dir), { recursive: true, force: true });
    const files = {};
    for (const rel of listAssets(SOURCE)) {
        const bytes = fs.readFileSync(path.join(SOURCE, rel));
        fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
        fs.writeFileSync(path.join(OUT, rel), bytes);
        files[rel] = sha256(bytes);
    }
    const manifest = { pdfjsDist: version, dirs: PDFJS_ASSET_DIRS, files };
    fs.writeFileSync(path.join(OUT, 'ASSETS.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const total = Object.keys(files).reduce((sum, rel) => sum + fs.statSync(path.join(OUT, rel)).size, 0);
    console.log(`public/pdfjs: ${Object.keys(files).length} files, ${(total / 1024).toFixed(0)} KiB, from pdfjs-dist ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
