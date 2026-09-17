/**
 * M6 Split / Merge Reliability.
 *
 * The orchestration surface the UI talks to. Everything below it is reachable,
 * but a component should only need these.
 *
 * Architecture source of truth: research PR #26 at reviewed head
 * `7f4d71b60474df063f4a45710cf257aba7468bec` — `human-gate.json`,
 * `extract-contract.md`, `merge-contract.md`, `load-boundary.md`,
 * `object-graph-memory.md`, `structure-policy.md`, `limitations.md`. This
 * package reimplements those contracts; it does not import the research
 * prototypes, and no prototype ships.
 *
 * Bound to **pdf-lib 1.17.1** and **pako 2.1.0**. A version change in either
 * requires the Load Boundary verification again before M6's safety is treated as
 * holding (H11-B3-3, H11-B3-6).
 *
 * **Product limit values are provisional.** Blocker B4 — product load policy,
 * real-drawing compatibility, and the post-load structural product caps — is
 * OPEN, and blocks Ready, merge, release and production enablement. It does not
 * block implementation. See `policy.ts`.
 */
export {
    M6_STATUS,
    M6_LOSS_LABEL_JA,
    CONFIRMATION_REQUIRED_LOSSES,
    requiresConfirmation,
    isAcceptedIntake,
    INTAKE_RESULT,
    INTAKE_LABEL_JA,
    GENERIC_REFUSAL_JA,
    M6Error,
    isRunnable,
    m6SnapshotKey,
    addStructuralPlans,
    EMPTY_STRUCTURAL_PLAN,
} from './contracts';
export type {
    DestinationPolicy,
    ExtractPlan,
    ExtractResult,
    FieldCollisionPolicy,
    IntakeRecord,
    IntakeResultCode,
    LossRecord,
    M6Loss,
    M6Snapshot,
    M6SourceFacts,
    M6Status,
    MergeMetadataPolicy,
    MergePlan,
    MergeResult,
    ReadbackFacts,
    StructuralPlan,
} from './contracts';

export {
    PROVISIONAL_POLICY,
    PROVISIONAL_LOAD_BOUNDARY_LIMITS,
    PROVISIONAL_STRUCTURAL_CAPS,
    PROVISIONAL_MAX_OUTPUT_BYTES,
    MECHANISM_BOUNDS,
    policyFrom,
    assertEnforceablePolicy,
} from './policy';
export type {
    LoadBoundaryLimits,
    M6Policy,
    M6PolicyOverrides,
    OutputCeiling,
    StructuralCaps,
} from './policy';

export {
    inspectLoadBoundary,
    inflateBounded,
    LOAD_BOUNDARY_STAGES,
    LOAD_REFUSAL,
} from './load-boundary';
export type { LoadBoundaryStage, LoadBoundaryVerdict, LoadRefusalCode } from './load-boundary';

export {
    reachableGraph,
    planStructuralGraph,
    graphOfWholeDocument,
    checkStructuralCaps,
    checkCumulativeCaps,
    comparePlanWithActual,
} from './structural-graph';

export { readSourceFacts, classifyLoadError } from './source-facts';
export { describeOptionalContent, planOptionalContent } from './optional-content';
export { scanJavaScript, scanArtifactWideJavaScript, sanitizeJavaScript } from './javascript';
export { readForm, planFormForExtract, countOrphanWidgets } from './forms';
export { measureDestinationInvariants, planDestinations } from './destinations';
export { readbackArtifact, checkArtifactInvariants } from './readback';
export {
    censusIndirectObjects,
    countByCensus,
    collectByCensus,
    CENSUS_BUDGET,
} from './census';
export type { CensusNode, CensusOutcome } from './census';
export {
    censusAttachments,
    censusJavaScript,
    censusTagging,
    countUnreachable,
    pruneUnreachable,
    removeAttachmentsEverywhere,
    scrubAllJavaScript,
    stripTaggingEverywhere,
    carriesJavaScript,
    carriesEmbeddedFile,
} from './prune';
export {
    snapshotMetadata,
    applyMetadataSnapshot,
    metadataGaps,
    infoText,
} from './metadata';
export type { MetadataSnapshot } from './metadata';
export { extractOutputName, mergeOutputName, describeSelection } from './naming';

export { planExtract, runExtract } from './extract';
export type { ExtractOptions } from './extract';
export { intakeSources, planMerge, runMerge } from './merge';
export type { MergeInput, MergeOptions } from './merge';

export { extractInWorker, intakeInWorker, mergeInWorker, workerAvailable } from './worker/client';
export { WORKER_TIMEOUT_MS } from './worker/protocol';
