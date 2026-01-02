import puppeteer from 'puppeteer';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

async function createDummyPdf() {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // A4 size approx
    page.drawText('Sample PDF for Screenshot', { x: 50, y: 750, size: 24 });
    page.drawText('This is a dummy file used to demonstrate UI features.', { x: 50, y: 700 });
    // Add some shapes to make it look like a drawing
    page.drawRectangle({ x: 50, y: 500, width: 200, height: 100, borderColor: { type: 'RGB', red: 0, green: 0, blue: 1 }, borderWidth: 2 });
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync('dummy.pdf', Buffer.from(pdfBytes));
}

(async () => {
    try {
        console.log('Creating dummy PDF...');
        await createDummyPdf();

        if (!fs.existsSync('public/screenshots')) {
            fs.mkdirSync('public/screenshots', { recursive: true });
        }

        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            headless: 'new', // Use new headless mode
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        console.log('Navigating to app...');
        await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });

        // Helper to click nav button
        const clickNav = async (text) => {
            console.log(`Switching to ${text}...`);
            const buttons = await page.$$('nav button');
            let clicked = false;
            for (const btn of buttons) {
                const btnText = await btn.evaluate(el => el.textContent);
                if (btnText && btnText.includes(text)) {
                    await btn.click();
                    clicked = true;
                    break;
                }
            }
            if (!clicked) console.error(`Button ${text} not found`);
            await new Promise(r => setTimeout(r, 1000)); // Wait for transition
        };

        // 1. Annotator
        await clickNav('PDF加筆');
        // Upload
        let fileInput = await page.$('input[type="file"]');
        if (fileInput) {
            console.log('Uploading dummy.pdf to Annotator...');
            await fileInput.uploadFile('dummy.pdf');
            await new Promise(r => setTimeout(r, 2000)); // Wait for render
        }
        await page.screenshot({ path: 'public/screenshots/annotator.png' });

        // 2. Comparator
        await clickNav('PDF比較');
        // Upload to slot 0 and 1
        const inputs = await page.$$('input[type="file"]');
        if (inputs.length >= 2) {
            console.log('Uploading dummy.pdf to Comparator slots...');
            await inputs[0].uploadFile('dummy.pdf');
            await inputs[1].uploadFile('dummy.pdf'); // Ideally different file, but same is okay for UI demo
            await new Promise(r => setTimeout(r, 2000));

            // Open Export Settings to show the new UI
            const settingsBtn = await page.$('button[title="Export Settings"]');
            if (settingsBtn) {
                console.log('Opening Export Settings...');
                await settingsBtn.click();
                await new Promise(r => setTimeout(r, 500));
            }
        }
        await page.screenshot({ path: 'public/screenshots/comparator.png' });

        // 3. Processor
        await clickNav('PDF加工');
        fileInput = await page.$('input[type="file"]');
        if (fileInput) {
            console.log('Uploading dummy.pdf to Processor...');
            await fileInput.uploadFile('dummy.pdf');
            await new Promise(r => setTimeout(r, 1000));
        }
        await page.screenshot({ path: 'public/screenshots/processor.png' });

        // 4. Split / Merge
        await clickNav('PDF抽出・統合');
        // Extract tab is default
        fileInput = await page.$('input[type="file"]');
        if (fileInput) {
            console.log('Uploading dummy.pdf to Extract...');
            await fileInput.uploadFile('dummy.pdf');
            await new Promise(r => setTimeout(r, 2000)); // Wait for thumbnails
        }
        await page.screenshot({ path: 'public/screenshots/split_extract.png' });

        // Switch to Merge tab for completeness? Or just one screenshot? user said "each tool".
        // Let's capture Merge too.
        const tabs = await page.$$('button');
        for (const btn of tabs) {
            const t = await btn.evaluate(el => el.textContent);
            if (t && t.includes('PDF統合')) {
                await btn.click();
                await new Promise(r => setTimeout(r, 500));
                break;
            }
        }
        // Upload to Merge
        const mergeInput = await page.$('input[type="file"]'); // might be hidden inside label
        if (mergeInput) {
            await mergeInput.uploadFile('dummy.pdf');
            await new Promise(r => setTimeout(r, 1000));
        }
        await page.screenshot({ path: 'public/screenshots/split_merge.png' });

        // 5. Textifier
        await clickNav('PDFテキスト化');
        fileInput = await page.$('input[type="file"]');
        if (fileInput) {
            console.log('Uploading dummy.pdf to Textifier...');
            await fileInput.uploadFile('dummy.pdf');
            await new Promise(r => setTimeout(r, 2000));
        }
        await page.screenshot({ path: 'public/screenshots/textifier.png' });

        console.log('Screenshots captured successfully.');
        await browser.close();

    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
})();
