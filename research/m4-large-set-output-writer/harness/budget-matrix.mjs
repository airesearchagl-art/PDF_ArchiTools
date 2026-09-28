/**
 * The current production preflight, unmodified, over the synthetic A1 frames:
 * which (DPI, leading pages, memory preset) the app accepts or refuses today,
 * and every term that decided it.
 *
 * Run: node harness/budget-matrix.mjs   -> evidence/budget-matrix.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const prod = await import(pathToFileURL(path.join(ROOT, 'out', 'prod.mjs')).href);

const MiB = 2 ** 20;
const rows = [];
for (const dpi of [150, 300, 450]) {
    const metas = [1, 2, 3, 4, 5].map((n) => JSON.parse(fs.readFileSync(
        path.join(ROOT, 'out', 'composites', `dpi${dpi}`, `p${n}`, 'meta.json'), 'utf8')));
    for (let count = 1; count <= 5; count += 1) {
        const slots = metas.slice(0, count).map((m) => ({
            page: m.page, status: prod.PLAN.READY_TO_COMPARE, width: m.width, height: m.height,
        }));
        const plan = prod.planArtifact(prod.ARTIFACT.COMPARISON_PDF, slots, [1, 2], 0);
        for (const preset of prod.MEMORY_BUDGET_PRESETS) {
            const pf = prod.preflightArtifact(plan, 2, 0, preset.bytes);
            const item = plan.items[0].cost;
            rows.push({
                dpi, pages: count, preset: preset.label, frame: `${metas[0].width}x${metas[0].height}`,
                accepted: pf.withinBudget,
                refusal: pf.refusal?.status ?? null,
                reason: pf.refusal?.reason ?? null,
                achievable: pf.refusal?.achievable ?? null,
                jobPeakMiB: +(pf.jobPeak / MiB).toFixed(1),
                peakPhase: pf.peakPhase,
                duringRunMiB: +(pf.memory.duringRun / MiB).toFixed(1),
                atPublishMiB: +(pf.memory.atPublish / MiB).toFixed(1),
                publishTermsMiB: Object.fromEntries(Object.entries(pf.memory.publish).map(([k, v]) => [k, +(v / MiB).toFixed(1)])),
                kernelPeakMiB: +(pf.memory.kernel.peakWorkingSet / MiB).toFixed(1),
                kernelPeakPhase: pf.memory.kernel.peakPhase,
                sinkPeakMiB: +(pf.memory.sinkPeak / MiB).toFixed(1),
                outputMiB: +(pf.output.outputBytes / MiB).toFixed(2),
                outputCeilingMiB: prod.MAX_OUTPUT_BYTES / MiB,
                perItem: {
                    rasterMiB: +(item.rasterBytes / MiB).toFixed(2),
                    storedPngMiB: +(item.encodedBytes / MiB).toFixed(2),
                    storedPngBytesPerPixel: +(item.encodedBytes / (metas[0].width * metas[0].height)).toFixed(4),
                    jsPdfIngestPeakMiB: +(item.ingestBytes / MiB).toFixed(2),
                    retainedMiB: +(item.retainedBytes / MiB).toFixed(2),
                    fileShareMiB: +(item.fileBytes / MiB).toFixed(2),
                    outputChargeMiB: +(item.outputBytes / MiB).toFixed(2),
                    peakStep: item.peakStep,
                },
                workUnits: pf.work.jobUnits,
            });
        }
    }
}
const out = path.join(ROOT, 'evidence', 'budget-matrix.json');
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
for (const r of rows) {
    console.log(`${r.dpi} dpi ${r.pages}p ${r.preset.padEnd(14)} ${r.accepted ? 'ACCEPT' : r.refusal.padEnd(19)} `
        + `peak ${String(r.jobPeakMiB).padStart(7)} MiB (${r.peakPhase})  output ${String(r.outputMiB).padStart(8)} MiB  ${r.achievable ?? ''}`);
}
