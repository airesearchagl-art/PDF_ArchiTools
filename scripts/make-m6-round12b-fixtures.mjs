/**
 * The documents Round 12B's `/Next` fan-out boundedness is proven against.
 *
 * Both readers of an action's structure follow `/Next` from one action to the
 * next, and a `/Next` may be a list. They used to follow it path by path, so a
 * list naming the same action twice made two paths, the action after it four,
 * and the one after that eight. A document of a few dozen objects, a few
 * kilobytes, held more paths than either reader could walk before the worker's
 * timeout — and it did so with every action in it valid.
 *
 * Every fixture here is tiny. What they share is that the number of *actions* is
 * small and the number of *paths* is not.
 *
 * The F family is fan-out: each action's `/Next` names the one after it more than
 * once. Depths 16, 24 and 32 at width 2, depth 16 at width 3, and a list that
 * names one child sixty-four times. The verdict of every one is the verdict of
 * the same chain written once: read to the end up to 32 hops, refused at 33.
 *
 * The D family is shared actions that are not fan-out: a diamond, and a ladder
 * of diamonds, where two routes meet again and again.
 *
 * The O family is the ordering adversary. One action is reached by a short route
 * and by a long one, and a tail hangs below it. Whether the long route fits under
 * the bound depends on the tail; the short one always does. Written both ways
 * round — the short route listed first, and the long one — so that the verdict
 * cannot depend on which the walk happens to try first. An implementation that
 * remembers the *shallowest* depth an action was read at and skips every later
 * arrival reads the short route, finds that it fits, and accepts a document with
 * a chain of more than 32 hops. The `-over` fixtures are that document.
 *
 * The C family is cycles, written so that a walk which took "already visited" for
 * "safe" would call them acyclic: a fan-out chain that returns to its start, two
 * actions that name each other twice, and an indirect list whose members are
 * direct dictionaries that name the list — a cycle with no indirect action in it.
 *
 * The S family is one action reached from two annotations: the page reference
 * below it is a loss on each, and sharing what has been read must not merge them.
 *
 * Written by hand, like Rounds 7 to 12: pdf-lib normalises most of these shapes
 * away.
 *
 * Run:  node scripts/make-m6-round12b-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-fixtures', 'm6-split-merge-production');
fs.mkdirSync(OUT, { recursive: true });

const written = [];

const latin1 = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
    return out;
};

/** A document from explicit numbered objects, with a real cross-reference table. */
function doc(objects, { root = 1 } = {}) {
    const nums = [...objects.keys()].sort((a, b) => a - b);
    const max = nums[nums.length - 1];
    let body = '%PDF-1.7\n';
    const offsets = new Map();
    for (const n of nums) {
        offsets.set(n, body.length);
        body += `${n} 0 obj\n${objects.get(n)}\nendobj\n`;
    }
    const xrefAt = body.length;
    body += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= max; n += 1) {
        body += offsets.has(n)
            ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`
            : '0000000000 65535 f \n';
    }
    body += `trailer\n<< /Size ${max + 1} /Root ${root} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return latin1(body);
}

const stream = (dict, content) => {
    const inner = dict.replace(/>>\s*$/, '').trimEnd();
    return `${inner} /Length ${content.length} >>\nstream\n${content}\nendstream`;
};

const write = (name, bytes) => {
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), Buffer.from(bytes));
    written.push(name);
};

/** A green bar and a blue square, so a page that came out blank is not mistaken for a pass. */
const PAINT = '0 1 0 rg 10 170 180 20 re f\n0 0 1 rg 60 60 80 80 re f';
const SCRIPT = (marker) => `(app.alert\\(${marker}\\))`;
const JS_ACTION = (marker, tail = '') => `<< /Type /Action /S /JavaScript /JS ${SCRIPT(marker)}${tail} >>`;
const LINK = (tail) => `<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] ${tail} >>`;
const URI = (tail = '') => `<< /Type /Action /S /URI /URI (https://example.invalid/)${tail} >>`;
/** A page reference: object 3 is the page, so this is an internal link the copy has to rebuild or drop. */
const GOTO = (tail = '') => `<< /Type /Action /S /GoTo /D [3 0 R /Fit]${tail} >>`;

/** Catalog, one page whose annotations are `annots`, content as object 4. `extra` adds numbered objects. */
function page({ annots = [8], extra = {} }) {
    const o = new Map();
    o.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    o.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    o.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}] >>`);
    o.set(4, stream('<< >>', PAINT));
    for (const [k, v] of Object.entries(extra)) o.set(Number(k), v);
    return doc(o);
}

// ---------------------------------------------------------------------------
// F — fan-out: each /Next names the next action more than once
// ---------------------------------------------------------------------------

/**
 * `levels` hops — `levels + 1` actions, objects 40 to `40 + levels` — held by an
 * annotation's `/A`, each `/Next` a list that names the following action `width`
 * times. `indirect` writes each list as an object of its own. `end` is the last
 * action. Distinct actions: `levels + 1`. Distinct paths: `width ** levels`.
 */
function fan(levels, width, { end = URI(), indirect = false } = {}) {
    const extra = { 8: LINK('/A 40 0 R') };
    for (let k = 0; k <= levels; k += 1) {
        if (k === levels) {
            extra[40 + k] = end;
            continue;
        }
        const member = `${41 + k} 0 R`;
        const list = `[${Array(width).fill(member).join(' ')}]`;
        if (indirect) {
            extra[200 + k] = list;
            extra[40 + k] = URI(` /Next ${200 + k} 0 R`);
        } else {
            extra[40 + k] = URI(` /Next ${list}`);
        }
    }
    return page({ extra });
}

write('r12b-f1-fan2-16', fan(16, 2));
write('r12b-f2-fan2-24', fan(24, 2));
write('r12b-f3-fan2-32', fan(32, 2));
write('r12b-f3-fan2-32-js', fan(32, 2, { end: JS_ACTION('M6R12B_F3') }));
write('r12b-f4-fan3-16', fan(16, 3));
write('r12b-f4-fan3-16-indirect', fan(16, 3, { indirect: true }));
write('r12b-f4-fan2-16-goto', fan(16, 2, { end: GOTO() }));
write('r12b-f5-siblings-64', fan(5, 64));
write('r12b-f10-fan2-33', fan(33, 2));
write('r12b-f10-fan2-33-js', fan(33, 2, { end: JS_ACTION('M6R12B_F10') }));

// ---------------------------------------------------------------------------
// D — shared actions that are not fan-out
// ---------------------------------------------------------------------------

/** A -> [B, C], B -> D, C -> D, D -> E. Five actions, two paths to E. */
function diamond(end) {
    return page({
        extra: {
            8: LINK('/A 40 0 R'),
            40: URI(' /Next [41 0 R 42 0 R]'),
            41: URI(' /Next 43 0 R'),
            42: URI(' /Next 43 0 R'),
            43: URI(' /Next 44 0 R'),
            44: end,
        },
    });
}
write('r12b-d-diamond', diamond(URI()));
write('r12b-d-diamond-js', diamond(JS_ACTION('M6R12B_D')));

/**
 * `stages` diamonds in series: X(k) -> [B(k), C(k)], each of which -> X(k+1). Two
 * hops a stage, `3 * stages + 1` actions, `2 ** stages` paths.
 */
function ladder(stages, end = URI()) {
    const extra = { 8: LINK('/A 40 0 R') };
    for (let k = 0; k <= stages; k += 1) {
        const x = 40 + 3 * k;
        if (k === stages) {
            extra[x] = end;
            continue;
        }
        extra[x] = URI(` /Next [${x + 1} 0 R ${x + 2} 0 R]`);
        extra[x + 1] = URI(` /Next ${x + 3} 0 R`);
        extra[x + 2] = URI(` /Next ${x + 3} 0 R`);
    }
    return page({ extra });
}
write('r12b-d-ladder-16', ladder(16));
write('r12b-d-ladder-16-js', ladder(16, JS_ACTION('M6R12B_L16')));
write('r12b-d-ladder-17', ladder(17));

// ---------------------------------------------------------------------------
// O — one action reached by a short route and a long one, in both orders
// ---------------------------------------------------------------------------

/**
 * R0 -> [S, L1] (or the other way round); L1 -> ... -> L(long) -> S; S -> T1 -> ... -> T(tail).
 * S is at depth 1 by the short route and depth `long + 1` by the long one, so the
 * deepest action is `long + 1 + tail` hops from the start by the long route, and
 * `1 + tail` by the short one. With `long` 28: 32 hops for a tail of 3, and 33 for
 * a tail of 4.
 */
function shared({ deepFirst, tail, long = 28 }) {
    const S = 100;
    const extra = { 8: LINK('/A 40 0 R') };
    const shortRoute = `${S} 0 R`;
    const longRoute = `41 0 R`;
    extra[40] = URI(` /Next [${deepFirst ? `${longRoute} ${shortRoute}` : `${shortRoute} ${longRoute}`}]`);
    for (let i = 1; i <= long; i += 1) {
        extra[40 + i] = URI(` /Next ${i === long ? S : 41 + i} 0 R`);
    }
    extra[S] = tail === 0 ? URI() : URI(` /Next ${S + 1} 0 R`);
    for (let t = 1; t <= tail; t += 1) extra[S + t] = t === tail ? URI() : URI(` /Next ${S + t + 1} 0 R`);
    return page({ extra });
}
write('r12b-o-shallow-first-ok', shared({ deepFirst: false, tail: 3 }));
write('r12b-o-deep-first-ok', shared({ deepFirst: true, tail: 3 }));
write('r12b-o-shallow-first-over', shared({ deepFirst: false, tail: 4 }));
write('r12b-o-deep-first-over', shared({ deepFirst: true, tail: 4 }));

// ---------------------------------------------------------------------------
// C — cycles that a walk taking "already visited" for "safe" would call acyclic
// ---------------------------------------------------------------------------

/** A ten-action fan-out chain whose last action names the first again. */
{
    const extra = { 8: LINK('/A 40 0 R') };
    for (let k = 0; k < 10; k += 1) {
        const next = k === 9 ? '40 0 R' : `${41 + k} 0 R`;
        extra[40 + k] = URI(` /Next [${next} ${next}]`);
    }
    write('r12b-c-fan-cycle', page({ extra }));
}
/** Two actions that each name the other twice. */
write('r12b-c-mutual', page({
    extra: { 8: LINK('/A 40 0 R'), 40: URI(' /Next [41 0 R 41 0 R]'), 41: URI(' /Next [40 0 R 40 0 R]') },
}));
/** An indirect list whose members are direct dictionaries that name the list: no indirect action is in the cycle. */
write('r12b-c-list-cycle', page({
    extra: {
        8: LINK('/A 40 0 R'),
        40: URI(' /Next 50 0 R'),
        50: `[${URI(' /Next 50 0 R')} ${URI(' /Next 50 0 R')}]`,
    },
}));

// ---------------------------------------------------------------------------
// S — one action reached from two annotations
// ---------------------------------------------------------------------------

/** Both annotations' `/A` name action 40, whose `/Next` is a link to a page: a loss on each. */
write('r12b-s-two-roots-goto', page({
    annots: [8, 9],
    extra: { 8: LINK('/A 40 0 R'), 9: LINK('/A 40 0 R'), 40: URI(' /Next 41 0 R'), 41: GOTO() },
}));

console.log(`wrote ${written.length} fixtures to ${path.relative(ROOT, OUT)}`);
console.log(written.join('\n'));
