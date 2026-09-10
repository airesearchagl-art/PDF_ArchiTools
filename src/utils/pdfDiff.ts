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
