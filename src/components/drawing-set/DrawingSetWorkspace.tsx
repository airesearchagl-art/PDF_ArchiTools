import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, FilePlus2, FolderOpen, Layers, RotateCcw, Square, X } from 'lucide-react';
import { VersionFooter } from '../VersionFooter';
import { TOOL_VERSIONS } from '../../config/versions';
import { displaySafeFileName, IntakeStop } from '../../utils/drawing-set/intake-policy';
import type { DrawingSetSession, Sheet, Source } from '../../utils/drawing-set/model';
import { commitSourceCandidate, createSession, isLive, liveSheets, liveSources, retireSource } from '../../utils/drawing-set/model';
import { displayOrientation, displaySizeMm, ORIENTATION_LABEL, paperSizeName } from '../../utils/drawing-set/page-facts';
import { PreviewDocumentOwner } from '../../utils/drawing-set/preview-document';
import type { IntakeOutcome, IntakeProgress } from '../../utils/drawing-set/source-intake';
import { intakeSource } from '../../utils/drawing-set/source-intake';
import { ReadOnlySheetViewer } from './ReadOnlySheetViewer';
import { VirtualSheetList } from './VirtualSheetList';
import './DrawingSetWorkspace.css';

/**
 * 図面管理 (M7-P1): a new, in-memory Drawing Set.
 *
 * PDFs are taken in one at a time, each as one transaction (source-intake):
 * fingerprinted, opened, counted and inventoried, then added with all of its
 * Sheets or not at all. The Sheet List shows every live Sheet; the viewer shows
 * the selected page, read-only; the right pane shows facts, nothing more.
 *
 * Ownership. Every long-running piece of work belongs to a generation of this
 * workspace. Cancelling, starting a new Drawing Set or leaving the workspace
 * moves to a new generation and aborts the old one's work, and nothing the old
 * generation finishes afterwards is published: no Source, no Sheet, no viewer
 * state, no error.
 *
 * Runtime handles -- each Source's File, the one preview document -- live next
 * to the model, never in it, and go away with the session. Nothing is stored
 * anywhere: no browser storage, no server, no file.
 */

type ItemState = 'queued' | 'processing' | 'accepted' | 'duplicate' | 'refused' | 'cancelled';

interface IntakeItem {
    id: number;
    /** File.name made safe to display. Never a path. */
    name: string;
    size: number;
    state: ItemState;
    detail: string;
    progress: string;
}

type SessionState = { ok: true; session: DrawingSetSession } | { ok: false; message: string };

type Confirmation = { kind: 'reset' } | { kind: 'remove'; sourceId: string } | null;

const startSession = (): SessionState => {
    try {
        return { ok: true, session: createSession() };
    } catch (error) {
        const message = error instanceof IntakeStop && error.refusal ? error.refusal.message : '図面一式を開始できませんでした。';
        return { ok: false, message };
    }
};

const MiB = 1024 * 1024;
const formatBytes = (bytes: number): string =>
    bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

const progressLabel = (progress: IntakeProgress): string => {
    switch (progress.phase) {
        case 'reading':
            return `読み込み・識別情報の計算 ${progress.bytesTotal > 0 ? Math.floor((progress.bytesDone / progress.bytesTotal) * 100) : 0}%`;
        case 'opening':
            return 'PDFを開いています';
        case 'inventory':
            return `ページ情報を確認中 ${progress.pagesDone} / ${progress.pagesTotal}`;
    }
};

const ITEM_LABEL: Record<ItemState, string> = {
    queued: '待機中',
    processing: '処理中',
    accepted: '追加',
    duplicate: '重複',
    refused: '読み込めません',
    cancelled: '中止',
};

/** How many per-file results to show; older ones are summarised as a count. */
const VISIBLE_RESULTS = 200;

/**
 * One preview owner for the page, not one per visit to the workspace. Leaving
 * the workspace still destroys its document; but a document PDF.js could not
 * destroy outlives the workspace, and a fresh owner would open another beside it.
 */
const pageOwner = new PreviewDocumentOwner();

export const DrawingSetWorkspace: React.FC = () => {
    const [sessionState, setSessionState] = useState<SessionState>(startSession);
    const [files, setFiles] = useState<ReadonlyMap<string, File>>(() => new Map());
    const [items, setItems] = useState<IntakeItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<Confirmation>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [showFullSha, setShowFullSha] = useState(false);
    const owner = pageOwner;

    // Runtime ownership. Read and written by handlers and the intake loop only.
    const sessionRef = useRef<DrawingSetSession | null>(sessionState.ok ? sessionState.session : null);
    const queueRef = useRef<{ itemId: number; file: File }[]>([]);
    const generationRef = useRef(0);
    const controllerRef = useRef<AbortController | null>(null);
    const pumpingRef = useRef(false);
    /**
     * Settles when the last intake started has finished, including one that
     * was abandoned by a stop or a reset and is still letting go of its
     * buffer: the next file waits for it, so two never overlap.
     */
    const intakeDoneRef = useRef<Promise<void>>(Promise.resolve());
    const itemCounterRef = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // Leaving the workspace ends everything it started.
    useEffect(() => {
        const generation = generationRef;
        const controller = controllerRef;
        const queue = queueRef;
        const pumping = pumpingRef;
        return () => {
            generation.current += 1;
            controller.current?.abort();
            controller.current = null;
            queue.current = [];
            pumping.current = false;
            owner.close();
        };
    }, [owner]);

    const publish = (next: DrawingSetSession): void => {
        sessionRef.current = next;
        setSessionState({ ok: true, session: next });
    };

    const updateItem = (id: number, patch: Partial<IntakeItem>): void => {
        setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const settle = (itemId: number, file: File, outcome: IntakeOutcome): void => {
        switch (outcome.kind) {
            case 'candidate': {
                const session = sessionRef.current;
                if (!session) return;
                const result = commitSourceCandidate(session.drawingSet, outcome.candidate);
                if (result.kind === 'committed') {
                    const { source, sheets } = outcome.candidate;
                    setFiles((current) => new Map(current).set(source.id, file));
                    publish({ ...session, drawingSet: result.drawingSet });
                    setSelectedSheetId((current) => current ?? sheets[0]?.id ?? null);
                    updateItem(itemId, { state: 'accepted', detail: `${sheets.length} ページを追加しました。`, progress: '' });
                } else if (result.kind === 'duplicate') {
                    updateItem(itemId, {
                        state: 'duplicate',
                        detail: `同じ内容のファイル「${result.existing.displayName}」がすでにあるため、追加しませんでした。`,
                        progress: '',
                    });
                } else {
                    updateItem(itemId, { state: 'refused', detail: result.refusal.message, progress: '' });
                }
                return;
            }
            case 'duplicate':
                updateItem(itemId, {
                    state: 'duplicate',
                    detail: `同じ内容のファイル「${outcome.existing.displayName}」がすでにあるため、追加しませんでした。`,
                    progress: '',
                });
                return;
            case 'refused':
                updateItem(itemId, { state: 'refused', detail: outcome.refusal.message, progress: '' });
                return;
            case 'cancelled':
                updateItem(itemId, { state: 'cancelled', detail: '中止しました。', progress: '' });
                return;
        }
    };

    /** Take queued files in, one at a time, for as long as this generation lasts. */
    const pump = async (): Promise<void> => {
        if (pumpingRef.current) return;
        pumpingRef.current = true;
        const generation = generationRef.current;
        const controller = new AbortController();
        controllerRef.current = controller;
        setBusy(true);
        try {
            for (;;) {
                if (generation !== generationRef.current) return;
                await intakeDoneRef.current;
                if (generation !== generationRef.current) return;
                const next = queueRef.current.shift();
                if (!next) break;
                updateItem(next.itemId, { state: 'processing', progress: '準備中' });
                let lastProgress = 0;
                const run = intakeSource(next.file, {
                    signal: controller.signal,
                    current: () => sessionRef.current!.drawingSet,
                    onProgress: (progress) => {
                        if (generation !== generationRef.current) return;
                        const now = performance.now();
                        const done = (progress.phase === 'reading' && progress.bytesDone === progress.bytesTotal)
                            || (progress.phase === 'inventory' && progress.pagesDone === progress.pagesTotal);
                        if (!done && progress.phase !== 'opening' && now - lastProgress < 100) return;
                        lastProgress = now;
                        updateItem(next.itemId, { progress: progressLabel(progress) });
                    },
                });
                intakeDoneRef.current = run.then(() => { }, () => { });
                const outcome = await run;
                // A run that is no longer this workspace's publishes nothing.
                if (generation !== generationRef.current || controller.signal.aborted) return;
                settle(next.itemId, next.file, outcome);
            }
        } finally {
            if (generation === generationRef.current) {
                pumpingRef.current = false;
                controllerRef.current = null;
                setBusy(false);
            }
        }
    };

    const addFiles = (list: FileList | null): void => {
        if (!list || list.length === 0 || !sessionRef.current) return;
        const picked = Array.from(list);
        const added: IntakeItem[] = picked.map((file) => {
            itemCounterRef.current += 1;
            return {
                id: itemCounterRef.current,
                name: displaySafeFileName(file.name),
                size: file.size,
                state: 'queued',
                detail: '',
                progress: '',
            };
        });
        queueRef.current.push(...picked.map((file, index) => ({ itemId: added[index].id, file })));
        setItems((current) => [...current, ...added]);
        setNotice(null);
        void pump();
    };

    /** Stop the file in progress and drop the queue. The Drawing Set is kept. */
    const stopProcessing = (): void => {
        generationRef.current += 1;
        controllerRef.current?.abort();
        controllerRef.current = null;
        queueRef.current = [];
        pumpingRef.current = false;
        setBusy(false);
        setItems((list) => list.map((item) => (
            item.state === 'queued' || item.state === 'processing'
                ? { ...item, state: 'cancelled', detail: '中止しました。', progress: '' }
                : item
        )));
    };

    const resetSession = (): void => {
        stopProcessing();
        owner.close();
        const next = startSession();
        sessionRef.current = next.ok ? next.session : null;
        setSessionState(next);
        setFiles(new Map());
        setItems([]);
        setSelectedSheetId(null);
        setConfirm(null);
        setShowFullSha(false);
        setNotice('新しい図面一式を始めました。前の図面一式の内容は破棄されました。');
    };

    const removeSource = (sourceId: string): void => {
        const session = sessionRef.current;
        setConfirm(null);
        if (!session) return;
        let drawingSet;
        try {
            drawingSet = retireSource(session.drawingSet, sourceId);
        } catch (error) {
            setNotice(error instanceof IntakeStop && error.refusal ? error.refusal.message : 'ファイルを外せませんでした。');
            return;
        }
        owner.closeIfSource(sourceId);
        setFiles((current) => {
            const next = new Map(current);
            next.delete(sourceId);
            return next;
        });
        publish({ ...session, drawingSet });
        const removed = session.drawingSet.sources.find((source) => source.id === sourceId);
        setSelectedSheetId((current) => {
            if (!current) return current;
            const sheet = drawingSet.sheets.find((candidate) => candidate.id === current);
            return sheet && isLive(sheet) ? current : drawingSet.sheets.find(isLive)?.id ?? null;
        });
        setNotice(removed ? `「${removed.displayName}」をこの図面一式から外しました。` : null);
    };

    const drawingSet = sessionState.ok ? sessionState.session.drawingSet : null;
    const sheets = useMemo(() => (drawingSet ? liveSheets(drawingSet) : []), [drawingSet]);
    const sources = useMemo(() => (drawingSet ? liveSources(drawingSet) : []), [drawingSet]);
    const sourcesById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
    const sourceNames = useMemo(() => new Map(sources.map((source) => [source.id, source.displayName])), [sources]);
    const sheetsById = useMemo(() => new Map(sheets.map((sheet) => [sheet.id, sheet])), [sheets]);

    const selectedSheet: Sheet | null = (selectedSheetId && sheetsById.get(selectedSheetId)) || null;
    const selectedSource: Source | null = selectedSheet ? sourcesById.get(selectedSheet.sourceId) ?? null : null;
    const selectedFile = selectedSource ? files.get(selectedSource.id) ?? null : null;

    const pending = items.filter((item) => item.state === 'queued' || item.state === 'processing').length;
    const current = items.find((item) => item.state === 'processing');
    const confirmSource = confirm?.kind === 'remove' ? sourcesById.get(confirm.sourceId) ?? null : null;

    const selectSheet = (sheetId: string): void => {
        if (sheetId !== selectedSheetId) setShowFullSha(false);
        setSelectedSheetId(sheetId);
    };

    const openPicker = (): void => inputRef.current?.click();

    const picker = (
        <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            data-ds-file-input
            onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
            }}
        />
    );

    if (!sessionState.ok) {
        return (
            <div className="ds-workspace" data-ds-root data-ds-state="failed">
                <div className="ds-empty">
                    <h2>図面管理</h2>
                    <p role="alert">{sessionState.message}</p>
                </div>
                <VersionFooter toolName="drawingSet" version={TOOL_VERSIONS.drawingSet.version} lastUpdate={TOOL_VERSIONS.drawingSet.lastUpdate} />
            </div>
        );
    }

    const resultsList = items.length > 0 && (
        <section className="ds-results" aria-label="読み込み結果" data-ds-results>
            <div className="ds-results-head">
                <span>読み込み結果</span>
                {items.length > VISIBLE_RESULTS && <span className="ds-muted">（新しい {VISIBLE_RESULTS} 件を表示、ほか {items.length - VISIBLE_RESULTS} 件）</span>}
            </div>
            <ul>
                {items.slice(-VISIBLE_RESULTS).reverse().map((item) => (
                    <li key={item.id} className={`ds-result is-${item.state}`} data-ds-result={item.state}>
                        <span className="ds-result-state">{ITEM_LABEL[item.state]}</span>
                        <span className="ds-result-name" title={item.name}>{item.name}</span>
                        <span className="ds-result-detail">{item.state === 'processing' ? item.progress : item.detail}</span>
                    </li>
                ))}
            </ul>
        </section>
    );

    const isEmpty = sources.length === 0 && !busy;

    return (
        <div
            className="ds-workspace"
            data-ds-root
            data-ds-state={busy ? 'busy' : 'idle'}
            data-ds-sources={sources.length}
            data-ds-sheets={sheets.length}
        >
            {picker}
            <header className="ds-header">
                <div className="ds-header-title">
                    <Layers size={20} />
                    <h2>{drawingSet!.name}</h2>
                    <span className="ds-unsaved" title="この図面一式はブラウザ内だけにあり、保存されません。ページを閉じたり、ほかのツールに切り替えたりすると消えます。">保存されません</span>
                </div>
                <div className="ds-header-stats">
                    <span>ファイル <b data-ds-count-sources>{sources.length}</b></span>
                    <span>ページ <b data-ds-count-sheets>{sheets.length}</b></span>
                    <span className="ds-status" data-ds-status>
                        {busy && current
                            ? `処理中: ${current.name}（${current.progress || '準備中'}）${pending > 1 ? ` ほか ${pending - 1} 件待ち` : ''}`
                            : '待機中'}
                    </span>
                </div>
                <div className="ds-header-actions">
                    <button type="button" className="ds-button is-primary" onClick={openPicker} data-ds-add>
                        <FilePlus2 size={16} /> PDFを追加
                    </button>
                    {busy && (
                        <button type="button" className="ds-button" onClick={stopProcessing} data-ds-stop>
                            <Square size={14} /> 処理を中止
                        </button>
                    )}
                    <button type="button" className="ds-button" onClick={() => setConfirm({ kind: 'reset' })} data-ds-reset>
                        <RotateCcw size={16} /> 新しい図面一式
                    </button>
                </div>
            </header>

            {confirm && (
                <div className="ds-confirm" role="alertdialog" aria-live="assertive" data-ds-confirm={confirm.kind}>
                    {confirm.kind === 'reset' ? (
                        <span>いまの図面一式を閉じて、新しく始めますか？読み込んだ内容は保存されず、元に戻せません（PDFファイル自体は変更されません）。</span>
                    ) : (
                        <span>「{confirmSource?.displayName ?? ''}」をこの図面一式から外しますか？このファイルのページは一覧から消えます（PDFファイル自体は変更されません）。</span>
                    )}
                    <button
                        type="button"
                        className="ds-button is-danger"
                        onClick={() => (confirm.kind === 'reset' ? resetSession() : removeSource(confirm.sourceId))}
                        data-ds-confirm-yes
                    >
                        {confirm.kind === 'reset' ? '新しく始める' : '外す'}
                    </button>
                    <button type="button" className="ds-button" onClick={() => setConfirm(null)} data-ds-confirm-no>
                        やめる
                    </button>
                </div>
            )}

            {notice && (
                <div className="ds-notice" role="status" data-ds-notice>
                    <span>{notice}</span>
                    <button type="button" className="ds-icon-button" onClick={() => setNotice(null)} aria-label="閉じる"><X size={14} /></button>
                </div>
            )}

            {isEmpty ? (
                <div className="ds-empty-wrap">
                    <div className="ds-empty" data-ds-empty>
                        <h2>図面管理</h2>
                        <p>図面一式を読み込み、ページ構成を確認します。</p>
                        <button type="button" className="ds-button is-primary is-large" onClick={openPicker} data-ds-pick>
                            <FolderOpen size={18} /> PDFを選択
                        </button>
                        <ul className="ds-empty-notes">
                            <li>処理はブラウザ内で行います。</li>
                            <li>PDFはサーバーへ送信しません。</li>
                            <li>複数のPDFをまとめて選べます。1ファイルずつ順に読み込みます。</li>
                            <li>読み込んだ内容は保存されません。ページを閉じたり、ほかのツールに切り替えたりすると消えます。</li>
                        </ul>
                    </div>
                    {resultsList}
                </div>
            ) : (
                <div className="ds-body">
                    <aside className="ds-left" aria-label="ファイルとページ">
                        <section className="ds-sources" aria-label="ファイル一覧" data-ds-source-list>
                            <div className="ds-pane-title">ファイル（{sources.length}）</div>
                            <ul>
                                {sources.map((source) => (
                                    <li
                                        key={source.id}
                                        className={`ds-source-row${selectedSource?.id === source.id ? ' is-selected' : ''}`}
                                        data-ds-source-row
                                        data-ds-source-id={source.id}
                                    >
                                        <button
                                            type="button"
                                            className="ds-source-open"
                                            title={source.displayName}
                                            onClick={() => {
                                                const first = sheets.find((sheet) => sheet.sourceId === source.id);
                                                if (first) selectSheet(first.id);
                                            }}
                                        >
                                            <span className="ds-source-name">{source.displayName}</span>
                                            <span className="ds-muted">{source.fingerprint.pageCount} ページ</span>
                                        </button>
                                        <button
                                            type="button"
                                            className="ds-icon-button"
                                            title="この図面一式から外す"
                                            aria-label={`「${source.displayName}」をこの図面一式から外す`}
                                            onClick={() => setConfirm({ kind: 'remove', sourceId: source.id })}
                                            data-ds-remove-source
                                        >
                                            <X size={14} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </section>
                        <div className="ds-pane-title">ページ一覧（{sheets.length}）</div>
                        <VirtualSheetList sheets={sheets} sourceNames={sourceNames} selectedSheetId={selectedSheet?.id ?? null} onSelect={selectSheet} />
                    </aside>

                    <section className="ds-center" aria-label="プレビュー（読み取り専用）">
                        {selectedSheet && selectedSource && selectedFile ? (
                            <ReadOnlySheetViewer
                                key={selectedSource.id}
                                owner={owner}
                                source={selectedSource}
                                file={selectedFile}
                                sheet={selectedSheet}
                                pageTotal={selectedSource.fingerprint.pageCount}
                            />
                        ) : (
                            <div className="ds-viewer-placeholder">{busy ? '読み込みが終わると、ここにページを表示します。' : '一覧からページを選ぶと、ここに表示します。'}</div>
                        )}
                    </section>

                    <aside className="ds-right" aria-label="ページとファイルの情報" data-ds-info>
                        {selectedSheet && selectedSource ? (
                            <SheetInfo sheet={selectedSheet} source={selectedSource} showFullSha={showFullSha} onToggleSha={() => setShowFullSha((value) => !value)} />
                        ) : (
                            <p className="ds-muted">ページを選ぶと、用紙サイズや回転などの情報を表示します。</p>
                        )}
                        {resultsList}
                    </aside>
                </div>
            )}
            <VersionFooter toolName="drawingSet" version={TOOL_VERSIONS.drawingSet.version} lastUpdate={TOOL_VERSIONS.drawingSet.lastUpdate} />
        </div>
    );
};

const SheetInfo: React.FC<{ sheet: Sheet; source: Source; showFullSha: boolean; onToggleSha: () => void }> = ({
    sheet,
    source,
    showFullSha,
    onToggleSha,
}) => {
    const facts = sheet.pageFacts;
    const sha = source.fingerprint.sha256;
    const paper = facts ? paperSizeName(facts.uprightWidthPt, facts.uprightHeightPt) : null;
    const [copied, setCopied] = useState<{ sha: string; ok: boolean } | null>(null);
    const copy = (): void => {
        const done = (ok: boolean): void => setCopied({ sha, ok });
        if (!navigator.clipboard) return done(false);
        navigator.clipboard.writeText(sha).then(() => done(true), () => done(false));
    };
    return (
        <div className="ds-info" data-ds-sheet-info>
            <div className="ds-pane-title">選択中のページ</div>
            <dl>
                <dt>ファイル</dt><dd title={source.displayName}>{source.displayName}</dd>
                <dt>ページ</dt><dd data-ds-info-page>{sheet.pageNumber} / {source.fingerprint.pageCount}</dd>
                {facts && (
                    <>
                        <dt>用紙</dt><dd data-ds-info-size>{paper ? `${paper}（${displaySizeMm(facts)}）` : displaySizeMm(facts)}</dd>
                        <dt>向き</dt><dd data-ds-info-orientation>{ORIENTATION_LABEL[displayOrientation(facts)]}</dd>
                        <dt>回転</dt><dd data-ds-info-rotate>{facts.rotate}°</dd>
                        <dt>テキスト</dt>
                        <dd data-ds-info-kind>
                            {facts.kind === 'text-native' ? 'あり（PDF内に読み取れるテキスト情報があります）' : 'なし（スキャン画像など、PDF内に読み取れるテキスト情報がありません）'}
                        </dd>
                    </>
                )}
            </dl>
            {facts && <p className="ds-muted ds-small">テキストの有無はPDF内の情報だけで判定しています。文字認識（OCR）は行っていません。</p>}

            <div className="ds-pane-title">ファイル</div>
            <dl>
                <dt>大きさ</dt><dd>{formatBytes(source.fingerprint.byteLength)}</dd>
                <dt>ページ数</dt><dd>{source.fingerprint.pageCount}</dd>
                <dt>SHA-256</dt>
                <dd className="ds-sha" data-ds-info-sha={sha}>
                    <code>{showFullSha ? sha : `${sha.slice(0, 16)}…`}</code>
                    <span className="ds-sha-actions">
                        <button type="button" className="ds-link-button" onClick={onToggleSha}>{showFullSha ? '短く表示' : '全体を表示'}</button>
                        <button type="button" className="ds-icon-button" onClick={copy} title="コピー" aria-label="SHA-256をコピー"><Copy size={13} /></button>
                        {copied && copied.sha === sha && (
                            <span className="ds-muted" role="status">{copied.ok ? 'コピーしました' : 'コピーできませんでした'}</span>
                        )}
                    </span>
                </dd>
            </dl>
            <p className="ds-muted ds-small">
                SHA-256はファイル内容の識別用の値です。同じ内容のファイルかどうかを確かめるために使います。署名や改ざん防止の証明ではありません。
            </p>
        </div>
    );
};
