/**
 * Resolve whatever colour string the annotator stored into RGB components.
 *
 * This cannot be a hex parser. A measurement line is created with
 * `color: 'blue'` — a CSS keyword, not hex (`DrawingCanvas.tsx:902`) — while
 * poly and area use `'#0000ff'` (`:966`) and the pen uses whatever the palette
 * gives. A hex-only parser returns black for the keyword, so every measurement
 * line would be written black while the canvas draws it blue: not a crash, not
 * a refusal, just the wrong colour in the file.
 *
 * The canvas is the parser. Assigning to `fillStyle` and reading it back gives
 * the browser's own normalisation of any CSS colour the app could have stored,
 * which is exactly the set the renderer accepts.
 */

let parser: CanvasRenderingContext2D | null = null;

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

const HEX = /^#?([0-9a-f]{6})$/i;
const SHORT_HEX = /^#?([0-9a-f]{3})$/i;

function fromHex(hex: string): Rgb | null {
    const short = SHORT_HEX.exec(hex.trim());
    const full = HEX.exec(hex.trim());
    const digits = full?.[1] ?? (short ? short[1].split('').map((c) => c + c).join('') : null);
    if (!digits) return null;
    const n = parseInt(digits, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * A CSS colour string -> {r,g,b} in 0..1.
 *
 * Black is the fallback of last resort, and only for a string nothing can make
 * sense of — which preflight would have to have let through.
 */
export function parseColour(value: string): Rgb {
    const direct = fromHex(value);
    if (direct) return direct;

    if (!parser) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        parser = canvas.getContext('2d');
    }
    if (parser) {
        // An unparseable value leaves fillStyle at its previous setting, so it
        // is reset first and a failure is visible as the sentinel coming back.
        parser.fillStyle = '#000000';
        parser.fillStyle = value;
        const resolved = fromHex(String(parser.fillStyle));
        if (resolved) return resolved;
    }
    return { r: 0, g: 0, b: 0 };
}

/**
 * The area fill colour, matching `DrawingCanvas.tsx:276-278`.
 *
 * The renderer appends `'4d'` to the colour string, which only works if the
 * colour is hex — so it substitutes `'#0000ff'` when it is not. That
 * substitution is part of what the user sees and is reproduced rather than
 * corrected.
 */
export const MEASURE_FILL_ALPHA = 0x4d / 255;

export function areaFillColour(colour: string): Rgb {
    return parseColour(colour.startsWith('#') ? colour : '#0000ff');
}
