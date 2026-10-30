/**
 * 半透明レイヤ追加's overlay as a layer of its own.
 *
 * The overlay used to be plain page content, so the only way to see the drawing
 * without it was to keep the file from before. Now the overlay — and nothing
 * else — belongs to one new optional content group (OCG), which every PDF viewer
 * with a layer list can switch on and off. It starts ON and is not locked.
 *
 * What a document already has is left as it was. The new group is *appended* to
 * `/OCGs`, to the default configuration's `/Order` and to its `/ON`; nothing in
 * those arrays is removed or reordered, `/OFF`, `/Locked`, `/RBGroups`, `/AS`
 * and the alternate `/Configs` are not touched, and `/OCProperties` is never
 * replaced as a whole. The original page content and the annotations are not
 * moved into the group.
 *
 * A structure this code cannot read with certainty is a refusal, not a fallback
 * to the old unswitchable overlay: a person who asked for a layer they can turn
 * off must not be handed one they cannot.
 *
 *   /OCProperties not a dictionary            → refuse
 *   /OCGs missing, or not an array of OCGs    → refuse
 *   /D missing or not a dictionary            → refuse
 *   /D /Order missing or not an array         → refuse (where the new layer would be listed is unknowable)
 *   /D /BaseState not ON / OFF / Unchanged    → refuse
 *   /D /ON or /OFF present but not an array   → refuse
 *   /D /Intent that excludes /View            → refuse (the new layer would be ignored, always visible)
 *   a page's /Resources or /Properties not a dictionary → refuse
 */
import {
    PDFArray, PDFDict, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, PDFRef, PDFString,
} from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import { PLAN_STATUS, ProcessorError } from './contracts';

/** What the new layer is called in a viewer's layer list. */
export const OVERLAY_LAYER_NAME = 'PDF ArchiTools 半透明オーバーレイ';

/** The resource name the overlay's marked content refers to, before any suffix. */
const PROPERTIES_KEY_BASE = 'PATOverlay';

export interface OptionalContentFacts {
    /** `none`: no layers at all. `read`: layers this code can add to. */
    state: 'none' | 'read' | 'unreadable';
    /** How many groups `/OCGs` lists, when it could be read. */
    groupCount: number;
    /** Why it could not be read, in the user's language. */
    reason: string | null;
}

interface Readable {
    ocProperties: PDFDict;
    ocgs: PDFArray;
    defaults: PDFDict;
    order: PDFArray;
    names: string[];
}

class OptionalContentUnreadable extends Error {}

const lookup = (doc: PDFDocument, value: unknown): unknown => {
    try {
        return doc.context.lookup(value as never) ?? value;
    } catch {
        return value;
    }
};

const textOf = (value: unknown): string | null => (
    value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null
);

const nameOf = (value: unknown): string | null => (value instanceof PDFName ? value.asString() : null);

/**
 * Read the layer structure, or say exactly why it cannot be added to.
 *
 * `null` means the document has no `/OCProperties` at all.
 */
function readOptionalContent(doc: PDFDocument): Readable | null {
    const raw = doc.catalog.get(PDFName.of('OCProperties'));
    if (raw === undefined) return null;

    const ocProperties = lookup(doc, raw);
    if (!(ocProperties instanceof PDFDict)) {
        throw new OptionalContentUnreadable('レイヤー設定（/OCProperties）が辞書ではありません。');
    }

    const ocgs = lookup(doc, ocProperties.get(PDFName.of('OCGs')));
    if (!(ocgs instanceof PDFArray)) {
        throw new OptionalContentUnreadable('レイヤーの一覧（/OCGs）を読み取れません。');
    }
    const names: string[] = [];
    for (let i = 0; i < ocgs.size(); i += 1) {
        const entry = ocgs.get(i);
        const group = lookup(doc, entry);
        if (!(entry instanceof PDFRef) || !(group instanceof PDFDict)) {
            throw new OptionalContentUnreadable('レイヤーの一覧（/OCGs）に、レイヤーではない項目があります。');
        }
        const name = textOf(lookup(doc, group.get(PDFName.of('Name'))));
        if (name !== null) names.push(name);
    }

    const defaults = lookup(doc, ocProperties.get(PDFName.of('D')));
    if (!(defaults instanceof PDFDict)) {
        throw new OptionalContentUnreadable('レイヤーの既定の表示設定（/D）を読み取れません。');
    }

    const order = lookup(doc, defaults.get(PDFName.of('Order')));
    if (!(order instanceof PDFArray)) {
        throw new OptionalContentUnreadable(
            'レイヤーの表示順（/Order）が定義されていないため、既存レイヤーの見え方を変えずに新しいレイヤーを追加できません。',
        );
    }

    const baseStateRaw = defaults.get(PDFName.of('BaseState'));
    if (baseStateRaw !== undefined) {
        const baseState = nameOf(lookup(doc, baseStateRaw));
        if (baseState !== '/ON' && baseState !== '/OFF' && baseState !== '/Unchanged') {
            throw new OptionalContentUnreadable('レイヤーの既定の状態（/BaseState）を読み取れません。');
        }
    }

    for (const key of ['ON', 'OFF']) {
        const list = defaults.get(PDFName.of(key));
        if (list !== undefined && !(lookup(doc, list) instanceof PDFArray)) {
            throw new OptionalContentUnreadable(`レイヤーの表示状態の一覧（/${key}）を読み取れません。`);
        }
    }

    const intentRaw = defaults.get(PDFName.of('Intent'));
    if (intentRaw !== undefined) {
        const intent = lookup(doc, intentRaw);
        const intents: (string | null)[] = [];
        if (intent instanceof PDFArray) {
            for (let i = 0; i < intent.size(); i += 1) intents.push(nameOf(lookup(doc, intent.get(i))));
        } else {
            intents.push(nameOf(intent));
        }
        if (intents.some((value) => value === null)) {
            throw new OptionalContentUnreadable('レイヤーの用途（/Intent）を読み取れません。');
        }
        if (!intents.includes('/View') && !intents.includes('/All')) {
            throw new OptionalContentUnreadable(
                'このPDFの既定のレイヤー設定は表示用のレイヤーを扱わないため、追加したレイヤーを切り替えられません。',
            );
        }
    }

    return { ocProperties, ocgs, defaults, order, names };
}

/**
 * Each page's `/Properties`, which the overlay's marked content is named in.
 *
 * Read through the inheritable `/Resources` without normalising the page:
 * pdf-lib's normalisation writes to the page, and this is an inspection.
 */
function checkPageProperties(doc: PDFDocument): void {
    for (const page of doc.getPages()) {
        const resources = lookup(doc, page.node.getInheritableAttribute(PDFName.of('Resources')));
        if (resources === undefined) continue;
        if (!(resources instanceof PDFDict)) {
            throw new OptionalContentUnreadable('ページのリソース（/Resources）が辞書ではありません。');
        }
        const properties = resources.get(PDFName.of('Properties'));
        if (properties !== undefined && !(lookup(doc, properties) instanceof PDFDict)) {
            throw new OptionalContentUnreadable('ページのレイヤー参照（/Properties）が辞書ではありません。');
        }
    }
}

/** The facts the planner decides on. Never throws. */
export function inspectOptionalContent(doc: PDFDocument): OptionalContentFacts {
    try {
        const readable = readOptionalContent(doc);
        checkPageProperties(doc);
        if (!readable) return { state: 'none', groupCount: 0, reason: null };
        return { state: 'read', groupCount: readable.ocgs.size(), reason: null };
    } catch (error) {
        const reason = error instanceof OptionalContentUnreadable
            ? error.message
            : 'レイヤー設定を読み取れませんでした。';
        return { state: 'unreadable', groupCount: 0, reason };
    }
}

/** A name no existing layer has, so the two can be told apart in a layer list. */
function uniqueName(existing: string[]): string {
    if (!existing.includes(OVERLAY_LAYER_NAME)) return OVERLAY_LAYER_NAME;
    for (let n = 2; ; n += 1) {
        const candidate = `${OVERLAY_LAYER_NAME} (${n})`;
        if (!existing.includes(candidate)) return candidate;
    }
}

const unsafe = (reason: string) => new ProcessorError(
    `既存のレイヤー設定を安全に扱えないため、処理を中止しました: ${reason}`,
    PLAN_STATUS.OPTIONAL_CONTENT_UNSAFE,
);

/**
 * Add the overlay's group to the document and return its reference.
 *
 * The planner has already refused what `readOptionalContent` refuses; this reads
 * it again because a runner is handed bytes, not a plan, and must not write into
 * a structure it has not looked at itself.
 */
export function addOverlayGroup(doc: PDFDocument): { ref: PDFRef; name: string } {
    let readable: Readable | null;
    try {
        readable = readOptionalContent(doc);
    } catch (error) {
        throw unsafe(error instanceof OptionalContentUnreadable ? error.message : 'レイヤー設定を読み取れませんでした。');
    }

    const name = uniqueName(readable?.names ?? []);
    const ref = doc.context.register(doc.context.obj({
        Type: 'OCG',
        Name: PDFHexString.fromText(name),
    }));

    if (!readable) {
        doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
            OCGs: [ref],
            D: { Order: [ref], ON: [ref] },
        }));
        return { ref, name };
    }

    readable.ocgs.push(ref);
    readable.order.push(ref);
    const on = lookup(doc, readable.defaults.get(PDFName.of('ON')));
    if (on instanceof PDFArray) {
        on.push(ref);
    } else {
        readable.defaults.set(PDFName.of('ON'), doc.context.obj([ref]));
    }
    return { ref, name };
}

/**
 * The name this page's content uses for the group, added to its `/Properties`.
 *
 * Pages may share one resource dictionary, so an entry already pointing at this
 * group is reused; an existing entry under the same name that points anywhere
 * else is left alone and another name is chosen.
 */
function propertiesKeyFor(doc: PDFDocument, page: PDFPage, ref: PDFRef): PDFName {
    const { Resources } = page.node.normalizedEntries();
    const raw = Resources.get(PDFName.of('Properties'));
    let properties: PDFDict;
    if (raw === undefined) {
        properties = doc.context.obj({});
        Resources.set(PDFName.of('Properties'), properties);
    } else {
        const resolved = lookup(doc, raw);
        if (!(resolved instanceof PDFDict)) {
            throw unsafe('ページのレイヤー参照（/Properties）が辞書ではありません。');
        }
        properties = resolved;
    }

    for (const [key, value] of properties.entries()) {
        if (value instanceof PDFRef && value.toString() === ref.toString()) return key;
    }
    let key = PDFName.of(PROPERTIES_KEY_BASE);
    for (let n = 1; properties.has(key); n += 1) key = PDFName.of(`${PROPERTIES_KEY_BASE}${n}`);
    properties.set(key, ref);
    return key;
}

/**
 * Wrap what `draw` puts on the page in the group's marked content.
 *
 * pdf-lib has already closed the page's own content in `q … Q` by the time
 * anything is appended, so the marked content sits at the top level after it,
 * and annotations — which are not page content — still draw above it.
 */
export function drawInGroup(doc: PDFDocument, page: PDFPage, ref: PDFRef, draw: () => void): void {
    const key = propertiesKeyFor(doc, page, ref);
    page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), key]));
    draw();
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
}
