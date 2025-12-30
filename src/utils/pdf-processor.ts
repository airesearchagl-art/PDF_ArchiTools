import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export interface LayerOptions {
    color: string; // hex string, e.g. "#ff0000"
    opacity: number; // 0.0 to 1.0
}

export interface MonoOptions {
    dpi: number;
    contrast: number;
}

export interface OptimizeOptions {
    dpi: number; // 72, 150, 300
}

// Helper to convert hex to rgb
function hexToRgb(hex: string) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16) / 255,
        g: parseInt(result[2], 16) / 255,
        b: parseInt(result[3], 16) / 255
    } : { r: 1, g: 1, b: 1 };
}

export async function processLayer(file: File | Uint8Array, options: LayerOptions): Promise<Uint8Array> {
    let pdfDoc;
    if (file instanceof File) {
        const arrayBuffer = await file.arrayBuffer();
        pdfDoc = await PDFDocument.load(arrayBuffer);
    } else {
        pdfDoc = await PDFDocument.load(file);
    }

    const pages = pdfDoc.getPages();
    const { r, g, b } = hexToRgb(options.color);
    const color = rgb(r, g, b);

    for (const page of pages) {
        const { width, height } = page.getSize();
        page.drawRectangle({
            x: 0,
            y: 0,
            width,
            height,
            color: color,
            opacity: options.opacity,
        });
    }

    return await pdfDoc.save();
}

/**
 * Optimization now implies Rasterization at a specific DPI to reduce size/complexity.
 * This effectively flattens the PDF.
 */
export async function processOptimize(file: File, options: OptimizeOptions): Promise<Uint8Array> {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;

    const newPdf = await PDFDocument.create();

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: options.dpi / 72 });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (!ctx) throw new Error('Could not get canvas context');

        await page.render({ canvasContext: ctx, viewport } as any).promise;

        // Export to JPEG with compression
        const imgDataUrl = canvas.toDataURL('image/jpeg', 0.8);

        // Embed in new PDF
        const embeddedImage = await newPdf.embedJpg(imgDataUrl);

        // Scale back to standard PDF points (72 DPI)
        const pdfPage = newPdf.addPage([viewport.width * (72 / options.dpi), viewport.height * (72 / options.dpi)]);
        pdfPage.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: pdfPage.getWidth(),
            height: pdfPage.getHeight(),
        });

        page.cleanup();
    }

    return await newPdf.save();
}

export async function processMonochrome(file: File, options: MonoOptions): Promise<Uint8Array> {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;

    const newPdf = await PDFDocument.create();

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: options.dpi / 72 });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (!ctx) throw new Error('Could not get canvas context');

        await page.render({ canvasContext: ctx, viewport } as any).promise;

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        // Apply Grayscale & Contrast
        for (let j = 0; j < data.length; j += 4) {
            // Grayscale
            const gray = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];

            // Contrast
            let final = (gray - 128) * options.contrast + 128;
            final = final < 0 ? 0 : (final > 255 ? 255 : final);

            data[j] = final;     // R
            data[j + 1] = final; // G
            data[j + 2] = final; // B
        }

        ctx.putImageData(imageData, 0, 0);

        const imgDataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const embeddedImage = await newPdf.embedJpg(imgDataUrl);

        const pdfPage = newPdf.addPage([viewport.width * (72 / options.dpi), viewport.height * (72 / options.dpi)]);
        pdfPage.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: pdfPage.getWidth(),
            height: pdfPage.getHeight(),
        });

        page.cleanup();
    }

    return await newPdf.save();
}

export interface MarginOptions {
    scale: number; // 0.25 to 0.90
    position: 'center' | 'tl' | 'tr' | 'bl' | 'br';
}

export async function processMargin(file: File, options: MarginOptions): Promise<Uint8Array> {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const newPdf = await PDFDocument.create();

    const pages = pdfDoc.getPages();
    const embeddedPages = await newPdf.embedPages(pdfDoc.getPages());
    // Note: embedPages works if we copy pages. 
    // But wait, pdf-lib embedPages takes an array of pages. 
    // Actually, to embed pages from another doc, we usually use `embedPdf` or `copyPages`.
    // `copyPages` is better for vector preservation. `embedPage` treats it as an object/image.
    // If we want to scale it, embedding it as a form XObject is best.
    // Let's use `embedPage` which returns a specialized object we can draw.

    // Re-load to ensure we can embed properly if needed? No, load is fine.
    // We need to embed EACH page.

    for (let i = 0; i < pages.length; i++) {
        const originalPage = pages[i];
        const { width, height } = originalPage.getSize();

        // Create new page with SAME dimensions
        const newPage = newPdf.addPage([width, height]);

        // Embed the original page
        const embeddedPage = await newPdf.embedPage(originalPage);

        const newWidth = width * options.scale;
        const newHeight = height * options.scale;

        let x = 0;
        let y = 0;

        // Calculate Position (origin is bottom-left)
        switch (options.position) {
            case 'center':
                x = (width - newWidth) / 2;
                y = (height - newHeight) / 2;
                break;
            case 'tl': // Visual Top-Left
                x = 0;
                y = height - newHeight;
                break;
            case 'tr': // Visual Top-Right
                x = width - newWidth;
                y = height - newHeight;
                break;
            case 'bl': // Visual Bottom-Left
                x = 0;
                y = 0;
                break;
            case 'br': // Visual Bottom-Right
                x = width - newWidth;
                y = 0;
                break;
        }

        newPage.drawPage(embeddedPage, {
            x,
            y,
            width: newWidth,
            height: newHeight,
        });
    }

    return await newPdf.save();
}
