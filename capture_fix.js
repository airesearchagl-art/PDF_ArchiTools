
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

const TARGET_URL = 'http://localhost:5173';
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'screenshots');

async function createDummyPdf() {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([842, 595]); // Landscape
    page.drawText('Wide Layout Capture', { x: 50, y: 500, size: 24 });
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync('dummy_wide.pdf', pdfBytes);
}

async function capture() {
    await createDummyPdf();

    const browser = await puppeteer.launch({
        headless: 'new',
        defaultViewport: { width: 1920, height: 1080 } // Wide viewport for single row
    });
    const page = await browser.newPage();

    try {
        await page.goto(TARGET_URL);

        // Wait for app to load
        await new Promise(r => setTimeout(r, 2000));

        // Select Annotator
        const navBtn = await page.$('button >> text="PDF加筆"');
        if (navBtn) await navBtn.click();

        // Upload PDF
        const inputUpload = await page.waitForSelector('input[type="file"]');
        await inputUpload.uploadFile('dummy_wide.pdf');

        // Wait for viewer
        await page.waitForSelector('.pdf-viewer-container');
        await new Promise(r => setTimeout(r, 2000));

        // Check if toolbar is visible
        await page.waitForSelector('.viewer-controls');

        // Capture screenshot of the MAIN container to include header and toolbar logic if needed,
        // but 'Annotator' usually implies the content inside main. 
        // We will target '.pdf-viewer-container' but maybe we want the whole app header?
        // The user's screenshot includes the header "建築設計お役立ち...".
        // That is in App header.
        // So we should capture 'main' or 'body' or specific region.
        // Let's capture the relevant tool area. 
        // Actually, HowToUse renders `annotator.png`. The `ScreenWithBadges` puts badges relative to THAT image.
        // If I capture the whole page, badges need to align with whole page.
        // User's screenshot seems to be just the "Main" area (excluding browser chrome).
        // Let's capture the element that contains the header and the viewer.
        // In App.tsx: Header is separate from Main.
        // <div className="app-container"> <Header /> <Main /> </div>
        // So I should capture `.app-container` or `body`.

        const app = await page.$('.app-container');
        if (app) {
            await app.screenshot({ path: path.join(OUTPUT_DIR, 'annotator.png') });
        } else {
            await page.screenshot({ path: path.join(OUTPUT_DIR, 'annotator.png') });
        }

        console.log('Captured wide annotator.png');

    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
        if (fs.existsSync('dummy_wide.pdf')) fs.unlinkSync('dummy_wide.pdf');
    }
}

capture();
