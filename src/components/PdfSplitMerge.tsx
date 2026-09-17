/**
 * PDF抽出・統合 — the M6 UI.
 *
 * What this replaces, and why each change is here rather than in a backlog:
 *
 *   - Every page was rendered to a Data URL up front, in a loop, with no cap and
 *     no cancellation. Measured, that retains 88,616 B per A4 page and 538,997 B
 *     per A1 sheet, 16.9 MiB for 200 A4 pages, and shows nothing for 1,727 ms on
 *     a 100-page file. M6-H12 adopts a windowed render with bounded Blob URLs
 *     owned by the run.
 *   - Nothing decided which run owned the screen, so the last writer won.
 *     M6-H13 adopts RunOwnership: a superseded run neither publishes nor
 *     downloads, revokes its Blob URLs, releases its thumbnails and destroys its
 *     PDF.js document.
 *   - A merge input whose MIME type was not `application/pdf` was skipped with a
 *     bare `continue`, and a failed load was swallowed into the console. Five
 *     files chosen, four merged, reported as success. M6-H10 adopts an explicit
 *     per-input typed result, shown.
 *   - Failures were `alert()`. They are typed refusals with a code and a
 *     sentence now, the way the Processor already shows them.
 *   - Object URLs were created and never revoked. They are revoked in a
 *     `finally`.
 *
 * The work itself runs in a disposable Worker (H11-B3-4) behind a pre-parse
 * Load Boundary (H11-B3-1). This component decides nothing about safety; it
 * shows what the contract decided.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Save, Upload, ArrowUp, ArrowDown, X, FileText, AlertTriangle } from 'lucide-react';
import { configurePdfWorker } from '../utils/pdf-worker-source';
import { VersionFooter } from './VersionFooter';
import { TOOL_VERSIONS } from '../config/versions';
import { RunOwnership } from '../utils/processor/ownership';
import {
    extractInWorker,
    intakeInWorker,
    mergeInWorker,
    planMerge,
    workerAvailable,
    runExtract,
    runMerge,
    intakeSources,
    m6SnapshotKey,
    M6Error,
    M6_STATUS,
    M6_LOSS_LABEL_JA,
    INTAKE_LABEL_JA,
    PROVISIONAL_POLICY,
} from '../utils/split-merge';

import type {
    ExtractResult,
    IntakeRecord,
    LossRecord,
    M6Snapshot,
    MergeResult,
} from '../utils/split-merge';

/**
 * H12's bound terms, given values.
 *
 * These are presentation limits, not the product load policy: none of them is a
 * B4 item, and none is derived from a memory preset. They exist so a 200-page
 * A1 set cannot make the page allocate without limit.
 */

const THUMBNAIL_BOUNDS = {

    /** Thumbnails held at once. Everything outside the window is released. */
    maxActive: 24,

    /** The long edge of a rendered thumbnail, in device pixels. */
    maxEdgePx: 420,

    /** A hard ceiling on one canvas, so a huge sheet cannot be asked for. */
    maxCanvasPixels: 1_200_000,
} as const;

interface MergeFileEntry {
    id: string;
    file: File;
    name: string;
    bytes: Uint8Array;
    intake?: IntakeRecord;
}

interface Notice {
    tone: 'error' | 'warn' | 'info';
    code?: string;
    text: string;
    losses?: LossRecord[];
}

/**
 * A bounded, run-owned thumbnail cache.
 *
 * Blob URLs rather than Data URLs, because P3 moves the image payload out of
 * the JS heap: measured, 0.4 MiB of Blob payload against 8.4 MiB of retained
 * Data-URL strings on the same source. The URL strings and their objects are
 * still held, which is why there is a cap as well as a format.
 */

class ThumbnailCache {
    private urls = new Map<number, string>();
    private order: number[] = [];
    get(pageNum: number): string | undefined {
        return this.urls.get(pageNum);
    }

    put(pageNum: number, url: string): void {
        if (this.urls.has(pageNum)) URL.revokeObjectURL(this.urls.get(pageNum) as string);
        this.urls.set(pageNum, url);
        this.order = this.order.filter((n) => n !== pageNum);
        this.order.push(pageNum);
        while (this.order.length > THUMBNAIL_BOUNDS.maxActive) {
            const evicted = this.order.shift();
            if (evicted === undefined) break;
            const stale = this.urls.get(evicted);
            if (stale) URL.revokeObjectURL(stale);
            this.urls.delete(evicted);
        }
    }

    /** Release everything. Called when the run that owns these is superseded. */
    clear(): void {
        for (const url of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear();
        this.order = [];
    }
}

export const PdfSplitMerge: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'extract' | 'merge'>('extract');

    // --- Extract state -----------------------------------------------------
    const [extractFile, setExtractFile] = useState<File | null>(null);
    const [extractBytes, setExtractBytes] = useState<Uint8Array | null>(null);
    const [pageCount, setPageCount] = useState(0);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [thumbnailSize, setThumbnailSize] = useState(150);
    const [thumbVersion, setThumbVersion] = useState(0);
    const [extractBusy, setExtractBusy] = useState(false);
    const [extractNotice, setExtractNotice] = useState<Notice | null>(null);
    const [pendingLosses, setPendingLosses] = useState<LossRecord[] | null>(null);

    // --- Merge state -------------------------------------------------------
    const [mergeFiles, setMergeFiles] = useState<MergeFileEntry[]>([]);
    const [mergeBusy, setMergeBusy] = useState(false);
    const [mergeNotice, setMergeNotice] = useState<Notice | null>(null);

    // --- Ownership (M6-H13) ------------------------------------------------
    const ownership = useRef(
        new RunOwnership<M6Snapshot>(
            m6SnapshotKey,
            () => new M6Error('操作が変更されたため、この処理は中止しました。', M6_STATUS.CANCELLED),
        ),
    );
    const thumbnails = useRef(new ThumbnailCache());
    const pdfDoc = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
    const inFlight = useRef<{ cancel: () => void } | null>(null);

    /**
     * Invalidate whatever is running and release what it owned.
     *
     * Everything H13 names happens here and nowhere else, so there is one place
     * to read and one place to get wrong.
     */
    const supersede = useCallback(() => {
        ownership.current.supersede();
        inFlight.current?.cancel();
        inFlight.current = null;
        thumbnails.current.clear();
        if (pdfDoc.current) {
            void pdfDoc.current.destroy();
            pdfDoc.current = null;
        }
    }, []);

    useEffect(() => supersede, [supersede]);
    const snapshot = useMemo<M6Snapshot>(() => ({
        operation: activeTab,
        fileIds: activeTab === 'extract'
            ? (extractFile ? [`${extractFile.name}:${extractFile.size}`] : [])
            : mergeFiles.map((f) => f.id),
        selection: [...selected].sort((a, b) => a - b).join(','),
        destinationPolicy: 'E2',
        metadataPolicy: 'M4',
        collisionPolicy: 'rename',
    }), [activeTab, extractFile, mergeFiles, selected]);

    // --- Thumbnails (M6-H12) -----------------------------------------------
    const renderThumbnail = useCallback(async (pageNum: number): Promise<void> => {
        const doc = pdfDoc.current;
        if (!doc || thumbnails.current.get(pageNum)) return;
        const page = await doc.getPage(pageNum);
        try {
            const base = page.getViewport({ scale: 1 });
            const longEdge = Math.max(base.width, base.height);
            let scale = THUMBNAIL_BOUNDS.maxEdgePx / longEdge;
            // The canvas ceiling wins over the edge target: an A1 sheet asked for
            // at the same edge length is a much larger canvas than an A4 one.
            const pixels = base.width * scale * base.height * scale;
            if (pixels > THUMBNAIL_BOUNDS.maxCanvasPixels) {
                scale *= Math.sqrt(THUMBNAIL_BOUNDS.maxCanvasPixels / pixels);
            }

            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            const context = canvas.getContext('2d');
            if (!context) return;
            await page.render({
                canvas,
                canvasContext: context,
                viewport,
            } as Parameters<typeof page.render>[0]).promise;

            const blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob(resolve, 'image/png');
            });

            // Release the canvas whatever happened: a retained canvas is retained
            // pixels, and this one has done its job.
            canvas.width = 0;
            canvas.height = 0;
            if (!blob) return;
            if (pdfDoc.current !== doc) return;
            thumbnails.current.put(pageNum, URL.createObjectURL(blob));
            setThumbVersion((v) => v + 1);
        } finally {

            page.cleanup();
        }
    }, []);

    const handleExtractUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        supersede();
        setExtractNotice(null);
        setPendingLosses(null);
        setSelected(new Set());
        setPageCount(0);
        setExtractFile(file);
        setExtractBusy(true);
        try {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            setExtractBytes(bytes);
            configurePdfWorker();
            // pdf.js is given its own copy: it detaches the buffer it is handed,
            // and the export path needs these bytes afterwards.
            const preview = new Uint8Array(bytes.length);
            preview.set(bytes);
            const doc = await pdfjsLib.getDocument({ data: preview }).promise;
            pdfDoc.current = doc;
            setPageCount(doc.numPages);
        } catch (error) {

            setExtractNotice({
                tone: 'error',
                code: 'UNSUPPORTED_DOCUMENT',
                text: 'このPDFを読み取れませんでした。',
            });

            console.error(error);
        } finally {

            setExtractBusy(false);
        }
    };

    const togglePage = (pageNum: number) => {
        // A selection change supersedes the run in flight: an export started
        // against a different selection must not publish.
        supersede();
        setPendingLosses(null);
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(pageNum)) next.delete(pageNum);
            else next.add(pageNum);
            return next;
        });
    };

    const applyExtractResult = (result: ExtractResult, token: { isCurrent(): boolean }) => {
        if (!token.isCurrent()) return;
        if (result.status === M6_STATUS.STRUCTURE_LOSS_REQUIRES_CONFIRMATION) {
            setPendingLosses(result.losses);
            setExtractNotice({
                tone: 'warn',
                code: result.status,
                text: result.reason ?? 'この抽出では一部の内容が失われます。',
                losses: result.losses,
            });
            return;
        }

        if (result.status !== M6_STATUS.READY || !result.bytes) {
            setExtractNotice({
                tone: 'error',
                code: result.status,
                text: result.reason ?? 'この操作は実行できませんでした。',
            });
            return;
        }

        let url: string | null = null;
        try {
            const blob = new Blob([result.bytes.slice().buffer as ArrayBuffer], {
                type: 'application/pdf',
            });

            if (!token.isCurrent()) return;
            url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = result.outputName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setExtractNotice({
                tone: 'info',
                text: `${result.outputName} を書き出しました。`,
                losses: result.losses,
            });
        } finally {

            if (url) URL.revokeObjectURL(url);
        }
    };

    const runExtractNow = async (confirmed: boolean) => {
        if (!extractBytes || !extractFile || selected.size === 0) return;
        const token = ownership.current.begin(snapshot);
        setExtractBusy(true);
        setExtractNotice(null);
        try {
            const selection = [...selected].map((n) => n - 1).sort((a, b) => a - b);
            const options = {
                sourceName: extractFile.name,
                selection,
                destinationPolicy: 'E2' as const,
                confirmedLosses: confirmed ? ['tagging', 'attachments'] : [],
            };

            const result = workerAvailable()
                ? await (() => {
                    const handle = extractInWorker(extractBytes, options);
                    inFlight.current = handle;
                    return handle.promise;
                })()

                : await runExtract(extractBytes, {
                    ...options,
                    stillOurs: () => token.isCurrent(),
                });

            inFlight.current = null;
            applyExtractResult(result, token);
        } finally {

            setExtractBusy(false);
        }
    };

    // --- Merge -------------------------------------------------------------
    const handleMergeUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length === 0) return;
        supersede();
        setMergeNotice(null);
        setMergeBusy(true);
        try {
            const entries: MergeFileEntry[] = [];
            for (const file of files) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                entries.push({
                    id: `${file.name}:${file.size}:${entries.length}:${Date.now()}`,
                    file,
                    name: file.name,
                    bytes,
                });
            }

            const token = ownership.current.begin({
                ...snapshot,
                fileIds: [...mergeFiles, ...entries].map((f) => f.id),
            });

            const inputs = entries.map((e) => ({
                id: e.id,
                name: e.name,
                type: e.file.type,
                bytes: e.bytes,
            }));

            const intake = workerAvailable()
                ? await (() => {
                    const handle = intakeInWorker(inputs);
                    inFlight.current = handle;
                    return handle.promise;
                })()

                : await intakeSources(inputs, { stillOurs: () => token.isCurrent() });
            inFlight.current = null;
            if (!token.isCurrent()) return;
            const byId = new Map(intake.map((r) => [r.id, r]));
            const withIntake = entries.map((e) => ({ ...e, intake: byId.get(e.id) }));
            setMergeFiles((prev) => [...prev, ...withIntake]);
            const rejected = intake.filter((r) => r.result !== 'ACCEPTED');
            if (rejected.length > 0) {
                setMergeNotice({
                    tone: 'warn',
                    text: `${rejected.length} 件のファイルは統合できません。一覧の理由を確認してください。`,
                });
            }
        } finally {

            setMergeBusy(false);
        }
    };

    const moveFile = (index: number, direction: 'up' | 'down') => {
        supersede();
        setMergeFiles((prev) => {
            const next = [...prev];
            const target = direction === 'up' ? index - 1 : index + 1;
            if (target < 0 || target >= next.length) return prev;
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };

    const removeFile = (id: string) => {
        supersede();
        setMergeFiles((prev) => prev.filter((f) => f.id !== id));
    };

    const applyMergeResult = (result: MergeResult, token: { isCurrent(): boolean }) => {
        if (!token.isCurrent()) return;
        if (result.status !== M6_STATUS.READY || !result.bytes) {
            setMergeNotice({
                tone: 'error',
                code: result.status,
                text: result.reason ?? 'この操作は実行できませんでした。',
            });
            return;
        }

        let url: string | null = null;
        try {
            const blob = new Blob([result.bytes.slice().buffer as ArrayBuffer], {
                type: 'application/pdf',
            });

            if (!token.isCurrent()) return;
            url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = result.outputName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            const omitted = result.intake.filter((r) => r.result !== 'ACCEPTED');
            setMergeNotice({
                tone: omitted.length > 0 ? 'warn' : 'info',
                text: omitted.length > 0
                    ? `${result.outputName} を書き出しました。${omitted.length} 件は含まれていません: `
                        + omitted.map((r) => r.name).join(', ')
                    : `${result.outputName} を書き出しました。`,
                losses: result.losses,
            });
        } finally {

            if (url) URL.revokeObjectURL(url);
        }
    };

    const runMergeNow = async () => {
        const accepted = mergeFiles.filter((f) => f.intake?.result === 'ACCEPTED');
        if (accepted.length === 0) {
            setMergeNotice({ tone: 'error', text: '統合できるPDFがありません。' });
            return;
        }

        const token = ownership.current.begin(snapshot);
        setMergeBusy(true);
        setMergeNotice(null);
        try {
            const inputs = mergeFiles.map((f) => ({
                id: f.id,
                name: f.name,
                type: f.file.type,
                bytes: f.bytes,
            }));

            const intake = mergeFiles
                .map((f) => f.intake)
                .filter((r): r is IntakeRecord => r !== undefined);
            const plan = planMerge(intake, { metadataPolicy: 'M4', collisionPolicy: 'rename' });
            const result = workerAvailable()
                ? await (() => {
                    const handle = mergeInWorker(inputs, plan, {
                        metadataPolicy: 'M4',
                        collisionPolicy: 'rename',
                    });

                    inFlight.current = handle;
                    return handle.promise;
                })()

                : await runMerge(inputs, plan, {
                    metadataPolicy: 'M4',
                    collisionPolicy: 'rename',
                    stillOurs: () => token.isCurrent(),
                });

            inFlight.current = null;
            applyMergeResult(result, token);
        } finally {

            setMergeBusy(false);
        }
    };

    // --- Rendering ---------------------------------------------------------
    const pageNumbers = useMemo(
        () => Array.from({ length: pageCount }, (_v, i) => i + 1),
        [pageCount],
    );
    const noticeStyle = (tone: Notice['tone']): React.CSSProperties => ({
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
        padding: '12px 14px',
        marginBottom: '14px',
        borderRadius: '6px',
        border: `1px solid ${tone === 'error' ? '#e0b4b4' : tone === 'warn' ? '#e6d2a8' : '#cfe3d0'}`,
        backgroundColor: tone === 'error' ? '#fdf2f2' : tone === 'warn' ? '#fdf8ec' : '#f2f9f3',
        color: '#333',
        fontSize: '0.92em',
    });

    const renderNotice = (notice: Notice | null) => {
        if (!notice) return null;
        return (
            <div style={noticeStyle(notice.tone)} data-usage-target="m6-notice">
                <AlertTriangle
                    size={18}
                    style={{ flexShrink: 0, marginTop: '2px', color: notice.tone === 'error' ? '#b23' : '#a80' }}
                />
                <div>
                    {notice.code && (
                        <code style={{ marginRight: 8, fontSize: '0.85em', color: '#666' }}>{notice.code}</code>
                    )}
                    <span>{notice.text}</span>
                    {notice.losses && notice.losses.length > 0 && (
                        <ul style={{ margin: '8px 0 0', paddingLeft: '18px' }}>
                            {notice.losses.slice(0, 8).map((loss, i) => (
                                <li key={`${loss.kind}-${i}`}>
                                    {M6_LOSS_LABEL_JA[loss.kind]}
                                    {loss.what ? `（${loss.what}）` : ''} — {loss.why}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        );
    };
    return (
        <div style={{ padding: '20px', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div data-usage-target="split-tabs" style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <button
                    onClick={() => { supersede(); setActiveTab('extract'); }}
                    style={{
                        padding: '10px 20px', border: 'none', borderRadius: '5px',
                        backgroundColor: activeTab === 'extract' ? '#4a90e2' : '#eee',
                        color: activeTab === 'extract' ? 'white' : 'black',
                        cursor: 'pointer', fontWeight: 'bold',
                    }}

                >
                    PDF抽出 (Extract)
                </button>
                <button
                    onClick={() => { supersede(); setActiveTab('merge'); }}
                    style={{
                        padding: '10px 20px', border: 'none', borderRadius: '5px',
                        backgroundColor: activeTab === 'merge' ? '#4a90e2' : '#eee',
                        color: activeTab === 'merge' ? 'white' : 'black',
                        cursor: 'pointer', fontWeight: 'bold',
                    }}

                >
                    PDF統合 (Merge)
                </button>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {activeTab === 'extract' && (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <div
                            data-usage-target="extract-source"
                            style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}
                        >
                            <label
                                className="button-primary"
                                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', padding: '10px 15px', backgroundColor: '#333', color: 'white', borderRadius: '5px' }}
                            >
                                <Upload size={18} />
                                PDFをアップロード
                                <input type="file" accept="application/pdf" onChange={handleExtractUpload} style={{ display: 'none' }} />
                            </label>
                            {extractFile && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ fontSize: '0.9em', whiteSpace: 'nowrap' }}>表示サイズ:</span>
                                    <input
                                        type="range"
                                        min="100"
                                        max="1000"
                                        value={thumbnailSize}
                                        onChange={(e) => setThumbnailSize(parseInt(e.target.value, 10))}
                                        style={{ width: '150px', cursor: 'pointer' }}
                                    />
                                    <span style={{ fontSize: '0.8em', color: '#666' }}>{thumbnailSize}px</span>
                                </div>
                            )}
                            {extractFile && <span>Current: {extractFile.name}</span>}
                            {selected.size > 0 && (
                                <button
                                    data-usage-target="extract-export"
                                    onClick={() => void runExtractNow(pendingLosses !== null)}
                                    disabled={extractBusy}
                                    style={{
                                        marginLeft: 'auto', padding: '10px 20px',
                                        backgroundColor: pendingLosses ? '#c9791b' : '#28a745',
                                        color: 'white', border: 'none', borderRadius: '5px',
                                        cursor: extractBusy ? 'default' : 'pointer',
                                        opacity: extractBusy ? 0.6 : 1,
                                        display: 'flex', alignItems: 'center', gap: '5px',
                                    }}

                                >
                                    <Save size={18} />
                                    {pendingLosses ? '内容を了承して書き出し' : '選択したページを書き出し'}
                                </button>
                            )}
                        </div>
                        {renderNotice(extractNotice)}
                        {extractBusy && <div>処理中 / Working...</div>}
                        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: '5px', padding: '20px' }}>
                            {!extractFile && (
                                <div style={{ textAlign: 'center', marginTop: '50px', color: '#999' }}>
                                    PDFをアップロードしてください
                                </div>
                            )}
                            <div
                                data-usage-target="extract-pages"
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))`,
                                    gap: '20px',
                                    placeItems: 'start center',
                                }}

                            >
                                {pageNumbers.map((pageNum) => (
                                    <PageCell
                                        key={pageNum}
                                        pageNum={pageNum}
                                        selected={selected.has(pageNum)}
                                        url={thumbnails.current.get(pageNum)}
                                        version={thumbVersion}
                                        onVisible={renderThumbnail}
                                        onToggle={togglePage}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                )}
                {activeTab === 'merge' && (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <div data-usage-target="merge-source" style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <label
                                className="button-primary"
                                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', padding: '10px 15px', backgroundColor: '#333', color: 'white', borderRadius: '5px' }}
                            >
                                <Upload size={18} />
                                追加 PDF アップロード
                                {/* Every chosen file is reported, whatever its type, so the
                                    picker is not the thing that silently drops one. */}
                                <input type="file" multiple onChange={handleMergeUpload} style={{ display: 'none' }} />
                            </label>
                            {mergeFiles.length > 0 && (
                                <button
                                    data-usage-target="merge-export"
                                    onClick={() => void runMergeNow()}
                                    disabled={mergeBusy}
                                    style={{
                                        marginLeft: 'auto', padding: '10px 20px',
                                        backgroundColor: '#28a745', color: 'white',
                                        border: 'none', borderRadius: '5px',
                                        cursor: mergeBusy ? 'default' : 'pointer',
                                        opacity: mergeBusy ? 0.6 : 1,
                                        display: 'flex', alignItems: 'center', gap: '5px',
                                    }}

                                >
                                    <Save size={18} />
                                    統合 PDF を書き出し
                                </button>
                            )}
                        </div>
                        {renderNotice(mergeNotice)}
                        {mergeBusy && <div>処理中 / Working...</div>}
                        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ddd', borderRadius: '5px', padding: '20px' }}>
                            {mergeFiles.length === 0 && (
                                <div style={{ textAlign: 'center', marginTop: '50px', color: '#999' }}>
                                    統合するPDFファイルを追加してください
                                </div>
                            )}
                            <div data-usage-target="merge-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {mergeFiles.map((file, index) => {
                                    const accepted = file.intake?.result === 'ACCEPTED';
                                    return (
                                        <div
                                            key={file.id}
                                            style={{
                                                display: 'flex', alignItems: 'center', padding: '15px',
                                                border: `1px solid ${accepted ? '#eee' : '#e0b4b4'}`,
                                                borderRadius: '5px',
                                                backgroundColor: accepted ? 'white' : '#fdf2f2',
                                                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                                            }}

                                        >
                                            <div style={{ marginRight: '15px', color: '#666', fontWeight: 'bold' }}>{index + 1}</div>
                                            <FileText size={24} style={{ marginRight: '15px', color: accepted ? '#4a90e2' : '#b23' }} />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 'bold', color: 'black' }}>{file.name}</div>
                                                <div style={{ fontSize: '0.9em', color: '#666' }}>
                                                    {file.intake
                                                        ? `${INTAKE_LABEL_JA[file.intake.result]}`
                                                            + (accepted ? ` — ${file.intake.pageCount} ページ` : '')
                                                        : '確認中…'}
                                                </div>
                                                {file.intake?.reason && (
                                                    <div style={{ fontSize: '0.85em', color: '#b23', marginTop: '2px' }}>
                                                        <code style={{ marginRight: 6 }}>{file.intake.result}</code>
                                                        {file.intake.reason}
                                                    </div>
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', gap: '5px' }}>
                                                <button
                                                    onClick={() => moveFile(index, 'up')}
                                                    disabled={index === 0}
                                                    style={{ padding: '5px', cursor: index === 0 ? 'default' : 'pointer', opacity: index === 0 ? 0.3 : 1 }}
                                                    title="Move Up"
                                                >
                                                    <ArrowUp size={18} />
                                                </button>
                                                <button
                                                    onClick={() => moveFile(index, 'down')}
                                                    disabled={index === mergeFiles.length - 1}
                                                    style={{ padding: '5px', cursor: index === mergeFiles.length - 1 ? 'default' : 'pointer', opacity: index === mergeFiles.length - 1 ? 0.3 : 1 }}
                                                    title="Move Down"
                                                >
                                                    <ArrowDown size={18} />
                                                </button>
                                                <button
                                                    onClick={() => removeFile(file.id)}
                                                    style={{ padding: '5px', marginLeft: '10px', color: 'red', cursor: 'pointer' }}
                                                    title="Remove"
                                                >
                                                    <X size={18} />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}

                            </div>
                        </div>
                    </div>
                )}
            </div>
            <div style={{ fontSize: '0.75em', color: '#999', marginTop: '6px' }}>
                安全上の上限値は暫定です（B4 未決定 / {PROVISIONAL_POLICY.origin}）。
            </div>
            <VersionFooter
                toolName="splitMerge"
                version={TOOL_VERSIONS.splitMerge.version}
                lastUpdate={TOOL_VERSIONS.splitMerge.lastUpdate}
            />
        </div>
    );
};

/**
 * One page cell, which asks for its thumbnail only once it is on screen.
 *
 * This is the windowing: a 200-page document renders the pages a person is
 * looking at, not all of them, and the cache above releases what scrolls away.
 */

const PageCell: React.FC<{
    pageNum: number;
    selected: boolean;
    url: string | undefined;
    version: number;
    onVisible: (pageNum: number) => Promise<void>;
    onToggle: (pageNum: number) => void;
}> = ({ pageNum, selected, url, onVisible, onToggle }) => {

    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const element = ref.current;
        if (!element || typeof IntersectionObserver === 'undefined') {
            void onVisible(pageNum);
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) void onVisible(pageNum);
            }
        }, { rootMargin: '300px' });

        observer.observe(element);
        return () => observer.disconnect();
    }, [pageNum, onVisible]);
    return (
        <div
            ref={ref}
            onClick={() => onToggle(pageNum)}
            style={{
                border: selected ? '3px solid #4a90e2' : '1px solid #ddd',
                borderRadius: '5px', padding: '10px', cursor: 'pointer',
                backgroundColor: selected ? '#e6f2ff' : 'white',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                transition: 'all 0.2s', width: '100%', boxSizing: 'border-box',
                minHeight: '120px',
            }}

        >
            <div style={{ marginBottom: '5px', fontWeight: 'bold' }}>Page {pageNum}</div>
            {url
                ? <img src={url} alt={`Page ${pageNum}`} style={{ maxWidth: '100%', border: '1px solid #eee' }} />
                : <div style={{ color: '#bbb', fontSize: '0.85em', padding: '24px 0' }}>…</div>}
            <input
                type="checkbox"
                checked={selected}
                readOnly
                style={{ marginTop: '10px', transform: 'scale(1.5)', pointerEvents: 'none' }}
            />
        </div>
    );
};
