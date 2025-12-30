import { jsPDF } from 'jspdf';
import fs from 'fs';
import path from 'path';

// Navigate to public folder. Current cwd is root.
const outputDir = path.resolve('public/test-pdfs');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// PDF 1: Old Version
// A rectangle and some text
const doc1 = new jsPDF();
doc1.text("Architectural Drawing - Version 1", 10, 10);
doc1.rect(20, 20, 100, 50); // Wall
doc1.text("Living Room", 30, 40);
// Add some common lines
for (let i = 0; i < 5; i++) {
    doc1.line(20, 80 + i * 10, 120, 80 + i * 10);
}
doc1.save(path.join(outputDir, 'v1.pdf'));

// PDF 2: New Version
// Same rectangle, but moved wall, and added text
const doc2 = new jsPDF();
doc2.text("Architectural Drawing - Version 2", 10, 10); // Changed text slightly?
doc2.rect(20, 20, 120, 50); // Extended Wall (Modified) -> Will show Blue extension, Red original end.
doc2.text("Living Room + Dining", 30, 40); // Changed Label -> Will show Red "Living Room" over Blue "Living Room + Dining" (messy text overlay, expected)
// Common lines match
for (let i = 0; i < 5; i++) {
    doc2.line(20, 80 + i * 10, 120, 80 + i * 10);
}
doc2.circle(150, 50, 10); // New element -> Blue
doc2.save(path.join(outputDir, 'v2.pdf'));

console.log("Generated v1.pdf and v2.pdf in public/test-pdfs");
