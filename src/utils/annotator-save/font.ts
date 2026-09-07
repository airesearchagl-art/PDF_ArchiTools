/**
 * The font a vector text annotation is actually written in.
 *
 * The annotator stores `fontFamily` as a CSS family name. A family name cannot
 * be resolved to a file, so it cannot be embedded, so **a vector text
 * annotation is not in the font the user picked**. What gets embedded is the
 * OFL font already shipped with this app, which covers Japanese and ASCII.
 *
 * That substitution is visible — the glyphs differ — so it is reported to the
 * user rather than absorbed. What must never be claimed is that a chosen family
 * was preserved.
 */
import type { PDFFont } from 'pdf-lib';
import { AnnotatorSaveError } from './types';

/** Same-origin, from this app's own assets. Never a CDN. */
export const ANNOTATION_FONT_URL = '/ocr/fonts/MPLUS1p-Regular.ttf';

let cached: Uint8Array | null = null;

/**
 * Fetch the font, once.
 *
 * A failure is fatal to the save rather than a reason to fall back to a
 * built-in face: the standard PDF fonts have no Japanese coverage, so quietly
 * substituting one would drop every Japanese annotation to `.notdef` and report
 * success.
 */
export async function loadAnnotationFont(): Promise<Uint8Array> {
    if (cached) return cached;
    let response: Response;
    try {
        response = await fetch(ANNOTATION_FONT_URL);
    } catch (error) {
        throw new AnnotatorSaveError([{
            code: 'font-unavailable',
            message: '文字注釈の保存に必要なフォントを読み込めませんでした。'
                + 'ページを再読み込みしてからもう一度お試しください。',
            detail: String((error as Error)?.message ?? error),
        }]);
    }
    if (!response.ok) {
        throw new AnnotatorSaveError([{
            code: 'font-unavailable',
            message: '文字注釈の保存に必要なフォントを読み込めませんでした。'
                + 'ページを再読み込みしてからもう一度お試しください。',
            detail: `${ANNOTATION_FONT_URL} -> HTTP ${response.status}`,
        }]);
    }
    cached = new Uint8Array(await response.arrayBuffer());
    return cached;
}

/**
 * Characters the embedded font has no glyph for.
 *
 * A custom font maps anything it does not have to `.notdef`, which draws as
 * nothing — so a save can swallow an emoji and report success. Asking fontkit
 * directly is the only way to know before writing.
 *
 * Where the question cannot be asked at all, every character is reported as
 * unsupported rather than none: not knowing is not evidence of coverage.
 */
export function unsupportedGlyphs(font: PDFFont, text: string): string[] {
    const embedder = (font as unknown as {
        embedder?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } };
    }).embedder?.font;
    const chars = [...text];
    if (!embedder || typeof embedder.hasGlyphForCodePoint !== 'function') {
        return [...new Set(chars.filter((c) => c.trim() !== ''))];
    }
    const missing: string[] = [];
    for (const ch of chars) {
        if (ch.trim() === '') continue;
        const cp = ch.codePointAt(0);
        if (cp === undefined) continue;
        try {
            if (!embedder.hasGlyphForCodePoint(cp)) missing.push(ch);
        } catch {
            missing.push(ch);
        }
    }
    return [...new Set(missing)];
}
