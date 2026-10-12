/**
 * Title-block profiles and which Sheets they cover, as operations on the
 * Drawing Set.
 *
 * A profile is the four field rectangles drawn on one reference page, and how
 * they move to a page of another size. Both are a person's: the rectangles
 * because they were drawn, the transfer model because neither model can be
 * inferred from a page (the Drawing Register's measurement). So nothing here
 * defaults a transfer model, and nothing assigns a Sheet that a person did not
 * name -- no fit score, no "the only profile there is", no sheet-size match.
 *
 * `revision` counts every change to what a profile reads: its rectangles, its
 * reference page, its transfer model. A rename reads nothing differently, so
 * it leaves the revision alone. Every observation and confirmation names the
 * revision it was made under, which is how they go stale when it moves.
 *
 * A profile a person removes is retired, never deleted: what was read and
 * confirmed under it keeps naming it. Retiring takes it off every live Sheet
 * at the same instant, because a live Sheet on a retired profile is a state
 * the contract refuses (REL_RETIRED_STATE).
 *
 * Every function returns a new Drawing Set, or a refusal and the set as it
 * was; the one passed in is never modified. Each change is all or nothing.
 */
import {
    MAX_PROFILE_REVISION, MAX_PROFILES, checkName, describeProblem,
} from './field-bounds';
import { MAX_PAGE_POINTS } from './intake-policy';
import type {
    DrawingSet, FieldName, Rect, Sheet, TitleBlockProfile, TransferModel, Uuid,
} from './model';
import { FIELD_NAMES, isLive, mintUuid, nowTimestamp } from './model';

/** The semantic contract's rectangle tolerance (GEOMETRY_EPSILON_PT). */
export const RECT_EPSILON_PT = 0.01;

export const TRANSFER_MODELS: readonly TransferModel[] = ['normalised', 'corner-anchored'];

export type ProfileRefusalCode =
    | 'PROFILE_LIMIT'
    | 'NAME_INVALID'
    | 'TRANSFER_MODEL_REQUIRED'
    | 'REFERENCE_PAGE_INVALID'
    | 'RECT_INVALID'
    | 'PROFILE_NOT_FOUND'
    | 'PROFILE_RETIRED'
    | 'REVISION_LIMIT'
    | 'SHEET_NOT_FOUND'
    | 'SHEET_RETIRED'
    | 'ASSIGNMENT_CONFLICT';

export interface ProfileRefusal {
    code: ProfileRefusalCode;
    message: string;
    field?: FieldName;
    /** ASSIGNMENT_CONFLICT: the Sheets already on another profile. */
    sheetIds?: Uuid[];
}

const refuse = (code: ProfileRefusalCode, message: string, extra: Partial<ProfileRefusal> = {}): { ok: false; refusal: ProfileRefusal } =>
    ({ ok: false, refusal: { code, message, ...extra } });

/** What a profile reads with: everything a revision counts. */
export interface ProfileGeometry {
    transferModel: TransferModel;
    referencePage: { uprightWidthPt: number; uprightHeightPt: number };
    fields: Record<FieldName, Rect>;
}

const isPoints = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PAGE_POINTS;

/**
 * Whether a geometry can be recorded, and why not. Mirrors the schema
 * (PagePoints 0..14400) and the semantic contract (REL_RECT_INVALID: a
 * positive reference page; each rectangle non-empty and on that page, within
 * 0.01 pt).
 */
export function checkProfileGeometry(input: {
    transferModel: unknown;
    referencePage: { uprightWidthPt: unknown; uprightHeightPt: unknown } | null | undefined;
    fields: Partial<Record<FieldName, Partial<Rect> | null | undefined>> | null | undefined;
}): ProfileRefusal | null {
    if (!TRANSFER_MODELS.includes(input.transferModel as TransferModel)) {
        return { code: 'TRANSFER_MODEL_REQUIRED', message: '表題欄の大きさの扱い（用紙に比例／実寸固定）を選んでください。' };
    }
    const width = input.referencePage?.uprightWidthPt;
    const height = input.referencePage?.uprightHeightPt;
    if (!isPoints(width) || !isPoints(height) || !(width > 0) || !(height > 0)) {
        return { code: 'REFERENCE_PAGE_INVALID', message: '基準ページの寸法が正しくありません。' };
    }
    for (const name of FIELD_NAMES) {
        const rect = input.fields?.[name];
        const ok = rect != null
            && isPoints(rect.left) && isPoints(rect.top) && isPoints(rect.right) && isPoints(rect.bottom)
            && rect.left < rect.right && rect.top < rect.bottom
            && rect.right <= width + RECT_EPSILON_PT && rect.bottom <= height + RECT_EPSILON_PT;
        if (!ok) {
            return { code: 'RECT_INVALID', message: '4つの項目すべてに、基準ページ内の範囲を指定してください。', field: name };
        }
    }
    return null;
}

const copyGeometry = (geometry: ProfileGeometry): ProfileGeometry => ({
    transferModel: geometry.transferModel,
    referencePage: {
        uprightWidthPt: geometry.referencePage.uprightWidthPt,
        uprightHeightPt: geometry.referencePage.uprightHeightPt,
    },
    fields: Object.fromEntries(FIELD_NAMES.map((name) => {
        const { left, top, right, bottom } = geometry.fields[name];
        return [name, { left, top, right, bottom }];
    })) as Record<FieldName, Rect>,
});

const sameGeometry = (a: ProfileGeometry, b: ProfileGeometry): boolean =>
    a.transferModel === b.transferModel
    && a.referencePage.uprightWidthPt === b.referencePage.uprightWidthPt
    && a.referencePage.uprightHeightPt === b.referencePage.uprightHeightPt
    && FIELD_NAMES.every((name) => {
        const x = a.fields[name];
        const y = b.fields[name];
        return x.left === y.left && x.top === y.top && x.right === y.right && x.bottom === y.bottom;
    });

export const findProfile = (set: DrawingSet, profileId: Uuid): TitleBlockProfile | null =>
    set.titleBlockProfiles.find((profile) => profile.id === profileId) ?? null;

export const liveProfiles = (set: DrawingSet): TitleBlockProfile[] => set.titleBlockProfiles.filter(isLive);

const nameRefusal = (name: string): { ok: false; refusal: ProfileRefusal } | null => {
    const problem = checkName(name);
    return problem ? refuse('NAME_INVALID', `プロファイル名: ${describeProblem(problem)}`) : null;
};

const replaceProfile = (set: DrawingSet, next: TitleBlockProfile): DrawingSet => ({
    ...set,
    titleBlockProfiles: set.titleBlockProfiles.map((profile) => (profile.id === next.id ? next : profile)),
});

const liveProfileOrRefusal = (set: DrawingSet, profileId: Uuid): TitleBlockProfile | { ok: false; refusal: ProfileRefusal } => {
    const profile = findProfile(set, profileId);
    if (!profile) return refuse('PROFILE_NOT_FOUND', 'プロファイルが見つかりません。');
    if (!isLive(profile)) return refuse('PROFILE_RETIRED', '廃止したプロファイルは変更・割当できません。');
    return profile;
};

/**
 * A new profile at revision 1. The transfer model is required: there is no
 * default to fall back on. The profile limit counts retired profiles too,
 * because they stay in the Drawing Set.
 */
export function createProfile(
    set: DrawingSet,
    input: { name: string; transferModel: TransferModel; referencePage: ProfileGeometry['referencePage']; fields: Record<FieldName, Rect> },
): { ok: true; drawingSet: DrawingSet; profile: TitleBlockProfile } | { ok: false; refusal: ProfileRefusal } {
    if (set.titleBlockProfiles.length >= MAX_PROFILES) {
        return refuse('PROFILE_LIMIT', `この図面一式に作成できるプロファイル数（${MAX_PROFILES}）に達しています（廃止したものも数えます）。`);
    }
    const badName = nameRefusal(input.name);
    if (badName) return badName;
    const geometryProblem = checkProfileGeometry(input);
    if (geometryProblem) return { ok: false, refusal: geometryProblem };
    const at = nowTimestamp();
    const profile: TitleBlockProfile = {
        id: mintUuid(),
        name: input.name,
        revision: 1,
        ...copyGeometry(input),
        createdAt: at,
        updatedAt: at,
        retiredAt: null,
    };
    return { ok: true, drawingSet: { ...set, titleBlockProfiles: [...set.titleBlockProfiles, profile] }, profile };
}

/** A new name. The revision does not move: nothing reads differently. */
export function renameProfile(
    set: DrawingSet, profileId: Uuid, name: string,
): { ok: true; drawingSet: DrawingSet; changed: boolean } | { ok: false; refusal: ProfileRefusal } {
    const profile = liveProfileOrRefusal(set, profileId);
    if ('ok' in profile) return profile;
    const badName = nameRefusal(name);
    if (badName) return badName;
    if (profile.name === name) return { ok: true, drawingSet: set, changed: false };
    return { ok: true, drawingSet: replaceProfile(set, { ...profile, name, updatedAt: nowTimestamp() }), changed: true };
}

/**
 * Change what a profile reads with. Any difference in the rectangles, the
 * reference page or the transfer model is a new revision; no difference is no
 * change. Observations and confirmations made under the old revision then go
 * stale (STALE_PROFILE); they are not touched.
 */
export function reviseProfile(
    set: DrawingSet, profileId: Uuid, change: Partial<ProfileGeometry>,
): { ok: true; drawingSet: DrawingSet; changed: boolean; revision: number } | { ok: false; refusal: ProfileRefusal } {
    const profile = liveProfileOrRefusal(set, profileId);
    if ('ok' in profile) return profile;
    const merged = {
        transferModel: change.transferModel ?? profile.transferModel,
        referencePage: change.referencePage ?? profile.referencePage,
        fields: change.fields ?? profile.fields,
    };
    const geometryProblem = checkProfileGeometry(merged);
    if (geometryProblem) return { ok: false, refusal: geometryProblem };
    const next = copyGeometry(merged);
    if (sameGeometry(next, profile)) return { ok: true, drawingSet: set, changed: false, revision: profile.revision };
    if (profile.revision >= MAX_PROFILE_REVISION) {
        return refuse('REVISION_LIMIT', 'このプロファイルはこれ以上変更できません。新しいプロファイルを作成してください。');
    }
    const revision = profile.revision + 1;
    return {
        ok: true,
        drawingSet: replaceProfile(set, { ...profile, ...next, revision, updatedAt: nowTimestamp() }),
        changed: true,
        revision,
    };
}

/**
 * Retire a profile, and take it off every live Sheet at the same instant.
 * Observations and confirmations that name it keep naming it.
 */
export function retireProfile(
    set: DrawingSet, profileId: Uuid,
): { ok: true; drawingSet: DrawingSet; unassignedSheetIds: Uuid[] } | { ok: false; refusal: ProfileRefusal } {
    const profile = liveProfileOrRefusal(set, profileId);
    if ('ok' in profile) return profile;
    const retiredAt = nowTimestamp();
    const unassignedSheetIds: Uuid[] = [];
    const sheets = set.sheets.map((sheet) => {
        if (!isLive(sheet) || sheet.profileAssignment?.profileId !== profileId) return sheet;
        unassignedSheetIds.push(sheet.id);
        return { ...sheet, profileAssignment: null };
    });
    return {
        ok: true,
        drawingSet: { ...replaceProfile(set, { ...profile, retiredAt }), sheets },
        unassignedSheetIds,
    };
}

const liveSheetsOrRefusal = (set: DrawingSet, sheetIds: readonly Uuid[]): Map<Uuid, Sheet> | { ok: false; refusal: ProfileRefusal } => {
    const byId = new Map(set.sheets.map((sheet) => [sheet.id, sheet]));
    const chosen = new Map<Uuid, Sheet>();
    for (const id of sheetIds) {
        const sheet = byId.get(id);
        if (!sheet) return refuse('SHEET_NOT_FOUND', 'ページが見つかりません。', { sheetIds: [id] });
        if (!isLive(sheet)) return refuse('SHEET_RETIRED', '外したファイルのページには割り当てられません。', { sheetIds: [id] });
        chosen.set(id, sheet);
    }
    return chosen;
};

/**
 * Put the named Sheets under a profile.
 *
 * A Sheet already on another profile is a conflict: the whole request is
 * refused and the conflicting Sheets are named, unless `replace` says the
 * person has seen them and means to move them. Moving is a decision, and a
 * silent overwrite would let a range selection re-key Sheets someone had
 * already answered for. A Sheet already on this profile keeps its assignment
 * and the moment it was made.
 */
export function assignProfile(
    set: DrawingSet, sheetIds: readonly Uuid[], profileId: Uuid, options: { replace?: boolean } = {},
): { ok: true; drawingSet: DrawingSet; assigned: Uuid[]; replaced: Uuid[]; unchanged: Uuid[] } | { ok: false; refusal: ProfileRefusal } {
    const profile = liveProfileOrRefusal(set, profileId);
    if ('ok' in profile) return profile;
    const chosen = liveSheetsOrRefusal(set, sheetIds);
    if ('ok' in chosen) return chosen;
    const conflicts = [...chosen.values()]
        .filter((sheet) => sheet.profileAssignment !== null && sheet.profileAssignment.profileId !== profileId)
        .map((sheet) => sheet.id);
    if (conflicts.length > 0 && !options.replace) {
        return refuse('ASSIGNMENT_CONFLICT', `${conflicts.length}ページには別のプロファイルが割り当てられています。置き換えるか確認してください。`, { sheetIds: conflicts });
    }
    const confirmedAt = nowTimestamp();
    const assigned: Uuid[] = [];
    const replaced: Uuid[] = [];
    const unchanged: Uuid[] = [];
    const sheets = set.sheets.map((sheet) => {
        if (!chosen.has(sheet.id)) return sheet;
        if (sheet.profileAssignment?.profileId === profileId) {
            unchanged.push(sheet.id);
            return sheet;
        }
        (sheet.profileAssignment ? replaced : assigned).push(sheet.id);
        return { ...sheet, profileAssignment: { profileId, confirmedAt } };
    });
    return { ok: true, drawingSet: { ...set, sheets }, assigned, replaced, unchanged };
}

/** Take the named Sheets off whatever profile they are on. */
export function unassignProfile(
    set: DrawingSet, sheetIds: readonly Uuid[],
): { ok: true; drawingSet: DrawingSet; cleared: Uuid[] } | { ok: false; refusal: ProfileRefusal } {
    const chosen = liveSheetsOrRefusal(set, sheetIds);
    if ('ok' in chosen) return chosen;
    const cleared: Uuid[] = [];
    const sheets = set.sheets.map((sheet) => {
        if (!chosen.has(sheet.id) || sheet.profileAssignment === null) return sheet;
        cleared.push(sheet.id);
        return { ...sheet, profileAssignment: null };
    });
    return { ok: true, drawingSet: { ...set, sheets }, cleared };
}
