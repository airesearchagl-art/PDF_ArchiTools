/**
 * M7-P2-B2 static gate (B2-D01, N-C2 / N-C5 / N-C14): the forms that would
 * let the screen stand in for the evidence must not compile. Every line
 * marked @ts-expect-error has to be a type error; if one ever compiles, tsc
 * reports the directive as unused and the M7 foundation gate fails. The
 * runtime refuses the same forms when a cast gets them past the compiler
 * (scripts/smoke-m7-p2b2-checks.mjs). Never bundled; checked by
 * `tsc -p scripts/typecheck/tsconfig.json`.
 */
import type { FieldValues, Uuid } from '../../src/utils/drawing-set/model';
import type { DrawingSetStore } from '../../src/utils/drawing-set/workspace-store';
import { EvidenceHandle } from '../../src/utils/drawing-set/workspace-store';

declare const store: DrawingSetStore;
declare const sheetId: Uuid;
declare const values: FieldValues;
declare const handle: EvidenceHandle;

// What compiles: one Sheet, its values, and evidence the store issued.
export const allowed = [
    store.confirmSheet({ sheetId, values, evidence: handle }),
    store.withdrawConfirmation(sheetId),
];

export const refused = [
    // @ts-expect-error -- the screen cannot say the crops were shown: there is no field to say it with.
    store.confirmSheet({ sheetId, values, evidence: handle, shown: true }),
    // @ts-expect-error -- nor that they rendered.
    store.confirmSheet({ sheetId, values, evidence: handle, rendered: true }),
    // @ts-expect-error -- evidence is the store's handle, not an object describing it.
    store.confirmSheet({ sheetId, values, evidence: { sheetId, shown: true } }),
    // @ts-expect-error -- nor a boolean.
    store.confirmSheet({ sheetId, values, evidence: true }),
    // @ts-expect-error -- confirming needs evidence.
    store.confirmSheet({ sheetId, values }),
    // @ts-expect-error -- the store chooses the basis (always the observation); the screen does not pass one.
    store.confirmSheet({ sheetId, values, evidence: handle, basis: 'manual' }),
    // @ts-expect-error -- nor an old snapshot of the Drawing Set to confirm against (ADV-38-02).
    store.confirmSheet({ sheetId, values, evidence: handle, set: store.currentSet() }),
    // @ts-expect-error -- one Sheet per confirmation: there is no list of Sheets.
    store.confirmSheet({ sheetIds: [sheetId], values, evidence: handle }),
    // @ts-expect-error -- and no bulk confirmation at all.
    store.confirmSheets([sheetId]),
    // @ts-expect-error -- evidence is minted by the store only: the constructor wants the store's own token.
    new EvidenceHandle(sheetId),
];
