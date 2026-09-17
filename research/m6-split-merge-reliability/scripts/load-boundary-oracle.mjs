/**
 * What pdf-lib 1.17.1 actually decodes when it loads a document.
 *
 * Run by `load-boundary-gate.mjs` in a child process — one document per process
 * when the document is hostile, the whole compatibility corpus in one process
 * when it is not. It patches the places pdf-lib's load path decodes or expands,
 * records what passes through them, and then calls the real
 * `PDFDocument.load`:
 *
 *   ByteStream.fromPDFRawStream      the decode on the load path; called for
 *                                    object streams and cross-reference streams
 *                                    (core/parser/ByteStream.js:58-60)
 *   decodePDFRawStream               every filter decode pdf-lib has, whoever
 *                                    calls it; during a load it must be called
 *                                    no more often than the line above, or a
 *                                    decode is reaching pdf-lib by another route
 *   DecodeStream.ensureBuffer        the buffer every decoder grows, whoever
 *                                    drives it
 *   PDFXRefStreamParser.parseEntries  one entry per declared object, whatever
 *                                    the decoded bytes hold
 *                                    (core/parser/PDFXRefStreamParser.js:53-85)
 *
 * The patches observe and pass the result through unchanged. This is the oracle
 * a pre-load boundary is checked against: for any document the boundary lets
 * through, pdf-lib must not decode more than the boundary counted. A document
 * this oracle gives no line for — because the process failed, hung and was
 * killed, or ran out of memory — has no result, and the gate treats that as a
 * failure, never as safe.
 *
 * Counts are EXACT. Peak RSS and elapsed time are MEASURED_ONLY.
 *
 * Usage: node load-boundary-oracle.mjs <pdf> [<pdf> ...]   — one JSON line each
 *        node load-boundary-oracle.mjs - < list             — paths one per line on stdin
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ByteStream = require('pdf-lib/cjs/core/parser/ByteStream').default;
const PDFXRefStreamParser = require('pdf-lib/cjs/core/parser/PDFXRefStreamParser').default;
const DecodeStream = require('pdf-lib/cjs/core/streams/DecodeStream').default;
const decodeModule = require('pdf-lib/cjs/core/streams/decode');
const { PDFDocument } = require('pdf-lib');

let decoded = [];
let loadDecodeCalls = 0;
let xrefEntries = 0;
let filterDecodeCalls = 0;
let maxDecodeBufferBytes = 0;

const originalFilterDecode = decodeModule.decodePDFRawStream;
decodeModule.decodePDFRawStream = function patchedDecodePDFRawStream(...args) {
    filterDecodeCalls += 1;
    return originalFilterDecode.apply(this, args);
};
const originalEnsureBuffer = DecodeStream.prototype.ensureBuffer;
DecodeStream.prototype.ensureBuffer = function patchedEnsureBuffer(requested) {
    const buffer = originalEnsureBuffer.call(this, requested);
    maxDecodeBufferBytes = Math.max(maxDecodeBufferBytes, buffer.byteLength);
    return buffer;
};

const originalDecode = ByteStream.fromPDFRawStream;
ByteStream.fromPDFRawStream = function patchedFromPDFRawStream(rawStream) {
    loadDecodeCalls += 1;
    const byteStream = originalDecode.call(this, rawStream);
    decoded.push(byteStream.length);
    return byteStream;
};
const originalParseEntries = PDFXRefStreamParser.prototype.parseEntries;
PDFXRefStreamParser.prototype.parseEntries = function patchedParseEntries() {
    const entries = originalParseEntries.call(this);
    xrefEntries += entries.length;
    return entries;
};

const files = process.argv[2] === '-'
    ? fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)
    : process.argv.slice(2);
for (const file of files) {
    decoded = [];
    loadDecodeCalls = 0;
    xrefEntries = 0;
    filterDecodeCalls = 0;
    maxDecodeBufferBytes = 0;
    const bytes = new Uint8Array(fs.readFileSync(file));
    const rssBefore = process.resourceUsage().maxRSS * 1024;
    const started = process.hrtime.bigint();
    let outcome;
    try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        outcome = { loaded: true, pages: doc.getPageCount() };
    } catch (error) {
        // pdf-lib's error classes compile to plain Error: name and constructor
        // both say "Error", so the message is the only thing that tells them apart.
        const message = String(error?.message ?? error);
        outcome = {
            loaded: false,
            error: String(error?.name ?? 'Error'),
            errorKind: /^Input document to `PDFDocument\.load` is encrypted/.test(message) ? 'ENCRYPTED_PDF' : 'LOAD_ERROR',
            message: message.slice(0, 160),
        };
    }
    process.stdout.write(`${JSON.stringify({
        file,
        ...outcome,
        loadDecodeCalls,
        decodeCalls: decoded.length,
        filterDecodeCalls,
        maxDecodeBufferBytes,
        decodedBytesTotal: decoded.reduce((s, n) => s + n, 0),
        maxDecodedBytes: decoded.reduce((m, n) => Math.max(m, n), 0),
        xrefEntries,
        peakRssGrowthMeasuredOnly: process.resourceUsage().maxRSS * 1024 - rssBefore,
        elapsedMsMeasuredOnly: Number(process.hrtime.bigint() - started) / 1e6,
    })}\n`);
}
