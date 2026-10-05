/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * A synthetic Drawing Set of any size, built the way the app would build one.
 *
 * Nothing here is a customer drawing, a real project or a real file name. Every
 * fingerprint is the hash of a label, every drawing number and title is
 * generated from a seed, and the same seed always gives the same Project -- so
 * a benchmark can be repeated and a fixture can be regenerated and compared.
 *
 * The Project is not assembled as a JSON literal. It is driven through the same
 * operations a session would use (add sources, read, confirm, run QA, decide),
 * because a hand-built document proves only that the builder agrees with
 * itself. What comes out of here is a state the prototype can actually reach.
 */

import { seededUuidSource } from './ids.mjs';
import { sha256HexOfText } from './sha256-stream.mjs';
import { BINDING } from './currency.mjs';
import {
    addProfile, addSource, assignProfile, confirmSheet, decide, liveSheets, newProject, recordExtraction,
} from './model-ops.mjs';
import { runQa } from './qa-rules.mjs';

/** 2026-10-05T00:00:00Z. Fixed, so nothing generated depends on today's date. */
export const SYNTHETIC_EPOCH_MS = Date.UTC(2026, 9, 5, 0, 0, 0);

function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const A1_LANDSCAPE = { uprightWidthPt: 2383.94, uprightHeightPt: 1683.78 };
const A3_LANDSCAPE = { uprightWidthPt: 1190.55, uprightHeightPt: 841.89 };
const A1_PORTRAIT = { uprightWidthPt: 1683.78, uprightHeightPt: 2383.94 };

const DISCIPLINES = ['A', 'S', 'M', 'E', 'P'];
const TITLE_HEAD = ['平面図', '立面図', '断面図', '矩計図', '天井伏図', '展開図', '建具表', '仕上表', '配置図', '詳細図'];
const TITLE_TAIL = ['1階', '2階', '3階', 'R階', 'B1階', '東', '西', '南', '北', 'その1', 'その2'];

const toFullWidth = (text) => text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

/**
 * Build a synthetic Project.
 *
 *   sheets            total pages across all sources
 *   pagesPerSource    25 models merged PDFs; 1 models one PDF per sheet, the
 *                     shape that makes the Source Manifest as large as the
 *                     Sheet list
 *   confirmedShare    fraction of sheets a person has confirmed
 *   decidedShare      fraction of findings a person has decided
 *   duplicateEvery / gapEvery / variantEvery / outlierEvery
 *                     how often each kind of QA condition is planted
 *                     (0 = never)
 */
export function buildSyntheticProject({
    sheets = 200, pagesPerSource = 25, seed = 20261005,
    confirmedShare = 0.6, decidedShare = 0.5,
    duplicateEvery = 40, gapEvery = 30, variantEvery = 90, outlierEvery = 50,
    comment = 'synthetic review note',
} = {}) {
    const random = rng(seed);
    const newId = seededUuidSource(seed ^ 0x5bd1e995);
    let now = SYNTHETIC_EPOCH_MS;
    const tick = (ms = 1000) => { now += ms; return now; };

    const model = newProject({ name: `Synthetic Project ${seed}`, drawingSetName: 'Synthetic Drawing Set', now: tick(), newId });

    const profileRects = {
        drawingNumber: { left: 2150, top: 1600, right: 2360, bottom: 1640 },
        drawingTitle: { left: 1850, top: 1600, right: 2140, bottom: 1640 },
        revision: { left: 2150, top: 1645, right: 2250, bottom: 1675 },
        issueDate: { left: 2255, top: 1645, right: 2360, bottom: 1675 },
    };
    const profile = addProfile(model, { name: 'A1 title block', transferModel: 'corner-anchored', referencePage: A1_LANDSCAPE, fields: profileRects, now: tick(), newId });

    const bindings = new Map();
    const sourceCount = Math.ceil(sheets / pagesPerSource);
    let remaining = sheets;
    for (let i = 0; i < sourceCount; i += 1) {
        const pageCount = Math.min(pagesPerSource, remaining);
        remaining -= pageCount;
        const added = addSource(model, {
            displayName: `synthetic-set-${String(i + 1).padStart(4, '0')}.pdf`,
            sha256: sha256HexOfText(`synthetic-source:${seed}:${i}`),
            byteLength: 1_000_000 + i * 4096 + pageCount,
            pageCount, now: tick(), newId,
        });
        bindings.set(added.source.id, BINDING.MATCHED);
    }

    const all = liveSheets(model);
    assignProfile(model, all.map((s) => s.id), profile.id, tick());

    // Numbers run A-101, A-102, ... per discipline, with the planted conditions.
    const perDiscipline = Math.ceil(sheets / DISCIPLINES.length);
    const results = [];
    let previousNumber = null;
    let previousTitle = null;
    let counter = 100;
    let discipline = 0;
    all.forEach((sheet, i) => {
        if (i > 0 && i % perDiscipline === 0) { discipline += 1; counter = 100; }
        counter += 1;
        if (gapEvery && i % gapEvery === gapEvery - 1) counter += 1 + Math.floor(random() * 2);
        let number = `${DISCIPLINES[discipline]}-${counter}`;
        let title = `${TITLE_TAIL[Math.floor(random() * TITLE_TAIL.length)]}${TITLE_HEAD[Math.floor(random() * TITLE_HEAD.length)]}`;
        if (duplicateEvery && previousNumber && i % duplicateEvery === duplicateEvery - 1) {
            number = previousNumber;
            if (random() < 0.5) title = previousTitle;
            counter -= 1;
        } else if (variantEvery && previousNumber && i % variantEvery === variantEvery - 1) {
            number = toFullWidth(previousNumber);
            counter -= 1;
        }
        previousNumber = number.normalize('NFKC');
        previousTitle = title;

        let facts = { ...A1_LANDSCAPE, rotate: 0, kind: random() < 0.2 ? 'scanned' : 'text-native' };
        if (outlierEvery && i % outlierEvery === outlierEvery - 1) {
            facts = random() < 0.5 ? { ...A3_LANDSCAPE, rotate: 0, kind: 'text-native' } : { ...A1_PORTRAIT, rotate: 0, kind: 'text-native' };
        }
        const source = facts.kind === 'scanned' ? 'ocr' : 'native';
        const field = (value, label) => ({ value, rawText: `${label}\n${value}`, source, ocrScore: source === 'ocr' ? 60 + Math.floor(random() * 40) : null });
        results.push({
            sheetId: sheet.id, pageFacts: facts, status: 'READ',
            fields: {
                drawingNumber: field(number, '図面番号'),
                drawingTitle: field(title, '図面名称'),
                revision: field(String.fromCharCode(65 + Math.floor(random() * 3)), '版'),
                issueDate: field(`2026.${String(1 + Math.floor(random() * 9)).padStart(2, '0')}.${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`, '日付'),
            },
        });
    });
    recordExtraction(model, { results, engineVersion: '0.1.0-research', now: tick(), newId });

    for (const sheet of all) {
        if (random() < confirmedShare) confirmSheet(model, sheet.id, {}, tick(10));
    }

    runQa(model, bindings, { now: tick(), newId });

    const outcomes = ['ACTION_REQUIRED', 'INTENTIONAL', 'FALSE_POSITIVE', 'HOLD'];
    for (const finding of [...model.drawingSet.findings]) {
        if (random() < decidedShare) {
            decide(model, finding.id, { outcome: outcomes[Math.floor(random() * outcomes.length)], comment, now: tick(10), newId });
        }
    }

    return { model, bindings, now: tick(), newId, profile };
}
