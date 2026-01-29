import * as pdfjsLib from 'pdfjs-dist';

export const renderPageToCanvas = async (
    pdfDoc: pdfjsLib.PDFDocumentProxy,
    pageNumber: number,
    scale: number,
): Promise<HTMLCanvasElement> => {
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) throw new Error('Could not get 2D context');

    const renderContext = {
        canvasContext: ctx,
        viewport: viewport,
    };
    await page.render(renderContext as any).promise;
    return canvas;
};

interface LayerData {
    data: Uint8ClampedArray;
    color: [number, number, number]; // RGB Factor (0-1). e.g. Red=[1, 0, 0]
}

/**
 * Computes a composite image from multiple PDF layers.
 * Uses multiply blending and spatial threshold matching.
 * 
 * Logic per pixel:
 * 1. Start with White (1, 1, 1).
 * 2. For each layer:
 *    - If pixel is Ink (dark):
 *      - Check other visible layers for Ink within `threshold` radius.
 *      - If Match Found -> Treat as Black Ink (0, 0, 0).
 *      - If No Match -> Treat as Layer Color Ink (e.g. 1, 0, 0).
 *    - Multiply current pixel by Ink Color.
 * 
 * @param layers Array of image data and their assigned colors
 * @param width 
 * @param height 
 * @param threshold Radius to search for matching ink in other layers
 */
export const computeMultiPdfComposite = (
    layers: LayerData[],
    width: number,
    height: number,
    threshold: number,
    matchColor: [number, number, number] = [0, 0, 0],  // デフォルト: 黒
    matchOpacity: number = 1.0  // デフォルト: 完全不透明
): ImageData => {
    const output = new ImageData(width, height);
    const out = output.data;

    // Helper: Is pixel ink?
    const isInk = (buf: Uint8ClampedArray, idx: number) => {
        // Simple luminance < 200
        return (buf[idx] + buf[idx + 1] + buf[idx + 2]) / 3 < 200;
    };

    // Helper: partial check for box neighbor
    // We pass the "other" buffers to check against
    const hasNeighborInAny = (others: Uint8ClampedArray[], x: number, y: number, radius: number): boolean => {
        if (radius === 0) return false; // Optimization

        const startX = Math.max(0, x - radius);
        const endX = Math.min(width - 1, x + radius);
        const startY = Math.max(0, y - radius);
        const endY = Math.min(height - 1, y + radius);

        for (const buf of others) {
            for (let ny = startY; ny <= endY; ny++) {
                for (let nx = startX; nx <= endX; nx++) {
                    const idx = (ny * width + nx) * 4;
                    if (isInk(buf, idx)) return true;
                }
            }
        }
        return false;
    };

    // Pre-collect buffers for easier access
    const buffers = layers.map(l => l.data);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;

            // Start White
            let r = 255, g = 255, b = 255;

            // Apply each layer
            for (let l = 0; l < layers.length; l++) {
                const buf = buffers[l];

                if (isInk(buf, i)) {
                    // It is ink.
                    // Check if it matches any OTHER layer
                    // We need to check against all *other* buffers
                    let isMatch = false;

                    if (threshold === 0) {
                        // Strict check: Is any other layer ink at exact same spot?
                        for (let k = 0; k < layers.length; k++) {
                            if (k === l) continue;
                            if (isInk(buffers[k], i)) {
                                isMatch = true;
                                break;
                            }
                        }
                    } else {
                        // Threshold check
                        const others = buffers.filter((_, idx) => idx !== l);
                        isMatch = hasNeighborInAny(others, x, y, threshold);
                    }

                    // Determine Ink Color
                    // If matched -> matchColor with matchOpacity
                    // If unique -> Layer color
                    const inkR = isMatch ? matchColor[0] : layers[l].color[0];
                    const inkG = isMatch ? matchColor[1] : layers[l].color[1];
                    const inkB = isMatch ? matchColor[2] : layers[l].color[2];

                    // Multiply blending with opacity support for matches:
                    if (isMatch && matchOpacity < 1.0) {
                        // Alpha blending: result = background * (1 - alpha) + (background * ink) * alpha
                        const matchedR = r * inkR;
                        const matchedG = g * inkG;
                        const matchedB = b * inkB;
                        r = r * (1 - matchOpacity) + matchedR * matchOpacity;
                        g = g * (1 - matchOpacity) + matchedG * matchOpacity;
                        b = b * (1 - matchOpacity) + matchedB * matchOpacity;
                    } else {
                        // Standard multiply blending
                        r = (r * inkR);
                        g = (g * inkG);
                        b = (b * inkB);
                    }
                }
                // If not ink (White), it treats as (1,1,1) multiplier effectively (transparent)
            }

            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
            out[i + 3] = 255;
        }
    }

    return output;
};

/**
 * 変更箇所のバウンディングボックスを検出
 * 各レイヤーで他のレイヤーと一致しない（unique）ピクセルがある領域を検出
 * 
 * @param layers Array of image data and their assigned colors
 * @param width Canvas width
 * @param height Canvas height
 * @param threshold Radius to search for matching ink in other layers
 * @returns Bounding box {x, y, width, height} or null if no changes detected
 */
export const detectChangeBounds = (
    layers: LayerData[],
    width: number,
    height: number,
    threshold: number
): { x: number; y: number; width: number; height: number } | null => {
    if (layers.length < 2) return null;

    let minX = width, minY = height, maxX = 0, maxY = 0;
    let hasChange = false;

    const buffers = layers.map(l => l.data);

    // Helper: Is pixel ink?
    const isInk = (buf: Uint8ClampedArray, i: number): boolean => {
        const threshold = 200;
        return buf[i] < threshold || buf[i + 1] < threshold || buf[i + 2] < threshold;
    };

    // Helper: has neighbor ink in any buffer
    const hasNeighborInAny = (bufs: Uint8ClampedArray[], x: number, y: number, radius: number): boolean => {
        for (const buf of bufs) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const ni = (ny * width + nx) * 4;
                    if (isInk(buf, ni)) return true;
                }
            }
        }
        return false;
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;

            // 各レイヤーでinkがあるか確認
            for (let l = 0; l < layers.length; l++) {
                const buf = buffers[l];
                if (isInk(buf, i)) {
                    // 他のレイヤーと一致しない = 変更箇所
                    let isMatch = false;

                    if (threshold === 0) {
                        // Strict check
                        for (let k = 0; k < layers.length; k++) {
                            if (k === l) continue;
                            if (isInk(buffers[k], i)) {
                                isMatch = true;
                                break;
                            }
                        }
                    } else {
                        // Threshold check
                        const others = buffers.filter((_, idx) => idx !== l);
                        isMatch = hasNeighborInAny(others, x, y, threshold);
                    }

                    if (!isMatch) {
                        hasChange = true;
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }
            }
        }
    }

    if (!hasChange) return null;

    // マージン追加 (余白を確保)
    const margin = 20;
    return {
        x: Math.max(0, minX - margin),
        y: Math.max(0, minY - margin),
        width: Math.min(width, maxX + margin + 1) - Math.max(0, minX - margin),
        height: Math.min(height, maxY + margin + 1) - Math.max(0, minY - margin)
    };
};

