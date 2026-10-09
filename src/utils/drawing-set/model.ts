/**
 * The Drawing Set as M7-P1 holds it in memory.
 *
 * These types are the canonical contract's own shapes
 * (contracts/m7/portable-project.schema.json) for the parts P1 owns: Project,
 * Drawing Set, Source with its fingerprint, Sheet with its page facts. There is
 * no second, P1-only representation to reconcile later. What later phases own
 * is present in the shape P1 can honestly give it -- empty collections, `null`
 * observations -- and P1 never fills it in:
 *  - titleBlockProfiles, profileAssignment, observation, confirmation (M7-P2)
 *  - drawingRegisterReferences, analysisRuns, findings, decisions (M7-P3)
 *  - the file envelope, save and resume (M7-P4)
 *
 * Everything here is plain data. A File, its bytes, a PDF.js document, a
 * Worker or a Blob URL never goes into this model: those are runtime handles,
 * held next to it (see DrawingSetWorkspace), and gone with the session.
 *
 * Nothing a person removes is deleted (semantic contract, "Delete behaviour"):
 * removing a Source retires it, and with it every Sheet of it, so the lists
 * keep their entries and only the live ones are shown.
 */
import type { HeldCounts, IntakeRefusal } from './intake-policy';
import { IntakeStop, MAX_SHEETS, MAX_SOURCES, refusal } from './intake-policy';

/** Lower-case RFC 9562 UUID, minted by the app. */
export type Uuid = string;
/** UTC with milliseconds, exactly as Date.prototype.toISOString() writes it. */
export type Timestamp = string;
export type Sha256Hex = string;

export interface Project {
    id: Uuid;
    name: string;
    createdAt: Timestamp;
}

export interface SourceFingerprint {
    algorithm: 'SHA-256';
    sha256: Sha256Hex;
    byteLength: number;
    pageCount: number;
    recordedAt: Timestamp;
}

/** A replaced fingerprint. P1 never replaces one; the history stays empty. */
export interface RetiredFingerprint {
    fingerprint: SourceFingerprint;
    retiredAt: Timestamp;
    reason: 'REPLACED_BY_HUMAN';
}

export interface Source {
    id: Uuid;
    /** A label from File.name; never identity, never a path, never opened. */
    displayName: string;
    addedAt: Timestamp;
    retiredAt: Timestamp | null;
    fingerprint: SourceFingerprint;
    fingerprintHistory: RetiredFingerprint[];
}

export type PageKind = 'text-native' | 'scanned';
export type PageRotation = 0 | 90 | 180 | 270;

/** Read from the page boxes; no recognition involved. */
export interface PageFacts {
    sourceSha256: Sha256Hex;
    /** The visible box (CropBox within MediaBox), /Rotate undone, in PDF points. */
    uprightWidthPt: number;
    uprightHeightPt: number;
    rotate: PageRotation;
    kind: PageKind;
}

export interface Sheet {
    id: Uuid;
    sourceId: Uuid;
    pageNumber: number;
    createdAt: Timestamp;
    retiredAt: Timestamp | null;
    pageFacts: PageFacts | null;
    /** M7-P2. Always null in P1. */
    profileAssignment: null;
    /** M7-P2. Always null in P1. */
    observation: null;
    /** M7-P2. Always null in P1. */
    confirmation: null;
    /** M7-P2. Always empty in P1. */
    confirmationHistory: never[];
}

export interface DrawingSet {
    id: Uuid;
    name: string;
    createdAt: Timestamp;
    sources: Source[];
    /** M7-P2. Always empty in P1. */
    titleBlockProfiles: never[];
    sheets: Sheet[];
    /** M7-P3. Always empty in P1. */
    drawingRegisterReferences: never[];
    /** M7-P3. Always empty in P1. */
    analysisRuns: never[];
    /** M7-P3. Always empty in P1. */
    findings: never[];
    /** M7-P3. Always empty in P1. */
    decisions: never[];
}

/** One new, unsaved working session: a Project and its one Drawing Set. */
export interface DrawingSetSession {
    project: Project;
    drawingSet: DrawingSet;
}

export const DEFAULT_PROJECT_NAME = '図面管理プロジェクト';
export const DEFAULT_DRAWING_SET_NAME = '図面一式';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
/** The years the semantic contract accepts as a real instant (REL_TIMESTAMP_INVALID). */
const MIN_YEAR = 2000;
const MAX_YEAR = 2199;

/** A fresh lower-case UUID from crypto.randomUUID(), checked against the contract. */
export function mintUuid(): Uuid {
    const random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    const id = random ? random().toLowerCase() : '';
    if (!UUID_PATTERN.test(id)) {
        throw new IntakeStop(refusal('ID_UNAVAILABLE', 'このブラウザでは識別子を作成できないため、処理できません。'));
    }
    return id;
}

/**
 * Now, as the contract writes time. A clock outside 2000-2199 would write a
 * timestamp the contract refuses, so it is refused here instead of recorded.
 */
export function nowTimestamp(now: Date = new Date()): Timestamp {
    const year = now.getUTCFullYear();
    const text = Number.isFinite(now.getTime()) ? now.toISOString() : '';
    if (!TIMESTAMP_PATTERN.test(text) || year < MIN_YEAR || year > MAX_YEAR) {
        throw new IntakeStop(refusal('CLOCK_OUT_OF_RANGE', '端末の日時が正しくないため、処理できません。'));
    }
    return text;
}

/** A new, empty working session. Nothing is read from anywhere. */
export function createSession(): DrawingSetSession {
    const createdAt = nowTimestamp();
    return {
        project: { id: mintUuid(), name: DEFAULT_PROJECT_NAME, createdAt },
        drawingSet: {
            id: mintUuid(),
            name: DEFAULT_DRAWING_SET_NAME,
            createdAt,
            sources: [],
            titleBlockProfiles: [],
            sheets: [],
            drawingRegisterReferences: [],
            analysisRuns: [],
            findings: [],
            decisions: [],
        },
    };
}

export const isLive = (entity: { retiredAt: Timestamp | null }): boolean => entity.retiredAt === null;

export const liveSources = (set: DrawingSet): Source[] => set.sources.filter(isLive);
export const liveSheets = (set: DrawingSet): Sheet[] => set.sheets.filter(isLive);

/** What the intake gate counts: everything held, retired included. */
export const heldCounts = (set: DrawingSet): HeldCounts => ({
    sources: set.sources.length,
    sheets: set.sheets.length,
});

/** The live Source already bound to these bytes, if there is one. */
export const liveSourceWithContent = (set: DrawingSet, sha256: Sha256Hex): Source | null =>
    set.sources.find((source) => isLive(source) && source.fingerprint.sha256 === sha256) ?? null;

/** A Source and its Sheets, built off to the side and not yet in any Drawing Set. */
export interface SourceCandidate {
    source: Source;
    sheets: Sheet[];
}

/** The page facts of one page, as the inventory read them. */
export interface InventoriedPage {
    uprightWidthPt: number;
    uprightHeightPt: number;
    rotate: PageRotation;
    kind: PageKind;
}

/**
 * Build the Source and one Sheet per page, all at once. Called only when every
 * page has its facts: a Source is never built with some pages missing.
 */
export function buildSourceCandidate(input: {
    displayName: string;
    sha256: Sha256Hex;
    byteLength: number;
    recordedAt: Timestamp;
    pages: readonly InventoriedPage[];
}): SourceCandidate {
    const addedAt = nowTimestamp();
    const sourceId = mintUuid();
    const sheets: Sheet[] = input.pages.map((page, index) => ({
        id: mintUuid(),
        sourceId,
        pageNumber: index + 1,
        createdAt: addedAt,
        retiredAt: null,
        pageFacts: {
            sourceSha256: input.sha256,
            uprightWidthPt: page.uprightWidthPt,
            uprightHeightPt: page.uprightHeightPt,
            rotate: page.rotate,
            kind: page.kind,
        },
        profileAssignment: null,
        observation: null,
        confirmation: null,
        confirmationHistory: [],
    }));
    return {
        source: {
            id: sourceId,
            displayName: input.displayName,
            addedAt,
            retiredAt: null,
            fingerprint: {
                algorithm: 'SHA-256',
                sha256: input.sha256,
                byteLength: input.byteLength,
                pageCount: input.pages.length,
                recordedAt: input.recordedAt,
            },
            fingerprintHistory: [],
        },
        sheets,
    };
}

export type CommitResult =
    | { kind: 'committed'; drawingSet: DrawingSet }
    | { kind: 'duplicate'; existing: Source }
    | { kind: 'refused'; refusal: IntakeRefusal };

/**
 * Put a candidate into the Drawing Set in one step, or not at all.
 *
 * The gates are checked again against the Drawing Set as it is now, not as it
 * was when the file started: that is the state the commit has to be valid in.
 * Returns a new Drawing Set; the one passed in is never modified.
 */
export function commitSourceCandidate(set: DrawingSet, candidate: SourceCandidate): CommitResult {
    const existing = liveSourceWithContent(set, candidate.source.fingerprint.sha256);
    if (existing) return { kind: 'duplicate', existing };
    if (set.sources.length + 1 > MAX_SOURCES) {
        return { kind: 'refused', refusal: refusal('SOURCE_LIMIT', `この図面一式に追加できるファイル数（${MAX_SOURCES}）に達しています。`) };
    }
    if (set.sheets.length + candidate.sheets.length > MAX_SHEETS) {
        return {
            kind: 'refused',
            refusal: refusal('SHEET_LIMIT', `追加すると図面一式のページ数が上限（${MAX_SHEETS}）を超えるため、読み込めません（外したファイルのページも数えます）。`),
        };
    }
    return {
        kind: 'committed',
        drawingSet: {
            ...set,
            sources: [...set.sources, candidate.source],
            sheets: [...set.sheets, ...candidate.sheets],
        },
    };
}

/**
 * Retire a live Source and every live Sheet of it, at one instant. A retired
 * Source with a live Sheet is a state the contract refuses (REL_RETIRED_STATE),
 * so the two never happen apart. No other Source or Sheet is touched.
 */
export function retireSource(set: DrawingSet, sourceId: Uuid): DrawingSet {
    const target = set.sources.find((source) => source.id === sourceId);
    if (!target || !isLive(target)) return set;
    const retiredAt = nowTimestamp();
    return {
        ...set,
        sources: set.sources.map((source) => (source.id === sourceId ? { ...source, retiredAt } : source)),
        sheets: set.sheets.map((sheet) =>
            sheet.sourceId === sourceId && isLive(sheet) ? { ...sheet, retiredAt } : sheet,
        ),
    };
}
