/**
 * Validate, normalise and snapshot the job, as one boundary.
 *
 * Two rules, both learned from getting them wrong:
 *
 * **Fail whole, not per object.** Validating each object as it is written is
 * not fail-closed — by the time the fourth is rejected, three are already in
 * the document. So the entire job is checked before a single operator is
 * emitted, and one problem stops all of it. A refusal produces no bytes.
 *
 * **The thing checked must be the thing written.** Validating the caller's
 * object and then writing from it leaves a window: whatever the caller mutates
 * in between is what actually gets written, and the bytes then correspond to no
 * validated state. So the job is deep-copied and frozen here, and the writer
 * reads nothing else.
 *
 * A silent drop is the one outcome worse than a refusal: the file comes back
 * looking complete and a mark the user made is gone, and nothing downstream can
 * tell it apart from a good save.
 */
import type {
    PageSnapshot, SaveAnnotation, SaveProblem, LayerSnapshot,
} from './types';
import { AnnotatorSaveError } from './types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Everything that must be true before a single operator is written. */
export function preflight(pages: PageSnapshot[], pageCount: number): SaveProblem[] {
    const problems: SaveProblem[] = [];
    const at = (
        page: number, layerId: string | undefined, objectId: string | undefined, message: string,
    ) => problems.push({ code: 'invalid-annotation', message, page, layerId, objectId });

    const seen = new Set<number>();
    for (const snapshot of pages ?? []) {
        const page = snapshot?.pageNumber;
        if (!Number.isInteger(page)) {
            at(page as number, undefined, undefined,
                `ページ番号が整数ではありません: ${JSON.stringify(page)}`);
            continue;
        }
        if (page < 1 || page > pageCount) {
            at(page, undefined, undefined,
                `この文書に ${page} ページ目はありません（全 ${pageCount} ページ）。`);
            continue;
        }
        // Two entries for one page would make "which one wins" a property of
        // iteration order, and the loser's marks would vanish silently.
        if (seen.has(page)) {
            at(page, undefined, undefined, `ページ ${page} の注釈が重複しています。`);
            continue;
        }
        seen.add(page);

        if (!Array.isArray(snapshot.layers)) {
            at(page, undefined, undefined, 'レイヤーの一覧が配列ではありません。');
            continue;
        }

        for (const layer of snapshot.layers) {
            if (!layer || typeof layer.layerId !== 'string' || !Array.isArray(layer.objects)) {
                at(page, layer?.layerId, undefined, 'レイヤーの内容を読み取れません。');
                continue;
            }
            for (const obj of layer.objects) {
                checkObject(obj, page, layer.layerId, at);
            }
        }
    }
    return problems;
}

type Reporter = (
    page: number, layerId: string | undefined, objectId: string | undefined, message: string,
) => void;

function checkObject(
    obj: SaveAnnotation, page: number, layerId: string, at: Reporter,
): void {
    const id = obj?.id ?? '(no id)';
    if (!obj || typeof obj !== 'object') {
        at(page, layerId, id, '注釈オブジェクトではありません。');
        return;
    }
    if (!['stroke', 'text', 'measure'].includes(obj.type)) {
        at(page, layerId, id, `未対応の注釈の種類です: ${JSON.stringify((obj as { type: unknown }).type)}`);
        return;
    }
    if (obj.opacity !== undefined && (!finite(obj.opacity) || obj.opacity < 0 || obj.opacity > 1)) {
        at(page, layerId, id, `不透明度が 0 から 1 の数値ではありません: ${JSON.stringify(obj.opacity)}`);
    }

    if (obj.type === 'stroke') {
        if (!Array.isArray(obj.points) || obj.points.length < 2) {
            at(page, layerId, id, '線の点が 2 点未満です。');
        } else if (!obj.points.every((p) => p && finite(p.x) && finite(p.y))) {
            at(page, layerId, id, '線の座標に数値でない値があります。');
        } else if (!obj.points.every((p) => p.pressure === undefined || finite(p.pressure))) {
            at(page, layerId, id, '筆圧に数値でない値があります。');
        }
        if (!finite(obj.lineWidth) || obj.lineWidth <= 0) {
            at(page, layerId, id, `線幅が正の数値ではありません: ${JSON.stringify(obj.lineWidth)}`);
        }
    } else if (obj.type === 'text') {
        if (typeof obj.text !== 'string') at(page, layerId, id, '文字列ではありません。');
        if (!finite(obj.x) || !finite(obj.y)) {
            at(page, layerId, id, '文字の座標に数値でない値があります。');
        }
        if (!finite(obj.fontSize) || obj.fontSize <= 0) {
            at(page, layerId, id, `文字サイズが正の数値ではありません: ${JSON.stringify(obj.fontSize)}`);
        }
    } else {
        if (!['line', 'poly', 'area'].includes(obj.subtype)) {
            at(page, layerId, id, `未対応の計測の種類です: ${JSON.stringify(obj.subtype)}`);
        }
        if (!Array.isArray(obj.points) || obj.points.length < 2) {
            at(page, layerId, id, '計測の点が 2 点未満です。');
        } else if (!obj.points.every((p) => p && finite(p.x) && finite(p.y))) {
            at(page, layerId, id, '計測の座標に数値でない値があります。');
        } else if (obj.subtype === 'area' && obj.points.length < 3) {
            at(page, layerId, id, '面積の点が 3 点未満です。');
        }
        if (!obj.scale || !finite(obj.scale.value) || obj.scale.value <= 0) {
            at(page, layerId, id, '計測の縮尺が正の数値ではありません。');
        }
    }
}

/** A validated, frozen copy. The only thing a writer is allowed to read. */
export interface SaveJob {
    readonly pageCount: number;
    readonly annotationCount: number;
    readonly visibleLayerCount: number;
    /** Layers for one page, bottom first. Empty for a page with nothing on it. */
    layersForPage(pageNumber: number): readonly LayerSnapshot[];
}

export function prepareSaveJob(pages: PageSnapshot[], pageCount: number): SaveJob {
    const problems = preflight(pages, pageCount);
    if (problems.length > 0) throw new AnnotatorSaveError(problems);

    // Deep copy, so the thing validated is the thing written.
    const copy = <T,>(value: T): T => (typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value)) as T);

    const byPage = new Map<number, readonly LayerSnapshot[]>();
    let annotationCount = 0;
    let visibleLayerCount = 0;

    for (const snapshot of pages ?? []) {
        const layers = snapshot.layers.map((layer) => Object.freeze({
            layerId: layer.layerId,
            objects: Object.freeze(copy(layer.objects)) as SaveAnnotation[],
        }));
        for (const layer of layers) {
            annotationCount += layer.objects.length;
            if (layer.objects.length > 0) visibleLayerCount += 1;
        }
        byPage.set(snapshot.pageNumber, Object.freeze(layers));
    }

    return Object.freeze({
        pageCount,
        annotationCount,
        visibleLayerCount,
        layersForPage: (pageNumber: number) => byPage.get(pageNumber) ?? [],
    });
}
