
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_PATH = path.join(process.cwd(), 'public', 'screenshots', 'annotator.png');
const OUTPUT_PATH = IMAGE_PATH; // Overwrite

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    // Read image as base64
    const imgBuffer = fs.readFileSync(IMAGE_PATH);
    const imgBase64 = imgBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${imgBase64}`;

    await page.setContent(`
        <html>
        <body>
            <canvas id="c"></canvas>
            <img id="src" src="${dataUrl}" style="display:none;" onload="process()" />
            <script>
            function process() {
                const img = document.getElementById('src');
                const canvas = document.getElementById('c');
                const ctx = canvas.getContext('2d');
                
                canvas.width = img.width;
                canvas.height = img.height;
                
                // Draw full image
                ctx.drawImage(img, 0, 0);
                
                // Blur the bottom part (Content)
                const toolbarHeight = img.height * 0.15; // Top 15% is toolbar
                const contentY = toolbarHeight;
                const contentHeight = img.height - contentY;
                
                ctx.filter = 'blur(10px)';
                // We redraw the bottom part blurred
                // Note: drawImage with cropping source to same destination
                ctx.drawImage(canvas, 
                    0, contentY, img.width, contentHeight, // source x,y,w,h
                    0, contentY, img.width, contentHeight  // dest x,y,w,h
                );
                
                // Add "SAMPLE PDF" text overlay
                ctx.filter = 'none';
                ctx.font = 'bold 48px Arial';
                ctx.fillStyle = 'rgba(200, 200, 200, 0.5)';
                ctx.textAlign = 'center';
                ctx.fillText('SAMPLE PDF', canvas.width / 2, canvas.height / 2 + 50);
                
                // Signal done
                document.body.classList.add('done');
            }
            </script>
        </body>
        </html>
    `);

    try {
        await page.waitForSelector('body.done', { timeout: 10000 });

        const dataUrlNew = await page.evaluate(() => {
            return document.getElementById('c').toDataURL('image/png');
        });

        const base64Data = dataUrlNew.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(OUTPUT_PATH, base64Data, 'base64');
        console.log('Processed image saved.');
    } catch (e) {
        console.error('Error processing image:', e);
    } finally {
        await browser.close();
    }
})();
