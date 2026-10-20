/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Referential integrity and lifecycle consistency: documents in which every
 * value has the right shape and the whole still means nothing.
 *
 * Run: node --test "research/m7-drawing-set-manager/tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { seededUuidSource } from '../prototype/ids.mjs';
import { cloneDocument, expectAccepted, expectRejected, importDocument, smallProject } from './helpers.mjs';

const { document: VALID, importNow: NOW } = smallProject();
const options = { now: NOW };
const unusedId = seededUuidSource(31337);
const damaged = (mutate) => { const copy = cloneDocument(VALID); mutate(copy); return importDocument(copy, options); };
const set = VALID.drawingSet;
const decidedFindingIndex = set.findings.findIndex((f) => set.decisions.some((d) => d.findingId === f.id));

test('the fixture is rich enough for these tests to mean something', () => {
    expectAccepted(assert, importDocument(VALID, options));
    assert.ok(set.sources.length >= 2 && set.sheets.length >= 10);
    assert.ok(set.findings.length >= 5 && set.decisions.length >= 2);
    assert.ok(decidedFindingIndex >= 0);
});

test('a duplicate id is refused for every kind of entity, and across kinds', () => {
    const cases = [
        ['source', (d) => { d.drawingSet.sources[1].id = d.drawingSet.sources[0].id; }],
        ['sheet', (d) => { d.drawingSet.sheets[1].id = d.drawingSet.sheets[0].id; }],
        ['finding', (d) => { d.drawingSet.findings[1].id = d.drawingSet.findings[0].id; }],
        ['decision', (d) => { d.drawingSet.decisions[1].id = d.drawingSet.decisions[0].id; }],
        ['run', (d) => { d.drawingSet.analysisRuns[1].id = d.drawingSet.analysisRuns[0].id; }],
        ['project = drawing set', (d) => { d.drawingSet.id = d.project.id; }],
        ['sheet = source', (d) => { d.drawingSet.sheets[0].id = d.drawingSet.sources[0].id; }],
        ['file = project', (d) => { d.projectFileId = d.project.id; }],
        ['decision = finding', (d) => { d.drawingSet.decisions[0].id = d.drawingSet.findings[0].id; }],
    ];
    for (const [name, mutate] of cases) {
        const verdict = damaged(mutate);
        assert.equal(verdict.status, 'REJECTED', name);
        assert.equal(verdict.stage, 'relations', name);
        assert.ok(verdict.problems.some((p) => p.code === 'REL_DUPLICATE_ID'), `${name}: ${JSON.stringify(verdict.problems.slice(0, 3))}`);
    }
});

test('a dangling sourceId is refused', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].sourceId = unusedId(); }), 'relations', 'REL_DANGLING_SOURCE');
    expectRejected(assert, damaged((d) => { d.drawingSet.findings.find((f) => f.basis.length > 0).basis[0].sourceId = unusedId(); }), 'relations', 'REL_DANGLING_SOURCE');
});

test('a dangling sheetId is refused', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.findings.find((f) => f.sheetIds.length > 0).sheetIds[0] = unusedId(); }), 'relations', 'REL_DANGLING_SHEET');
});

test('a dangling findingId is refused', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.decisions[0].findingId = unusedId(); }), 'relations', 'REL_DANGLING_FINDING');
});

test('a dangling profile or run is refused, and so is a run of the wrong kind', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].profileAssignment.profileId = unusedId(); }), 'relations', 'REL_DANGLING_PROFILE');
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].observation.runId = unusedId(); }), 'relations', 'REL_DANGLING_RUN');
    expectRejected(assert, damaged((d) => { d.drawingSet.findings[0].runId = unusedId(); }), 'relations', 'REL_DANGLING_RUN');
    const extraction = set.analysisRuns.find((r) => r.kind === 'EXTRACTION').id;
    const qa = set.analysisRuns.find((r) => r.kind === 'QA').id;
    expectRejected(assert, damaged((d) => { d.drawingSet.findings[0].runId = extraction; }), 'relations', 'REL_RUN_KIND');
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].observation.runId = qa; }), 'relations', 'REL_RUN_KIND');
    expectRejected(assert, damaged((d) => { d.drawingSet.analysisRuns[0].engine.name = 'drawing-set-qa'; }), 'relations', 'REL_RUN_KIND');
});

test('an observation cannot have been read under a profile revision that does not exist', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.sheets[0].observation.profile.profileRevision = 99; }), 'relations', 'REL_PROFILE_REVISION');
});

test('two live sheets cannot be the same page, and two live sources cannot be the same bytes', () => {
    expectRejected(assert, damaged((d) => {
        d.drawingSet.sheets[1].sourceId = d.drawingSet.sheets[0].sourceId;
        d.drawingSet.sheets[1].pageNumber = d.drawingSet.sheets[0].pageNumber;
    }), 'relations', 'REL_DUPLICATE_SHEET_PAGE');
    expectRejected(assert, damaged((d) => {
        d.drawingSet.sources[1].fingerprint.sha256 = d.drawingSet.sources[0].fingerprint.sha256;
    }), 'relations', 'REL_DUPLICATE_SOURCE_CONTENT');
});

test('retirement is consistent: a retired source has no live sheets, and a retired duplicate is not a duplicate', () => {
    const at = VALID.savedAt;
    expectRejected(assert, damaged((d) => { d.drawingSet.sources[0].retiredAt = at; }), 'relations', 'REL_RETIRED_STATE');
    // Retire source 0 and its sheets properly; a second copy of its bytes may then be live.
    const verdict = damaged((d) => {
        const source = d.drawingSet.sources[0];
        source.retiredAt = at;
        for (const sheet of d.drawingSet.sheets) if (sheet.sourceId === source.id) sheet.retiredAt = at;
        d.drawingSet.sources[1].fingerprint.sha256 = source.fingerprint.sha256;
    });
    expectAccepted(assert, verdict);
});

test('a live sheet cannot be assigned to a retired profile', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.titleBlockProfiles[0].retiredAt = VALID.savedAt; }), 'relations', 'REL_RETIRED_STATE');
    // Retired with its sheets unassigned, it is an ordinary state.
    expectAccepted(assert, damaged((d) => {
        d.drawingSet.titleBlockProfiles[0].retiredAt = VALID.savedAt;
        for (const sheet of d.drawingSet.sheets) sheet.profileAssignment = null;
    }));
});

test('a title-block rectangle must be non-empty and on its reference page', () => {
    const profile = (mutate) => damaged((d) => mutate(d.drawingSet.titleBlockProfiles[0]));
    expectRejected(assert, profile((p) => { p.fields.revision.right = p.fields.revision.left; }), 'relations', 'REL_RECT_INVALID');
    expectRejected(assert, profile((p) => { [p.fields.revision.top, p.fields.revision.bottom] = [p.fields.revision.bottom, p.fields.revision.top]; }), 'relations', 'REL_RECT_INVALID');
    expectRejected(assert, profile((p) => { p.fields.drawingTitle.right = p.referencePage.uprightWidthPt + 50; }), 'relations', 'REL_RECT_INVALID');
    expectRejected(assert, profile((p) => { p.referencePage.uprightWidthPt = 0; }), 'relations', 'REL_RECT_INVALID');
});

test('lineage is consistent', () => {
    expectRejected(assert, damaged((d) => { d.lineage.saveSequence = 2; }), 'relations', 'REL_LINEAGE');
    expectRejected(assert, damaged((d) => { d.lineage.previousProjectFileId = unusedId(); }), 'relations', 'REL_LINEAGE');
    expectRejected(assert, damaged((d) => { d.lineage.saveSequence = 2; d.lineage.previousProjectFileId = d.projectFileId; }), 'relations', 'REL_LINEAGE');
    expectRejected(assert, damaged((d) => {
        d.lineage.migratedFrom = { schemaVersion: 1, projectFileId: unusedId(), migratedAt: d.savedAt };
    }), 'relations', 'REL_LINEAGE');
});

test('a finding\'s subjects must fit its scope', () => {
    expectRejected(assert, damaged((d) => {
        const finding = d.drawingSet.findings.find((f) => f.scope === 'SHEET');
        finding.sheetIds.push(d.drawingSet.sheets.find((s) => s.id !== finding.sheetIds[0]).id);
    }), 'relations', 'REL_FINDING_SUBJECT');
    expectRejected(assert, damaged((d) => {
        const finding = d.drawingSet.findings.find((f) => f.sheetIds.length >= 2);
        finding.sheetIds[1] = finding.sheetIds[0];
    }), 'relations', 'REL_FINDING_SUBJECT');
});

test('a finding\'s lifecycle fields must agree with its state', () => {
    const qaRun = set.analysisRuns.find((r) => r.kind === 'QA').id;
    const at = VALID.savedAt;
    const life = (mutate) => damaged((d) => mutate(d.drawingSet.findings[0].lifecycle, d));
    expectRejected(assert, life((l) => { l.state = 'SUPERSEDED'; }), 'relations', 'REL_FINDING_LIFECYCLE');
    expectRejected(assert, life((l) => { l.state = 'NOT_REPRODUCED'; }), 'relations', 'REL_FINDING_LIFECYCLE');
    expectRejected(assert, life((l) => { l.closedAt = at; }), 'relations', 'REL_FINDING_LIFECYCLE');
    expectRejected(assert, life((l, d) => { l.supersededByFindingId = d.drawingSet.findings[1].id; }), 'relations', 'REL_FINDING_LIFECYCLE');
    // A properly closed finding is fine.
    expectAccepted(assert, life((l) => { l.state = 'NOT_REPRODUCED'; l.closedByRunId = qaRun; l.closedAt = at; }));
    expectRejected(assert, life((l) => { l.state = 'NOT_REPRODUCED'; l.closedByRunId = unusedId(); l.closedAt = at; }), 'relations', 'REL_DANGLING_RUN');
});

test('supersession points at a later statement of the same question and never loops', () => {
    const qaRun = set.analysisRuns.find((r) => r.kind === 'QA').id;
    const at = VALID.savedAt;
    const close = (finding, nextId) => { finding.lifecycle = { state: 'SUPERSEDED', supersededByFindingId: nextId, closedByRunId: qaRun, closedAt: at }; };

    expectRejected(assert, damaged((d) => { close(d.drawingSet.findings[0], unusedId()); }), 'relations', 'REL_DANGLING_FINDING');
    // Superseded by a finding about something else.
    expectRejected(assert, damaged((d) => { close(d.drawingSet.findings[0], d.drawingSet.findings[1].id); }), 'relations', 'REL_SUPERSEDE_CHAIN');
    // A -> B -> A.
    const loop = damaged((d) => {
        const [a, b] = d.drawingSet.findings;
        b.findingKey = a.findingKey; b.ruleId = a.ruleId;
        close(a, b.id); close(b, a.id);
    });
    assert.equal(loop.status, 'REJECTED');
    assert.ok(loop.problems.some((p) => p.code === 'REL_SUPERSEDE_CHAIN'));
    // A finding superseded by itself.
    const self = damaged((d) => { close(d.drawingSet.findings[0], d.drawingSet.findings[0].id); });
    assert.ok(self.problems.some((p) => p.code === 'REL_SUPERSEDE_CHAIN'));
});

test('at most one finding is ACTIVE for one question', () => {
    expectRejected(assert, damaged((d) => {
        d.drawingSet.findings[1].findingKey = d.drawingSet.findings[0].findingKey;
    }), 'relations', 'REL_FINDING_KEY_NOT_UNIQUE');
});

test('a decision is bound to the evidence of the finding it names', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.decisions[0].evidenceDigest = '0'.repeat(64); }), 'relations', 'REL_DECISION_EVIDENCE');
    // Re-pointing a decision at another finding is the same lie.
    expectRejected(assert, damaged((d) => {
        const decision = d.drawingSet.decisions[0];
        decision.findingId = d.drawingSet.findings.find((f) => f.id !== decision.findingId && f.evidenceDigest !== decision.evidenceDigest).id;
    }), 'relations', 'REL_DECISION_EVIDENCE');
});

test('a finding\'s decisions are numbered 1..n: no gap, no repeat', () => {
    const findingId = set.findings[decidedFindingIndex].id;
    const second = (d, sequence) => {
        const first = d.drawingSet.decisions.find((x) => x.findingId === findingId);
        d.drawingSet.decisions.push({ ...first, id: unusedId(), sequence, outcome: 'HOLD' });
    };
    expectAccepted(assert, damaged((d) => second(d, 2)));
    expectRejected(assert, damaged((d) => second(d, 1)), 'relations', 'REL_DECISION_SEQUENCE');
    expectRejected(assert, damaged((d) => second(d, 3)), 'relations', 'REL_DECISION_SEQUENCE');
    expectRejected(assert, damaged((d) => { d.drawingSet.decisions.find((x) => x.findingId === findingId).sequence = 2; }), 'relations', 'REL_DECISION_SEQUENCE');
});

test('a completed run records when it completed', () => {
    expectRejected(assert, damaged((d) => { d.drawingSet.analysisRuns[0].completedAt = null; }), 'relations', 'REL_RUN_STATE');
    expectAccepted(assert, damaged((d) => { d.drawingSet.analysisRuns[0].completedAt = null; d.drawingSet.analysisRuns[0].outcome = 'CANCELLED'; }));
});

test('a file is refused whole: one dangling decision does not become a file with one decision fewer', () => {
    const verdict = damaged((d) => { d.drawingSet.decisions.at(-1).findingId = unusedId(); });
    assert.equal(verdict.status, 'REJECTED');
    assert.equal(verdict.project, undefined);
    assert.equal(verdict.warnings, undefined);
});
