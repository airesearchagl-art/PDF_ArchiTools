/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Source rebinding: the seven cases the Task Packet names, and the corners
 * around them. Every "file" here is a made-up name and a hash of a label.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BINDING } from '../prototype/currency.mjs';
import { REBIND_NOTICE, bindingStates, candidatesWorthHashing, planRebind } from '../prototype/rebind.mjs';
import { sha256HexOfText } from '../prototype/sha256-stream.mjs';

const sha = (label) => sha256HexOfText(label);
const source = (id, displayName, content, byteLength = 1000) => ({
    id, displayName, fingerprint: { algorithm: 'SHA-256', sha256: sha(content), byteLength, pageCount: 3 },
});
const file = (candidateId, name, content, byteLength = 1000) => ({ candidateId, name, byteLength, sha256: sha(content) });
const state = (plan, id) => plan.bindings.get(id).state;

const A = source('src-a', 'architectural.pdf', 'bytes-a');
const B = source('src-b', 'structural.pdf', 'bytes-b');
const C = source('src-c', 'mechanical.pdf', 'bytes-c');

test('on resume, before any file is selected, every source is UNBOUND', () => {
    const plan = planRebind([A, B, C], []);
    for (const s of [A, B, C]) assert.equal(state(plan, s.id), BINDING.UNBOUND);
    assert.deepEqual(plan.notices, []);
});

test('case 1 -- same name, same bytes: MATCHED', () => {
    const plan = planRebind([A], [file('f1', 'architectural.pdf', 'bytes-a')]);
    assert.equal(state(plan, A.id), BINDING.MATCHED);
    assert.equal(plan.bindings.get(A.id).candidateId, 'f1');
    assert.deepEqual(plan.notices, []);
});

test('case 2 -- renamed, same bytes: MATCHED on the fingerprint, and the rename is said', () => {
    const plan = planRebind([A], [file('f1', 'A_set_FINAL(2).pdf', 'bytes-a')]);
    assert.equal(state(plan, A.id), BINDING.MATCHED);
    assert.deepEqual(plan.notices, [{ code: REBIND_NOTICE.RENAMED, sourceId: A.id, candidateId: 'f1' }]);
});

test('case 3 -- same name, different bytes: CHANGED, never MATCHED', () => {
    const plan = planRebind([A], [file('f1', 'architectural.pdf', 'bytes-a-edited')]);
    assert.equal(state(plan, A.id), BINDING.CHANGED);
    assert.equal(plan.bindings.get(A.id).candidateId, 'f1');
    assert.equal(plan.bindings.get(A.id).nominatedBy, 'NAME');
});

test('case 4 -- not selected: MISSING once a pass has been made, UNBOUND before', () => {
    assert.equal(state(planRebind([A, B], []), B.id), BINDING.UNBOUND);
    const plan = planRebind([A, B], [file('f1', 'architectural.pdf', 'bytes-a')]);
    assert.equal(state(plan, A.id), BINDING.MATCHED);
    assert.equal(state(plan, B.id), BINDING.MISSING);
});

test('case 5 -- more than one candidate by name: AMBIGUOUS, and no guess is made', () => {
    // Two changed files with the source's name (from two folders; the browser gives only the name).
    const plan = planRebind([A], [file('f1', 'architectural.pdf', 'edit-1'), file('f2', 'architectural.pdf', 'edit-2')]);
    assert.equal(state(plan, A.id), BINDING.AMBIGUOUS);
    assert.equal(plan.bindings.get(A.id).candidateId, null);
    assert.deepEqual(plan.bindings.get(A.id).nominees.sort(), ['f1', 'f2']);

    // Two sources with one name, one changed file: it could be either.
    const twin1 = source('src-1', 'plans.pdf', 'twin-1');
    const twin2 = source('src-2', 'plans.pdf', 'twin-2');
    const twins = planRebind([twin1, twin2], [file('f1', 'plans.pdf', 'something-new')]);
    assert.equal(state(twins, 'src-1'), BINDING.AMBIGUOUS);
    assert.equal(state(twins, 'src-2'), BINDING.AMBIGUOUS);
});

test('case 5 resolved -- a fingerprint match is never ambiguous, even among same-named files', () => {
    const twin1 = source('src-1', 'plans.pdf', 'twin-1');
    const twin2 = source('src-2', 'plans.pdf', 'twin-2');
    const plan = planRebind([twin1, twin2], [file('f1', 'plans.pdf', 'twin-2'), file('f2', 'plans.pdf', 'twin-1')]);
    assert.equal(plan.bindings.get('src-1').candidateId, 'f2');
    assert.equal(plan.bindings.get('src-2').candidateId, 'f1');
    assert.equal(state(plan, 'src-1'), BINDING.MATCHED);
    assert.equal(state(plan, 'src-2'), BINDING.MATCHED);
});

test('case 6 -- two physical copies of the same bytes: one content, MATCHED, the spare is reported', () => {
    const plan = planRebind([A], [file('f1', 'architectural.pdf', 'bytes-a'), file('f2', 'architectural - Copy.pdf', 'bytes-a')]);
    assert.equal(state(plan, A.id), BINDING.MATCHED);
    assert.equal(plan.bindings.get(A.id).candidateId, 'f1');
    assert.deepEqual(plan.notices, [{ code: REBIND_NOTICE.REDUNDANT_COPY, sourceId: A.id, candidateIds: ['f1', 'f2'] }]);
    // The spare is not left over as a "new" file, and is not bound to anything else.
    assert.deepEqual(plan.unassignedCandidates, []);
});

test('case 7 -- one of several sources changed: a partial rebind, source by source', () => {
    const plan = planRebind([A, B, C], [
        file('f1', 'architectural.pdf', 'bytes-a'),
        file('f2', 'structural.pdf', 'bytes-b-revised'),
        file('f3', 'mechanical.pdf', 'bytes-c'),
    ]);
    assert.deepEqual(Object.fromEntries(bindingStates(plan)), { [A.id]: BINDING.MATCHED, [B.id]: BINDING.CHANGED, [C.id]: BINDING.MATCHED });
});

test('the name is only ever a hint: it cannot turn different bytes into a match', () => {
    // B's content arrives under A's name, and A's own content is absent.
    const plan = planRebind([A, B], [file('f1', 'architectural.pdf', 'bytes-b')]);
    assert.equal(state(plan, B.id), BINDING.MATCHED);
    assert.equal(plan.bindings.get(B.id).candidateId, 'f1');
    // The file is spent on its true match; it is not also nominated for A.
    assert.equal(state(plan, A.id), BINDING.MISSING);
    assert.deepEqual(plan.notices, [{ code: REBIND_NOTICE.RENAMED, sourceId: B.id, candidateId: 'f1' }]);
});

test('name hints ignore case and Unicode composition, as file systems do', () => {
    const composed = 'résumé.pdf'.normalize('NFC');
    const decomposed = composed.normalize('NFD');
    assert.notEqual(composed, decomposed);
    const s = source('src-x', composed, 'old');
    assert.equal(state(planRebind([s], [file('f1', decomposed.toUpperCase(), 'new')]), 'src-x'), BINDING.CHANGED);
});

test('a file that is nobody\'s content and nobody\'s name is left for a person', () => {
    const plan = planRebind([A], [file('f1', 'architectural.pdf', 'bytes-a'), file('f2', 'something-else.pdf', 'unrelated')]);
    assert.deepEqual(plan.unassignedCandidates, ['f2']);
    assert.equal(state(plan, A.id), BINDING.MATCHED);
});

test('a person\'s assignment resolves MISSING or AMBIGUOUS into CHANGED -- never into MATCHED', () => {
    const files = [file('f1', 'architectural.pdf', 'edit-1'), file('f2', 'architectural.pdf', 'edit-2'), file('f3', 'renamed-structural.pdf', 'bytes-b-revised')];
    const before = planRebind([A, B], files);
    assert.equal(state(before, A.id), BINDING.AMBIGUOUS);
    assert.equal(state(before, B.id), BINDING.MISSING);

    const after = planRebind([A, B], files, [{ sourceId: A.id, candidateId: 'f2' }, { sourceId: B.id, candidateId: 'f3' }]);
    assert.equal(state(after, A.id), BINDING.CHANGED);
    assert.equal(after.bindings.get(A.id).candidateId, 'f2');
    assert.equal(after.bindings.get(A.id).nominatedBy, 'HUMAN');
    assert.equal(state(after, B.id), BINDING.CHANGED);
    // The file A did not take is nobody's now.
    assert.deepEqual(after.unassignedCandidates, ['f1']);
});

test('an assignment cannot override a fingerprint match or steal a matched file', () => {
    const files = [file('f1', 'architectural.pdf', 'bytes-a'), file('f2', 'structural.pdf', 'bytes-b')];
    const plan = planRebind([A, B], files, [{ sourceId: A.id, candidateId: 'f2' }, { sourceId: B.id, candidateId: 'f1' }]);
    assert.equal(plan.bindings.get(A.id).candidateId, 'f1');
    assert.equal(plan.bindings.get(B.id).candidateId, 'f2');
    assert.equal(state(plan, A.id), BINDING.MATCHED);
});

test('adding files later only ever improves a binding', () => {
    const first = planRebind([A, B], [file('f1', 'architectural.pdf', 'bytes-a')]);
    assert.equal(state(first, B.id), BINDING.MISSING);
    const second = planRebind([A, B], [file('f1', 'architectural.pdf', 'bytes-a'), file('f2', 'whatever.pdf', 'bytes-b')]);
    assert.equal(state(second, A.id), BINDING.MATCHED);
    assert.equal(state(second, B.id), BINDING.MATCHED);
});

test('the result does not depend on the order files were selected in', () => {
    const files = [
        file('f1', 'architectural.pdf', 'bytes-a'), file('f2', 'structural.pdf', 'bytes-b-revised'),
        file('f3', 'mechanical.pdf', 'edit-1'), file('f4', 'mechanical.pdf', 'edit-2'), file('f5', 'other.pdf', 'other'),
    ];
    const forward = planRebind([A, B, C], files);
    const backward = planRebind([C, B, A], [...files].reverse());
    for (const s of [A, B, C]) assert.equal(state(forward, s.id), state(backward, s.id));
    assert.deepEqual([...forward.unassignedCandidates].sort(), [...backward.unassignedCandidates].sort());
});

test('a file whose size no source has need not be read to know it cannot match', () => {
    const sources = [source('s1', 'a.pdf', 'x', 1000), source('s2', 'b.pdf', 'y', 2500)];
    const files = [{ candidateId: 'f1', name: 'a.pdf', byteLength: 1000 }, { candidateId: 'f2', name: 'b.pdf', byteLength: 2501 }, { candidateId: 'f3', name: 'c.pdf', byteLength: 2500 }];
    assert.deepEqual(candidatesWorthHashing(sources, files).map((f) => f.candidateId), ['f1', 'f3']);
    // Unhashed, it can still be nominated by name -- as CHANGED.
    const plan = planRebind(sources, [{ ...files[1], sha256: null }, file('f1', 'a.pdf', 'x', 1000)]);
    assert.equal(state(plan, 's1'), BINDING.MATCHED);
    assert.equal(state(plan, 's2'), BINDING.CHANGED);
});

test('rebinding reads the manifest and changes nothing', () => {
    const sources = [A, B, C].map((s) => structuredClone(s));
    const frozen = JSON.stringify(sources);
    planRebind(sources, [file('f1', 'architectural.pdf', 'changed'), file('f2', 'x.pdf', 'bytes-b')], [{ sourceId: C.id, candidateId: 'f1' }]);
    assert.equal(JSON.stringify(sources), frozen);
});
