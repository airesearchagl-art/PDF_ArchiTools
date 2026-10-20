/*
 * 図面管理 (M7) only: the title-block recogniser's OCR Worker, reachable by the
 * page from its first line (RV-39-02; src/utils/drawing-set/ocr-workers.ts).
 *
 * tesseract.js's own worker script runs here unchanged, through importScripts --
 * as tesseract.js itself loads it in its blob mode. Before it, this joins the
 * BroadcastChannel the page named for this Worker alone (`channel`, in the
 * URL's fragment: never sent, so this script stays one cacheable file), says
 * it is alive, and on "close" says "closed" and closes itself. So a Worker
 * that is still starting, or whose start failed, can be ended although
 * tesseract.js has not handed the page its terminate() yet.
 *
 * Same origin only; nothing here reads or sends anything else.
 */
(function joinOwnersChannel() {
    var name = new URLSearchParams(self.location.hash.slice(1)).get('channel');
    if (!name || typeof BroadcastChannel !== 'function') return;
    var channel = new BroadcastChannel(name);
    channel.onmessage = function onOwnerMessage(event) {
        if (!event.data || event.data.type !== 'close') return;
        channel.postMessage({ type: 'closed' });
        channel.close();
        self.close();
    };
    channel.postMessage({ type: 'alive' });
})();

importScripts('/ocr/tesseract/worker.min.js');
