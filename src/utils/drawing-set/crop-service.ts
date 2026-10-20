/**
 * The original-drawing crops a confirmation is made against (M7-P2-B2,
 * HD-B-03 A): the four field rectangles of a Sheet's profile, drawn from the
 * preview's own document -- the one the owner opened from bytes whose SHA-256
 * it checked -- exactly as extraction reads them.
 *
 *  - Where: the profile's rectangles moved onto the page by the Drawing
 *    Register's own transfer (applyProfile), against the page's upright size
 *    as PDF.js gives it at rotation 0 -- the space extraction reads in.
 *  - How: the Drawing Register's renderRegion, at its fixed 300 dpi
 *    (REGISTER_DPI) and rotation 0, so the pixels are those of the region the
 *    recogniser was given. Never at the viewer's zoom or the screen's pixel
 *    ratio. The page's /Rotate is applied afterwards, for display only, by
 *    CSS (SF-01).
 *  - Within: one page section of the preview owner (withPage), so a crop and
 *    the viewer never draw from the document at once, and every render here
 *    is the owner's to stop when the document closes.
 *  - Bounded (H-16), before any canvas exists: no side over 8192 px, no field
 *    over 4,000,000 px, the four together no more than 16,777,216 px. Past
 *    any of them the crop is refused whole (CROP_TOO_LARGE) -- never drawn
 *    smaller, never replaced by the whole page, never cut from the viewer's
 *    canvas (which is scaled to fit the screen).
 *  - Checked after: each canvas is exactly the size worked out beforehand,
 *    or the crop is refused (CROP_NOT_SHOWN).
 *
 * The canvases are this module's caller's to place and to release
 * (releaseCrop): none is turned into an image, a data URL or an object URL,
 * and nothing here is stored anywhere.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { REGISTER_DPI, releaseRegion, renderRegion } from '../pdf-textifier/drawing-register-geometry';
import { applyProfile } from '../pdf-textifier/drawing-register-template';
import type { FieldName, Rect, TitleBlockProfile } from './model';
import { FIELD_NAMES } from './model';
import type { PreviewDocumentOwner, PreviewPage } from './preview-document';
import { ENGINE_FIELD, toTemplateProfile } from './register-adapter';

/** H-16 (Human adopted 2026-10-18). */
export const CROP_LIMITS = {
    dpi: REGISTER_DPI,
    maxSidePixels: 8192,
    maxFieldPixels: 4_000_000,
    maxTotalPixels: 16_777_216,
} as const;

export type CropRefusalCode = 'CROP_TOO_LARGE' | 'CROP_NOT_SHOWN';

export class CropError extends Error {
    readonly code: CropRefusalCode;
    constructor(code: CropRefusalCode, message: string) {
        super(message);
        this.name = 'CropError';
        this.code = code;
    }
}

export const CROP_MESSAGES: Record<CropRefusalCode, string> = {
    CROP_TOO_LARGE: 'この範囲は大きすぎるため、原図を表示できません。プロファイルの範囲を小さくしてください。',
    CROP_NOT_SHOWN: '原図を表示できませんでした。',
};

/** One field's crop as worked out before drawing: where, and how many pixels. */
export interface CropFieldPlan {
    /** Upright points, clamped to the page, as renderRegion clamps them. */
    rect: Rect;
    width: number;
    height: number;
}

export interface CropPlan {
    uprightWidthPt: number;
    uprightHeightPt: number;
    fields: Record<FieldName, CropFieldPlan>;
    totalPixels: number;
    /** The first limit passed, if any. */
    exceeds: null | { field: FieldName | null; limit: 'side' | 'field' | 'total' };
}

/**
 * Where a profile's four rectangles fall on a page of this upright size, and
 * the canvas each would take at 300 dpi. The arithmetic is renderRegion's own
 * (clamp to the page, then ceil at the scale, at least 1 px); nothing is drawn.
 */
export function planCrop(profile: TitleBlockProfile, upright: { width: number; height: number }): CropPlan {
    const regions = applyProfile(toTemplateProfile(profile), { pageNumber: 0, uprightWidth: upright.width, uprightHeight: upright.height });
    const scale = CROP_LIMITS.dpi / 72;
    const fields = {} as Record<FieldName, CropFieldPlan>;
    let totalPixels = 0;
    let exceeds: CropPlan['exceeds'] = null;
    for (const name of FIELD_NAMES) {
        const region = regions[ENGINE_FIELD[name]];
        const rect: Rect = {
            left: Math.max(0, Math.min(region.left, upright.width)),
            right: Math.max(0, Math.min(region.right, upright.width)),
            top: Math.max(0, Math.min(region.top, upright.height)),
            bottom: Math.max(0, Math.min(region.bottom, upright.height)),
        };
        const width = Math.max(1, Math.ceil((rect.right - rect.left) * scale));
        const height = Math.max(1, Math.ceil((rect.bottom - rect.top) * scale));
        fields[name] = { rect, width, height };
        totalPixels += width * height;
        if (!exceeds && (width > CROP_LIMITS.maxSidePixels || height > CROP_LIMITS.maxSidePixels)) exceeds = { field: name, limit: 'side' };
        if (!exceeds && width * height > CROP_LIMITS.maxFieldPixels) exceeds = { field: name, limit: 'field' };
    }
    if (!exceeds && totalPixels > CROP_LIMITS.maxTotalPixels) exceeds = { field: null, limit: 'total' };
    return { uprightWidthPt: upright.width, uprightHeightPt: upright.height, fields, totalPixels, exceeds };
}

/** The four crops of one Sheet, drawn. */
export interface CropResult {
    doc: PDFDocumentProxy;
    plan: CropPlan;
    canvases: Record<FieldName, HTMLCanvasElement>;
}

/** CSS pixels per crop pixel on screen: the 300 dpi crop shown at 150 dpi. The bitmap is never redrawn for the screen. */
export const CROP_DISPLAY_SCALE = 0.5;

const FRAME_CLASS = 'ds-crop-frame';

/**
 * Put one crop canvas in a slot, turned the way the page is shown (its
 * /Rotate, clockwise, as the viewer shows it). Only the canvas's CSS box
 * turns; the bitmap stays the upright one that was drawn.
 */
export function mountCrop(canvas: HTMLCanvasElement, slot: HTMLElement, rotate: number): void {
    const width = canvas.width * CROP_DISPLAY_SCALE;
    const height = canvas.height * CROP_DISPLAY_SCALE;
    const quarter = ((rotate % 360) + 360) % 180 === 90;
    const frame = document.createElement('div');
    frame.className = FRAME_CLASS;
    frame.style.position = 'relative';
    frame.style.width = `${quarter ? height : width}px`;
    frame.style.height = `${quarter ? width : height}px`;
    canvas.style.position = 'absolute';
    canvas.style.left = '50%';
    canvas.style.top = '50%';
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.transform = `translate(-50%, -50%) rotate(${rotate}deg)`;
    canvas.dataset.dsCropCanvas = '';
    frame.append(canvas);
    slot.replaceChildren(frame);
}

/** Give a crop's canvases back to the browser, and take them off the screen. Idempotent. */
export function releaseCrop(canvases: Partial<Record<FieldName, HTMLCanvasElement>> | null): void {
    if (!canvases) return;
    for (const name of FIELD_NAMES) {
        const canvas = canvases[name];
        if (!canvas) continue;
        const frame = canvas.parentElement;
        canvas.remove();
        if (frame?.classList.contains(FRAME_CLASS)) frame.remove();
        releaseRegion(canvas);
    }
}

/**
 * Whether a placed crop canvas is on screen as far as the page can tell: in
 * the document, inside `panel`, not hidden by display, visibility or opacity,
 * and with a box of some size. Scrolled out of view inside the panel still
 * counts as shown. This is what the app put there, not proof anyone looked.
 */
export function cropShown(canvas: HTMLCanvasElement, panel: HTMLElement): boolean {
    if (!canvas.isConnected || !panel.isConnected || !panel.contains(canvas)) return false;
    if (canvas.width === 0 || canvas.height === 0) return false;
    // A browser that cannot say whether it is hidden is not taken at its word.
    if (typeof canvas.checkVisibility !== 'function') return false;
    if (!canvas.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = canvas.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
}

/**
 * Draw the four crops of page `pageNumber` of `doc` under `profile`, in one
 * page section of `owner`. Rejects with CropError for a refused crop, and
 * with whatever stopped it otherwise (the owner's CLOSED when the document
 * closed or `signal` aborted); every canvas drawn so far is released then.
 */
export async function renderCrop(
    owner: PreviewDocumentOwner,
    doc: PDFDocumentProxy,
    pageNumber: number,
    profile: TitleBlockProfile,
    options: { signal?: AbortSignal } = {},
): Promise<CropResult> {
    return owner.withPage(doc, pageNumber, async (page: PreviewPage) => {
        const base = page.getViewport({ scale: 1, rotation: 0 });
        const plan = planCrop(profile, { width: base.width, height: base.height });
        // Decided before the first canvas exists.
        if (plan.exceeds) throw new CropError('CROP_TOO_LARGE', CROP_MESSAGES.CROP_TOO_LARGE);
        const canvases: Partial<Record<FieldName, HTMLCanvasElement>> = {};
        try {
            for (const name of FIELD_NAMES) {
                const field = plan.fields[name];
                // The section's page offers getViewport and render, which is all renderRegion uses.
                const region = await renderRegion(page as unknown as PDFPageProxy, field.rect, { dpi: CROP_LIMITS.dpi });
                canvases[name] = region.canvas;
                if (region.width !== field.width || region.height !== field.height) {
                    throw new CropError('CROP_NOT_SHOWN', CROP_MESSAGES.CROP_NOT_SHOWN);
                }
            }
        } catch (error) {
            releaseCrop(canvases);
            throw error;
        }
        return { doc, plan, canvases: canvases as Record<FieldName, HTMLCanvasElement> };
    }, { signal: options.signal });
}
