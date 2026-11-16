/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Shared by the research tests. Synthetic data only.
 */

import { seededUuidSource } from '../prototype/ids.mjs';
import { exportProject, importProject } from '../prototype/project-io.mjs';
import { buildSyntheticProject } from '../prototype/synthetic-project.mjs';

const encoder = new TextEncoder();

export const utf8 = (text) => encoder.encode(text);

/** A small reviewed Project, and the document its export writes. */
export function smallProject(options = {}) {
    const built = buildSyntheticProject({ sheets: 24, pagesPerSource: 6, duplicateEvery: 5, gapEvery: 7, variantEvery: 11, outlierEvery: 8, ...options });
    const fileIds = seededUuidSource(4242);
    const exported = exportProject(built.model, { now: built.now, newFileId: fileIds() });
    return { ...built, exported, document: exported.document, importNow: built.now + 60_000 };
}

/** A fresh, mutable copy of a valid document. */
export const cloneDocument = (document) => JSON.parse(JSON.stringify(document));

/** Import a document object (after a test has damaged it). */
export function importDocument(document, options) {
    return importProject(utf8(JSON.stringify(document)), options);
}

/** Import raw text, for damage JSON.stringify cannot express. */
export function importText(text, options) {
    return importProject(utf8(text), options);
}

export function expectRejected(assert, verdict, stage, code) {
    assert.equal(verdict.status, 'REJECTED', `expected a refusal, got ${verdict.status}`);
    assert.equal(verdict.stage, stage, `stage: ${JSON.stringify(verdict.problems?.slice(0, 2))}`);
    assert.equal(verdict.code, code, `code: ${JSON.stringify(verdict.problems?.slice(0, 2))}`);
    // A refusal carries no project. There is no partial import to fall back on.
    assert.equal(verdict.project, undefined);
}

export function expectAccepted(assert, verdict) {
    assert.equal(verdict.status, 'ACCEPTED', `expected acceptance, got ${verdict.stage}/${verdict.code} ${JSON.stringify(verdict.problems?.slice(0, 2))}`);
}

/** Characters that must never be written as literals in a source file. */
export const CHAR = Object.freeze({
    NUL: String.fromCodePoint(0x0000),
    BEL: String.fromCodePoint(0x0007),
    RLO: String.fromCodePoint(0x202e),
    LINE_SEPARATOR: String.fromCodePoint(0x2028),
    ZWSP: String.fromCodePoint(0x200b),
    BOM: String.fromCodePoint(0xfeff),
    BACKSLASH: String.fromCodePoint(0x5c),
});
