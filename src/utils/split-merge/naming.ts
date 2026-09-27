/**
 * Output names that say what they are. Adopted M6-H14.
 *
 * What they replace: every Extract was `extracted_<source>.pdf`, which
 * overwrites on repeat and says nothing about which pages it contains, and every
 * Merge was the constant `merged_document.pdf`, so a second merge overwrote the
 * first in the download folder.
 *
 * Deterministic on purpose: the same selection of the same file produces the
 * same name, so a person who exports twice can tell the two apart without
 * opening them, and a person who exports the same thing twice does not end up
 * with `(1)`.
 */

/** The stem of a file name, without its `.pdf`. */
export function stemOf(fileName: string): string {
    const trimmed = fileName.trim();
    const dot = trimmed.lastIndexOf('.');
    const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
    return stem.length > 0 ? stem : 'document';
}

/**
 * Characters a file name cannot carry on the platforms this app runs on, plus
 * the ones a download would silently rewrite.
 *
 * Kept deliberately narrow: a Japanese file name must survive intact, so this
 * strips the reserved set rather than restricting to ASCII. Control characters
 * are matched through the Unicode property escape rather than a literal range,
 * so this file holds no control byte of its own.
 */
function sanitizeStem(stem: string): string {
    const cleaned = stem
        .replace(/\p{Cc}/gu, '')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^\.+/, '')
        .trim();
    return cleaned.length > 0 ? cleaned : 'document';
}

/**
 * A page selection written the way a person would: one-based, ascending, with
 * runs collapsed.
 *
 * `[0, 2, 4, 5, 6, 7]` becomes `p1,3,5-8`.
 */
export function describeSelection(selection: number[]): string {
    if (selection.length === 0) return 'p0';
    const sorted = [...selection].map((i) => i + 1).sort((a, b) => a - b);
    const parts: string[] = [];
    let runStart = sorted[0];
    let previous = sorted[0];

    const flush = (): void => {
        if (runStart === previous) parts.push(String(runStart));
        else if (previous - runStart === 1) parts.push(`${runStart},${previous}`);
        else parts.push(`${runStart}-${previous}`);
    };

    for (let i = 1; i < sorted.length; i += 1) {
        const value = sorted[i];
        if (value === previous + 1) {
            previous = value;
            continue;
        }
        flush();
        runStart = value;
        previous = value;
    }
    flush();
    return `p${parts.join(',')}`;
}

/**
 * How long a name may get before the selection is summarised instead of listed.
 *
 * M6-H14 deferred "length limits for very large selections"; this is the
 * mechanism, and the threshold is a file-system fact rather than a product
 * policy — 255 bytes is the common limit, and the stem has to fit beside it.
 */
const MAX_NAME_CHARS = 180;

/** `<source>_p1,3,5-8.pdf`. */
export function extractOutputName(sourceName: string, selection: number[]): string {
    const stem = sanitizeStem(stemOf(sourceName));
    const listed = describeSelection(selection);
    const full = `${stem}_${listed}.pdf`;
    if (full.length <= MAX_NAME_CHARS) return full;
    // Summarised rather than truncated: a truncated range list reads as a
    // different, smaller selection, which is worse than saying how many.
    return `${stem}_p${selection.length}pages.pdf`;
}

/** `merged_<n>files_<firstSource>.pdf`. */
export function mergeOutputName(sourceNames: string[]): string {
    if (sourceNames.length === 0) return 'merged_document.pdf';
    const first = sanitizeStem(stemOf(sourceNames[0]));
    const full = `merged_${sourceNames.length}files_${first}.pdf`;
    if (full.length <= MAX_NAME_CHARS) return full;
    return `merged_${sourceNames.length}files.pdf`;
}
