import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Copy, FilePlus2, FolderOpen, Layers, RotateCcw, Square, X } from 'lucide-react';
import { VersionFooter } from '../VersionFooter';
import { TOOL_VERSIONS } from '../../config/versions';
import type { SourceBinding } from '../../utils/drawing-set/currency';
import { planCrop } from '../../utils/drawing-set/crop-service';
import { displaySafeFileName } from '../../utils/drawing-set/intake-policy';
import type { FieldName, Rect, Sheet, Source, TitleBlockProfile, TransferModel } from '../../utils/drawing-set/model';
import { FIELD_NAMES, isLive, liveSheets, liveSources } from '../../utils/drawing-set/model';
import { PAGE_PDF_GATE, PAGE_PREVIEW_OWNER } from '../../utils/drawing-set/page-documents';
import { displayOrientation, displaySizeMm, ORIENTATION_LABEL, paperSizeName } from '../../utils/drawing-set/page-facts';
import type { ViewerGeometry } from '../../utils/drawing-set/profile-pointer';
import { uprightSize } from '../../utils/drawing-set/profile-pointer';
import type { IntakeProgress } from '../../utils/drawing-set/source-intake';
import { findProfile } from '../../utils/drawing-set/title-block-profiles';
import type { StoreIntakeResult } from '../../utils/drawing-set/workspace-store';
import { DrawingSetStore, OCR_RELEASE_UNCONFIRMED_MESSAGE } from '../../utils/drawing-set/workspace-store';
import { GATE_MESSAGES } from '../../utils/drawing-set/pdf-document-gate';
import { ConfirmationPanel } from './ConfirmationPanel';
import { confirmationText, confirmedNumberTitle } from './title-block-labels';
import type { DraftFields } from './ProfileEditor';
import { FieldRectsOverlay, ProfileEditorPanel } from './ProfileEditor';
import { ReadOnlySheetViewer } from './ReadOnlySheetViewer';
import { TitleBlockPanel } from './TitleBlockPanel';
import type { SheetRowFacts } from './VirtualSheetList';
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
 * Ownership. The session -- the model, the File held for each Source and what
 * this session knows about it, and the lifecycle of the work in flight -- has
 * one synchronous writer, a DrawingSetStore, and this component renders its
 * snapshot. Cancelling, starting a new Drawing Set or leaving the workspace
 * ends the work in flight, and nothing it finishes afterwards is published: no
 * Source, no Sheet, no binding, no viewer state, no error. What is kept here
 * is the screen's own: the list of files picked and how each one went.
 *
 * The PDF.js document gate and the preview owner belong to the page
 * (page-documents.ts): intake, the preview and extraction take turns through
 * one gate, and a document PDF.js could not destroy stops all of them until
 * the page is reloaded, however often the workspace is left and opened again.
 *
 * Choosing a PDF whose bytes a live Source already has (M7-P2-B, HD-B-05)
 * adds nothing. If this session cannot vouch for that Source's File any more
 * -- it could not be read, or no longer holds those bytes -- the File chosen
 * stands for the Source from then on, its SHA-256 equal to the Source's
 * fingerprint: the same Source, the same Sheets.
 *
 * Runtime handles -- each Source's File, the one preview document -- live next
 * to the model, never in it, and go away with the session. Nothing is stored
 * anywhere: no browser storage, no server, no file.
 *
 * Title blocks (M7-P2-B2). A person draws a profile's four field rectangles
 * on the page in the viewer, ticks the Sheets it covers and assigns it, reads
 * them, and confirms each Sheet on its own against crops of the original
 * drawing (ConfirmationPanel). Every change goes through the store's
 * commands, which answer with a refusal the screen shows; nothing here calls
 * update(). While a reading runs the store is locked, and the screen says so.
 */

type Editor = { mode: 'create'; sheetId: string } | { mode: 'revise'; sheetId: string; profile: TitleBlockProfile } | null;

type ItemState = 'queued' | 'processing' | 'accepted' | 'reconnected' | 'duplicate' | 'refused' | 'cancelled';

interface IntakeItem {
    id: number;
    /** File.name made safe to display. Never a path. */
    name: string;
    size: number;
    state: ItemState;
    detail: string;
    progress: string;
}

type Confirmation = { kind: 'reset' } | { kind: 'remove'; sourceId: string } | null;

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
    reconnected: '再接続',
    duplicate: '重複',
    refused: '読み込めません',
    cancelled: '中止',
};

/** How many per-file results to show; older ones are summarised as a count. */
const VISIBLE_RESULTS = 200;

/**
 * What this session knows about each Source's File, in the Source list. Facts
 * about the bytes only: none of them says the drawing is right.
 */
const BINDING_LABEL: Record<SourceBinding | 'UNBOUND', { text: string; title: string }> = {
    MATCHED: {
        text: 'SHA-256一致',
        title: 'このファイルの内容（SHA-256）が、読み込んだときと同じであることを、この画面で確かめています。ページを閉じると消えます。',
    },
    UNBOUND: {
        text: '未照合',
        title: 'このファイルの内容（SHA-256）を、まだ照合していません。',
    },
    CHANGED: {
        text: 'SHA-256不一致',
        title: 'ファイルの内容（SHA-256）が、読み込んだときと異なります。元のPDFをもう一度「PDFを追加」で選ぶと、このファイルに再接続できます。',
    },
    MISSING: {
        text: '読み込めません',
        title: 'ファイルを読み込めません（移動・変更・削除された可能性があります）。元のPDFをもう一度「PDFを追加」で選ぶと、このファイルに再接続できます。',
    },
};

export const DrawingSetWorkspace: React.FC = () => {
    // One store per visit; the PDF.js gate and the preview owner are the page's.
    const [store] = useState(() => new DrawingSetStore({ gate: PAGE_PDF_GATE, owner: PAGE_PREVIEW_OWNER }));
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const sessionState = snapshot.state;
    const [items, setItems] = useState<IntakeItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<Confirmation>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [showFullSha, setShowFullSha] = useState(false);
    const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
    const [editor, setEditor] = useState<Editor>(null);
    const [draft, setDraft] = useState<DraftFields>({});
    const [drawingField, setDrawingField] = useState<FieldName | null>(null);
    const [transferModel, setTransferModel] = useState<TransferModel | null>(null);
    const [profileName, setProfileName] = useState('');
    const [editorMessage, setEditorMessage] = useState<string | null>(null);
    /** Where the viewer last drew the selected page, for the profile editor. */
    const geometryRef = useRef<{ sheetId: string; geometry: ViewerGeometry } | null>(null);
    const owner = store.owner;
    const operation = snapshot.operation;
    const locked = operation !== null;

    // The screen's own queue of picked files. The session is the store's.
    const queueRef = useRef<{ itemId: number; file: File }[]>([]);
    /** Moves whenever the queue is abandoned (stop, reset, leaving), so a pump of the old one stops. */
    const queueEpochRef = useRef(0);
    const pumpingRef = useRef(false);
    const itemCounterRef = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // Leaving the workspace ends everything it started.
    useEffect(() => {
        const queue = queueRef;
        const epoch = queueEpochRef;
        const pumping = pumpingRef;
        store.enter();
        return () => {
            epoch.current += 1;
            queue.current = [];
            pumping.current = false;
            store.leave();
        };
    }, [store]);

    const updateItem = (id: number, patch: Partial<IntakeItem>): void => {
        setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const show = (itemId: number, result: StoreIntakeResult): void => {
        switch (result.kind) {
            case 'accepted':
                setSelectedSheetId((current) => current ?? result.sheets[0]?.id ?? null);
                updateItem(itemId, { state: 'accepted', detail: `${result.sheets.length} ページを追加しました。`, progress: '' });
                return;
            case 'reconnected':
                updateItem(itemId, {
                    state: 'reconnected',
                    detail: `同じ内容（SHA-256一致）のファイル「${result.existing.displayName}」に再接続しました。新しいファイルとしては追加していません。`,
                    progress: '',
                });
                return;
            case 'duplicate':
                updateItem(itemId, {
                    state: 'duplicate',
                    detail: `同じ内容のファイル「${result.existing.displayName}」がすでにあるため、追加しませんでした。`,
                    progress: '',
                });
                return;
            case 'refused':
                updateItem(itemId, { state: 'refused', detail: result.refusal.message, progress: '' });
                return;
            case 'cancelled':
                updateItem(itemId, { state: 'cancelled', detail: '中止しました。', progress: '' });
                return;
        }
    };

    /** Take queued files in, one at a time, until the queue is empty or abandoned. */
    const pump = async (): Promise<void> => {
        if (pumpingRef.current) return;
        pumpingRef.current = true;
        const epoch = queueEpochRef.current;
        setBusy(true);
        try {
            for (;;) {
                if (epoch !== queueEpochRef.current) return;
                const next = queueRef.current.shift();
                if (!next) break;
                updateItem(next.itemId, { state: 'processing', progress: '準備中' });
                let lastProgress = 0;
                const result = await store.intake(next.file, {
                    onProgress: (progress) => {
                        if (epoch !== queueEpochRef.current) return;
                        const now = performance.now();
                        const done = (progress.phase === 'reading' && progress.bytesDone === progress.bytesTotal)
                            || (progress.phase === 'inventory' && progress.pagesDone === progress.pagesTotal);
                        if (!done && progress.phase !== 'opening' && now - lastProgress < 100) return;
                        lastProgress = now;
                        updateItem(next.itemId, { progress: progressLabel(progress) });
                    },
                });
                // A run that is no longer this queue's shows nothing.
                if (epoch !== queueEpochRef.current) return;
                show(next.itemId, result);
            }
        } finally {
            if (epoch === queueEpochRef.current) {
                pumpingRef.current = false;
                setBusy(false);
            }
        }
    };

    const addFiles = (list: FileList | null): void => {
        if (!list || list.length === 0 || !sessionState.ok) return;
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
        queueEpochRef.current += 1;
        store.stopIntake();
        queueRef.current = [];
        pumpingRef.current = false;
        setBusy(false);
        setItems((list) => list.map((item) => (
            item.state === 'queued' || item.state === 'processing'
                ? { ...item, state: 'cancelled', detail: '中止しました。', progress: '' }
                : item
        )));
    };

    const closeEditor = (): void => {
        setEditor(null);
        setDraft({});
        setDrawingField(null);
        setTransferModel(null);
        setProfileName('');
        setEditorMessage(null);
    };

    const resetSession = (): void => {
        stopProcessing();
        store.reset();
        setItems([]);
        setSelectedSheetId(null);
        setConfirm(null);
        setShowFullSha(false);
        setChecked(new Set());
        closeEditor();
        setNotice('新しい図面一式を始めました。前の図面一式の内容は破棄されました。');
    };

    const removeSource = (sourceId: string): void => {
        setConfirm(null);
        const result = store.removeSource(sourceId);
        if (!result.ok) {
            setNotice(result.message);
            return;
        }
        const drawingSet = store.currentSet();
        setSelectedSheetId((current) => {
            if (!current) return current;
            const sheet = drawingSet.sheets.find((candidate) => candidate.id === current);
            return sheet && isLive(sheet) ? current : drawingSet.sheets.find(isLive)?.id ?? null;
        });
        setNotice(result.removed ? `「${result.removed.displayName}」をこの図面一式から外しました。` : null);
    };

    const drawingSet = sessionState.ok ? sessionState.session.drawingSet : null;
    const sheets = useMemo(() => (drawingSet ? liveSheets(drawingSet) : []), [drawingSet]);
    const sources = useMemo(() => (drawingSet ? liveSources(drawingSet) : []), [drawingSet]);
    const sourcesById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
    const sourceNames = useMemo(() => new Map(sources.map((source) => [source.id, source.displayName])), [sources]);
    const sheetsById = useMemo(() => new Map(sheets.map((sheet) => [sheet.id, sheet])), [sheets]);

    const selectedSheet: Sheet | null = (selectedSheetId && sheetsById.get(selectedSheetId)) || null;
    const selectedSource: Source | null = selectedSheet ? sourcesById.get(selectedSheet.sourceId) ?? null : null;
    const selectedFile = selectedSource ? store.heldFile(selectedSource.id) : null;
    const gateCounts = store.gate.counts();

    const pending = items.filter((item) => item.state === 'queued' || item.state === 'processing').length;
    const current = items.find((item) => item.state === 'processing');
    const confirmSource = confirm?.kind === 'remove' ? sourcesById.get(confirm.sourceId) ?? null : null;

    const selectSheet = (sheetId: string): void => {
        if (sheetId !== selectedSheetId) {
            setShowFullSha(false);
            // A profile is drawn on one page; choosing another ends the drawing.
            if (editor) {
                closeEditor();
                setNotice('別のページを選んだため、範囲の指定をやめました。');
            }
        }
        setSelectedSheetId(sheetId);
    };

    const toggleCheck = (sheetId: string): void => {
        setChecked((current) => {
            const next = new Set(current);
            if (next.has(sheetId)) next.delete(sheetId);
            else next.add(sheetId);
            return next;
        });
    };

    /** Start drawing a profile, or redrawing one, on the page shown now. */
    const startEditor = (profile: TitleBlockProfile | null): void => {
        const shown = geometryRef.current;
        if (!selectedSheet || !shown || shown.sheetId !== selectedSheet.id) return;
        setEditorMessage(null);
        setDrawingField(FIELD_NAMES[0]);
        if (profile) {
            // The profile's rectangles as they fall on this page, to adjust.
            const plan = planCrop(profile, uprightSize(shown.geometry));
            setDraft(Object.fromEntries(FIELD_NAMES.map((name) => [name, plan.fields[name].rect])) as DraftFields);
            setTransferModel(profile.transferModel);
            setEditor({ mode: 'revise', sheetId: selectedSheet.id, profile });
        } else {
            setDraft({});
            setTransferModel(null);
            setProfileName('');
            setEditor({ mode: 'create', sheetId: selectedSheet.id });
        }
    };

    const finishEditor = (): void => {
        const shown = geometryRef.current;
        if (!editor || !shown || shown.sheetId !== editor.sheetId || !transferModel || !FIELD_NAMES.every((name) => draft[name])) return;
        const size = uprightSize(shown.geometry);
        const referencePage = { uprightWidthPt: size.width, uprightHeightPt: size.height };
        const fields = draft as Record<FieldName, Rect>;
        const outcome = editor.mode === 'create'
            ? store.createProfile({ name: profileName.trim(), transferModel, referencePage, fields })
            : store.reviseProfile(editor.profile.id, { transferModel, referencePage, fields });
        if (!outcome.ok) {
            setEditorMessage(outcome.refusal.message);
            return;
        }
        closeEditor();
        setNotice(editor.mode === 'create'
            ? `プロファイル「${profileName.trim()}」を作成しました。ページにチェックを付けて割り当ててください。`
            : `プロファイル「${editor.profile.name}」の範囲を変更しました。このプロファイルのページは読み取り直しが必要です。`);
    };

    const openPicker = (): void => inputRef.current?.click();

    // What a Sheet List row adds: asked for the rows in view only.
    const profileNames = useMemo(
        () => new Map((drawingSet?.titleBlockProfiles ?? []).filter(isLive).map((p) => [p.id, p.name])),
        [drawingSet],
    );
    const describe = (sheet: Sheet): SheetRowFacts => {
        const profile = sheet.profileAssignment ? profileNames.get(sheet.profileAssignment.profileId) ?? null : null;
        const currency = store.currencyOf(sheet)?.confirmation ?? null;
        if (!currency) return { profile, badge: null, confirmedNumber: null };
        const label = confirmationText(currency);
        const shown = profile !== null || sheet.observation !== null || sheet.confirmation !== null;
        return {
            profile,
            badge: shown ? { ...label, state: currency.state } : null,
            confirmedNumber: sheet.confirmation ? sheet.confirmation.values.drawingNumber : null,
            confirmedNumberTitle: confirmedNumberTitle(currency),
        };
    };

    // The selected Sheet's profile rectangles over the page, or the ones being drawn.
    const assignedProfile = selectedSheet?.profileAssignment && drawingSet ? findProfile(drawingSet, selectedSheet.profileAssignment.profileId) : null;
    const overlay = (geometry: ViewerGeometry): React.ReactNode => {
        if (selectedSheet) geometryRef.current = { sheetId: selectedSheet.id, geometry };
        if (editor && selectedSheet && editor.sheetId === selectedSheet.id) {
            return (
                <FieldRectsOverlay
                    geometry={geometry}
                    rects={draft}
                    drawing={drawingField}
                    mode="draft"
                    onDraw={(field, rect) => {
                        setDraft((current) => ({ ...current, [field]: rect }));
                        // On to the next field still to draw.
                        const next = FIELD_NAMES.find((name) => name !== field && !draft[name]) ?? null;
                        setDrawingField(next);
                    }}
                />
            );
        }
        if (assignedProfile && isLive(assignedProfile)) {
            const plan = planCrop(assignedProfile, uprightSize(geometry));
            const rects = Object.fromEntries(FIELD_NAMES.map((name) => [name, plan.fields[name].rect])) as DraftFields;
            return <FieldRectsOverlay geometry={geometry} rects={rects} mode="profile" />;
        }
        return null;
    };

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
            data-ds-gate-intakes-started={gateCounts.intakesStarted}
            data-ds-gate-intakes-refused={gateCounts.intakesRefused}
            data-ds-gate-extractions-started={gateCounts.extractionsStarted}
            data-ds-gate-release-unconfirmed={String(store.gate.releaseUnconfirmed)}
            data-ds-operation={operation ? operation.phase : ''}
            data-ds-documents-unavailable={String(snapshot.documentsUnavailable)}
            data-ds-ocr-unavailable={String(snapshot.ocr.unavailable)}
            data-ds-ocr-live={snapshot.ocr.live}
            data-ds-ocr-slowest-start-ms={snapshot.ocr.slowestStartMs}
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
                            : operation ? '表題欄を読み取っています' : '待機中'}
                    </span>
                </div>
                <div className="ds-header-actions">
                    <button type="button" className="ds-button is-primary" onClick={openPicker} disabled={locked} title={locked ? '表題欄の読み取り中はファイルを追加できません。' : undefined} data-ds-add>
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

            {snapshot.documentsUnavailable && (
                <div className="ds-confirm" role="alert" data-ds-release-unconfirmed-banner>
                    <span>{GATE_MESSAGES.RELEASE_UNCONFIRMED}</span>
                </div>
            )}

            {snapshot.ocr.unavailable && (
                <div className="ds-confirm" role="alert" data-ds-ocr-unconfirmed-banner>
                    <span>{OCR_RELEASE_UNCONFIRMED_MESSAGE}</span>
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
                                {sources.map((source) => {
                                    const binding = snapshot.bindings.get(source.id) ?? 'UNBOUND';
                                    const label = BINDING_LABEL[binding];
                                    return (
                                    <li
                                        key={source.id}
                                        className={`ds-source-row${selectedSource?.id === source.id ? ' is-selected' : ''}`}
                                        data-ds-source-row
                                        data-ds-source-id={source.id}
                                        data-ds-binding={binding}
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
                                            <span className="ds-source-meta">
                                                <span className="ds-muted">{source.fingerprint.pageCount} ページ</span>
                                                <span className={`ds-binding is-${binding.toLowerCase()}`} title={label.title} data-ds-binding-label>{label.text}</span>
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            className="ds-icon-button"
                                            disabled={locked}
                                            title="この図面一式から外す"
                                            aria-label={`「${source.displayName}」をこの図面一式から外す`}
                                            onClick={() => setConfirm({ kind: 'remove', sourceId: source.id })}
                                            data-ds-remove-source
                                        >
                                            <X size={14} />
                                        </button>
                                    </li>
                                    );
                                })}
                            </ul>
                        </section>
                        <div className="ds-pane-title">ページ一覧（{sheets.length}）</div>
                        <VirtualSheetList
                            sheets={sheets}
                            sourceNames={sourceNames}
                            selectedSheetId={selectedSheet?.id ?? null}
                            onSelect={selectSheet}
                            checked={checked}
                            onToggle={toggleCheck}
                            describe={describe}
                        />
                    </aside>

                    <section className="ds-center" aria-label="プレビュー（読み取り専用）">
                        {selectedSheet && selectedSource && selectedFile ? (
                            <ReadOnlySheetViewer
                                key={selectedSource.id}
                                owner={owner}
                                open={store.openPreview}
                                source={selectedSource}
                                file={selectedFile}
                                sheet={selectedSheet}
                                pageTotal={selectedSource.fingerprint.pageCount}
                                overlay={overlay}
                                reopenKey={snapshot.previewEpoch}
                                suspended={locked ? '表題欄の読み取り中はプレビューを表示しません。読み取りが終わると表示できます。' : null}
                            />
                        ) : (
                            <div className="ds-viewer-placeholder">{busy ? '読み込みが終わると、ここにページを表示します。' : '一覧からページを選ぶと、ここに表示します。'}</div>
                        )}
                        {editor && selectedSheet && selectedSource && editor.sheetId === selectedSheet.id ? (
                            <ProfileEditorPanel
                                mode={editor.mode}
                                profileName={editor.mode === 'revise' ? editor.profile.name : ''}
                                reference={`${selectedSource.displayName} p.${selectedSheet.pageNumber}`}
                                draft={draft}
                                drawing={drawingField}
                                transferModel={transferModel}
                                name={profileName}
                                message={editorMessage}
                                onPick={setDrawingField}
                                onTransferModel={setTransferModel}
                                onName={setProfileName}
                                onDone={finishEditor}
                                onCancel={closeEditor}
                            />
                        ) : selectedSheet && (
                            <ConfirmationPanel
                                key={`${selectedSheet.id}:${selectedSheet.observation?.runId ?? ''}:${selectedSheet.confirmation?.confirmedAt ?? ''}`}
                                store={store}
                                sheet={selectedSheet}
                                generation={snapshot.evidenceGeneration}
                                locked={locked}
                                documentsUnavailable={snapshot.documentsUnavailable}
                                onNotice={setNotice}
                            />
                        )}
                    </section>

                    <aside className="ds-right" aria-label="ページとファイルの情報" data-ds-info>
                        {selectedSheet && selectedSource ? (
                            <SheetInfo sheet={selectedSheet} source={selectedSource} showFullSha={showFullSha} onToggleSha={() => setShowFullSha((value) => !value)} />
                        ) : (
                            <p className="ds-muted">ページを選ぶと、用紙サイズや回転などの情報を表示します。</p>
                        )}
                        {drawingSet && (
                            <TitleBlockPanel
                                store={store}
                                drawingSet={drawingSet}
                                checked={checked}
                                operation={operation}
                                lastExtraction={snapshot.lastExtraction}
                                selectedSheet={selectedSheet}
                                canDraw={Boolean(selectedSheet && selectedFile && !locked && !snapshot.documentsUnavailable)}
                                editing={editor !== null}
                                onCheck={(ids) => setChecked(new Set(ids ?? []))}
                                onCreate={() => startEditor(null)}
                                onRevise={(profile) => startEditor(profile)}
                                onNotice={setNotice}
                            />
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
            {facts && <p className="ds-muted ds-small">テキストの有無はPDF内の情報だけで判定しています（この判定に文字認識（OCR）は使っていません）。</p>}

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
