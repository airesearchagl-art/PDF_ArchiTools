/**
 * M7-P2-B1 static gate (ADV-37-04): the forms that would let a claim stand in
 * for a read must not compile. Every line marked @ts-expect-error has to be a
 * type error; if one ever compiles, tsc reports the directive as unused and
 * the M7 foundation gate fails. The runtime refuses the same forms when a cast
 * gets them past the compiler (scripts/smoke-m7-p2a-checks.mjs, section 22b,
 * and smoke-m7-p2b1-checks.mjs, section 29) -- this file only shows the types
 * do not invite them. Never bundled; checked by
 * `tsc -p scripts/typecheck/tsconfig.json`.
 */
import type { RuntimeBindingLedger, SourceFileCheck } from '../../src/utils/drawing-set/currency';
import { confirmationCurrency, observationCurrency, verifiedBinding } from '../../src/utils/drawing-set/currency';
import type { FileDigest } from '../../src/utils/drawing-set/file-evidence';
import { confirmSheet } from '../../src/utils/drawing-set/metadata-confirmation';
import type { DrawingSet, FieldValues, Sheet, Uuid } from '../../src/utils/drawing-set/model';

declare const set: DrawingSet;
declare const sheet: Sheet;
declare const sourceId: Uuid;
declare const values: FieldValues;
declare const ledger: RuntimeBindingLedger;
declare const digest: FileDigest;
declare const file: Blob;
const request = { sheetId: sheet.id, values, basis: 'manual' as const };

// What compiles: the session's ledger, and a digest a read issued.
export const allowed = [
    confirmSheet(set, request, ledger),
    observationCurrency(set, sheet, ledger),
    confirmationCurrency(set, sheet, ledger),
    verifiedBinding(ledger, set, sourceId),
    ledger.presentVerified(set, sourceId, digest),
    ledger.settle(set, ledger.beginCheck(set), new Map<Uuid, SourceFileCheck>([[sourceId, { kind: 'READ', digest }]])),
    ledger.settle(set, ledger.beginCheck(set), new Map<Uuid, SourceFileCheck>([[sourceId, { kind: 'NOT_READ', file, reason: 'UNREADABLE' }]])),
];

const forgedMap = new Map([[sourceId, 'MATCHED' as const]]);
const lookalike = {
    sessionId: set.id,
    present: () => 'APPLIED' as const,
    presentVerified: () => 'APPLIED' as const,
    heldFile: () => file,
    beginCheck: () => ({ fileFor: () => file }),
    settle: () => new Map(),
    releaseRetired: () => { },
    bindings: () => forgedMap,
};

export const refused = [
    // @ts-expect-error -- a Map of bindings is not a ledger: confirmation asks the ledger itself.
    confirmSheet(set, request, forgedMap),
    // @ts-expect-error -- an object with a ledger's methods is not one: the class is nominal.
    confirmSheet(set, request, lookalike),
    // @ts-expect-error -- currency decides by the ledger, not by a snapshot of its bindings.
    observationCurrency(set, sheet, ledger.bindings(set)),
    // @ts-expect-error -- nor by a Map made by hand.
    confirmationCurrency(set, sheet, forgedMap),
    // @ts-expect-error -- a digest cannot be written by hand: it has a brand only a read gives it.
    ledger.presentVerified(set, sourceId, { sha256: 'a'.repeat(64), byteLength: 1 }),
    // @ts-expect-error -- presenting with evidence needs a digest, not a SHA-256.
    ledger.presentVerified(set, sourceId, 'a'.repeat(64)),
    // @ts-expect-error -- the P2-A result that stated its own verdict does not type-check any more.
    ledger.settle(set, ledger.beginCheck(set), new Map([[sourceId, { file, sha256: 'a'.repeat(64), binding: 'MATCHED' }]])),
    // @ts-expect-error -- a read result carries a digest, not a verdict.
    ledger.settle(set, ledger.beginCheck(set), new Map([[sourceId, { kind: 'READ', binding: 'MATCHED' }]])),
    // @ts-expect-error -- there is no reason that reads as MATCHED.
    ledger.settle(set, ledger.beginCheck(set), new Map([[sourceId, { kind: 'NOT_READ', file, reason: 'MATCHED' }]])),
    // @ts-expect-error -- a check is begun against the Drawing Set it checks.
    ledger.beginCheck(),
];
