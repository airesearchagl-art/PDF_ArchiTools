/**
 * A disposable Worker for one Split step — the B3 containment spike.
 *
 * Not production code. B3 was accepted with a defence order: a pre-parse hard
 * boundary first, a disposable Worker second. This module is the second half,
 * built to answer what a Worker can add and — as importantly — what it cannot:
 *
 *   - the input arrives as a transferred ArrayBuffer, so the page does not keep
 *     a second copy;
 *   - the optional preflight runs here, before `PDFDocument.load`, so a refusal
 *     happens inside the same containment as the load it prevents;
 *   - a `started` message is posted immediately before `PDFDocument.load`, so
 *     the page can tell a load in progress from a Worker still starting up, and
 *     a refusal from a load;
 *   - the output leaves as a transferred ArrayBuffer;
 *   - every failure the code can see is posted as a typed message.
 *
 * What it cannot add is a memory ceiling. A Worker has no standard per-worker
 * limit, and an allocation that exhausts memory ends the Worker — or the page —
 * without passing through any catch below. That is why a Worker alone does not
 * close B3.
 */
import { PDFDocument } from 'pdf-lib';
import { inspectLoadBoundary } from '../prototype/load-boundary.mjs';

// A rejection nothing awaits raises no `error` event on the Worker: it reaches
// the page as nothing. This listener turns it into a typed failure.
self.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    self.postMessage({ id: null, type: 'failed', code: 'UNHANDLED_REJECTION', message: String(event.reason?.message ?? event.reason).slice(0, 200) });
});

self.onmessage = (event) => {
    const { op } = event.data;
    if (op === 'throw') {
        // Thrown synchronously and uncaught, on purpose: the page must see this
        // as an `error` event and turn it into a typed failure itself. Thrown
        // from an async handler it would be a rejection instead.
        throw new Error('deliberate uncaught error in the worker');
    }
    if (op === 'reject') {
        Promise.reject(new Error('deliberate unhandled rejection in the worker'));
        return;
    }
    split(event.data);
};

async function split({ id, bytes, pages = [0], preflight = false, limits }) {
    try {
        const input = new Uint8Array(bytes);
        const receivedBytes = input.byteLength;

        let boundary = null;
        if (preflight) {
            boundary = await inspectLoadBoundary(input, limits);
            if (boundary.verdict !== 'PASS') {
                self.postMessage({ id, type: 'refused', receivedBytes, boundary });
                return;
            }
        }

        self.postMessage({ id, type: 'started' });
        const started = performance.now();
        const source = await PDFDocument.load(input, { updateMetadata: false });
        const output = await PDFDocument.create({ updateMetadata: false });
        const copied = await output.copyPages(source, pages);
        copied.forEach((page) => output.addPage(page));
        const saved = await output.save({ useObjectStreams: false });

        // Transfer exactly the saved bytes, never a larger backing buffer.
        const buffer = saved.byteOffset === 0 && saved.byteLength === saved.buffer.byteLength
            ? saved.buffer
            : saved.slice().buffer;
        self.postMessage({
            id,
            type: 'done',
            receivedBytes,
            boundary,
            outputByteLength: buffer.byteLength,
            elapsedMsMeasuredOnly: performance.now() - started,
        }, [buffer]);
        // After a transfer the sender's buffer is detached; report what is left.
        self.postMessage({ id, type: 'after-transfer', workerSideOutputByteLength: buffer.byteLength });
    } catch (error) {
        self.postMessage({ id, type: 'failed', code: 'LOAD_FAILED', message: String(error?.message ?? error).slice(0, 200) });
    }
}
