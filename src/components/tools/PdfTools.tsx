import { useCallback, useEffect, useRef, useState } from 'react';
import './PdfTools.css';
import { Settings, Sliders, Layers, FileText, UploadCloud, Play, X, Check, AlertCircle, Blend, BoxSelect, Ruler, Stamp, ShieldAlert } from 'lucide-react';
import { normalizePageSize, PAPER_SIZE_KEYS } from '../../utils/page-size-normalizer';
import type { NormalizeSummary, NormalizeTarget } from '../../utils/page-size-normalizer';
import { updateTitleBlocks } from '../../utils/title-block-updater';
import type { PageOrientation, TitleBlockSummary, UpdateRule } from '../../utils/title-block-updater';
import { TitleBlockUpdater } from './TitleBlockUpdater';
import { saveAs } from 'file-saver';
import { VersionFooter } from '../VersionFooter';
import { TOOL_VERSIONS } from '../../config/versions';
import {
    BATCH_RESULT,
    DEFAULT_MEMORY_BUDGET,
    FILE_RESULT,
    LOSS_LABEL_JA,
    MEMORY_PRESETS,
    PLAN_STATUS,
    ProcessorError,
    RunOwnership,
    canStartNextFile,
    checkActualOutput,
    defaultCeilings,
    planOperation,
    planWholeJob,
    publishBatch,
    readSourceFacts,
    runBoth,
    runFlatten,
    runLayer,
    runMargin,
    runOptimizeLossless,
    snapshotKey,
    withConfirmation,
} from '../../utils/processor';
import type {
    FileResult, Plan, PlanStatus, ProcessorOperation, RunSnapshot, StructureLoss,
} from '../../utils/processor';

type ToolType = ProcessorOperation;

/**
 * What a row can be. The old set was idle/processing/done/error, which is why a
 * refusal and a crash looked the same and both looked like the tool had simply
 * not worked. H10/H22: a person has to be able to tell "this document cannot be
 * processed safely" from "something went wrong" from "you superseded this run".
 */
/**
 * `processed` is deliberately not `succeeded`.
 *
 * A runner returning bytes is not a file the person has. The artifact still has
 * to pass the output ceiling, the batch still has to fit its own budget, the
 * archive still has to be built, and the run still has to be the one that
 * matters. Turning the row green when the runner returned put a tick next to
 * work that could still end with nothing written, so the green is held until
 * publication is actually approved.
 */
type RowStatus = 'idle' | 'planning' | 'processing' | 'processed' | 'succeeded' | 'refused' | 'failed' | 'cancelled';

interface ProcessFile {
    id: string;
    file: File;
    status: RowStatus;
    progress: number;
    /** The plan's code, so the UI and the manifest say the same word. */
    code?: PlanStatus | 'SUCCEEDED';
    reason?: string;
    summary?: NormalizeSummary;
    titleBlockSummary?: TitleBlockSummary;
}

const TOOL_LABEL: Record<ToolType, string> = {
    layer: '半透明レイヤ追加',
    monochrome: 'モノクロ化',
    both: '両方実行',
    margin: '余白生成',
    optimize: '最適化',
    'normalize-size': '図面サイズ統一',
    'title-block-update': '図枠一括更新',
};

const STATUS_LABEL: Record<RowStatus, string> = {
    idle: '待機',
    planning: '確認中',
    processing: '処理中',
    processed: '書き出し待ち',
    succeeded: '完了',
    refused: '処理できません',
    failed: '失敗',
    cancelled: '中止',
};

const SUFFIX: Record<ToolType, string> = {
    layer: '_overlay',
    monochrome: '_mono',
    both: '_overlay&mono',
    margin: '_margin',
    optimize: '_optimized',
    'normalize-size': '',
    'title-block-update': '',
};

const MEMORY_LABEL = (bytes: number) => (bytes >= 1024 * 1024 * 1024
    ? `${bytes / (1024 * 1024 * 1024)} GiB`
    : `${bytes / (1024 * 1024)} MiB`);

export function PdfTools() {
    const [activeTool, setActiveTool] = useState<ToolType>('layer');
    const [files, setFiles] = useState<ProcessFile[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);

    // Tool Settings
    const [layerOpacity, setLayerOpacity] = useState(0.5);
    const [layerColor, setLayerColor] = useState('#ffffff');
    const [monoContrast, setMonoContrast] = useState(1.0);
    const [monoDpi, setMonoDpi] = useState(300);
    const [memoryBudget, setMemoryBudget] = useState<number>(DEFAULT_MEMORY_BUDGET);
    const [marginScale, setMarginScale] = useState(0.8);
    const [marginPosition, setMarginPosition] = useState<'center' | 'tl' | 'tr' | 'bl' | 'br'>('center');
    const [normalizeTarget, setNormalizeTarget] = useState<NormalizeTarget>('A1');
    const [titleRules, setTitleRules] = useState<UpdateRule[]>([
        { rect: { x: 0, y: 0, width: 0, height: 0 }, text: '' },
    ]);
    const [template, setTemplate] = useState<{ fileId: string; orientation: PageOrientation } | null>(null);

    /** Set when a flattening plan is waiting for an answer. */
    const [pendingLosses, setPendingLosses] = useState<{ losses: StructureLoss[]; key: string } | null>(null);
    /** The snapshot the person agreed to. Any change to it invalidates this. */
    const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
    /** What the batch as a whole did, when there was more than one file. */
    const [batchNote, setBatchNote] = useState<string | null>(null);

    const ownership = useRef(new RunOwnership());

    /**
     * Anything that changes what a run *is* supersedes the run in flight and
     * retires the confirmation with it. H10: the measured failure was a batch
     * that kept going after the user had moved on, and a DPI changed mid-run
     * that produced a file at the old setting whose row said done.
     */
    const supersede = useCallback(() => {
        ownership.current.supersede();
        setConfirmedKey(null);
        setPendingLosses(null);
    }, []);

    useEffect(() => supersede, [supersede]);

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const droppedFiles = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        const newFiles = droppedFiles.map(f => ({
            id: Math.random().toString(36).slice(2, 11),
            file: f,
            status: 'idle' as const,
            progress: 0,
        }));
        supersede();
        setFiles(prev => [...prev, ...newFiles]);
    };

    const removeFile = (id: string) => {
        supersede();
        setFiles(prev => prev.filter(f => f.id !== id));
    };

    const representativeId = files[0]?.id ?? null;
    const templateReady = template !== null && representativeId !== null && template.fileId === representativeId;
    const titleBlockNotReady = activeTool === 'title-block-update' && !templateReady;

    const handleTemplateOrientation = useCallback((orientation: PageOrientation | null) => {
        setTemplate(orientation && representativeId ? { fileId: representativeId, orientation } : null);
    }, [representativeId]);

    const snapshotOf = useCallback((): RunSnapshot => ({
        operation: activeTool,
        fileIds: files.map(f => f.id),
        dpi: activeTool === 'monochrome' || activeTool === 'both' ? monoDpi : null,
        contrast: activeTool === 'monochrome' || activeTool === 'both' ? monoContrast : null,
        memoryBudgetBytes: memoryBudget,
    }), [activeTool, files, monoDpi, monoContrast, memoryBudget]);

    const setRow = (id: string, patch: Partial<ProcessFile>) => {
        setFiles(prev => prev.map(f => (f.id === id ? { ...f, ...patch } : f)));
    };

    /**
     * `justConfirmedKey` is passed by the confirmation button rather than read
     * from state. `setConfirmedKey` does not take effect until the next render,
     * so a re-entry that consulted the state variable would plan the same
     * flattening, find it unconfirmed again, and ask again — forever. The key
     * travels with the call that was authorised by it.
     */
    const startProcessing = async (justConfirmedKey?: string) => {
        if (files.length === 0 || isProcessing || titleBlockNotReady) return;

        const snapshot = snapshotOf();
        const key = snapshotKey(snapshot);
        const confirmedForThisRun = (justConfirmedKey ?? confirmedKey) === key;
        const token = ownership.current.begin(snapshot);
        setIsProcessing(true);
        setBatchNote(null);
        setFiles(prev => prev.map(f => ({ ...f, status: 'planning', progress: 5, code: undefined, reason: undefined, summary: undefined, titleBlockSummary: undefined })));

        const ceilings = defaultCeilings(memoryBudget);
        const results: FileResult[] = [];

        try {
            // ---- plan everything before anything is touched --------------------
            const planned: { row: ProcessFile; bytes: Uint8Array; plan: Plan }[] = [];
            for (const row of files) {
                token.assertCurrent();
                const bytes = new Uint8Array(await row.file.arrayBuffer());
                const facts = await readSourceFacts(bytes);
                const plan = withConfirmation(
                    planOperation(facts, activeTool, {
                        dpi: monoDpi, contrast: monoContrast, memoryBudgetBytes: memoryBudget,
                    }),
                    confirmedForThisRun,
                );
                planned.push({ row, bytes, plan });
            }

            // A flattening plan that nobody has agreed to stops the run here,
            // before a single page has been rendered.
            const needsConfirmation = planned.find(
                p => p.plan.status === PLAN_STATUS.STRUCTURE_LOSS_REQUIRES_CONFIRMATION,
            );
            if (needsConfirmation) {
                setPendingLosses({ losses: needsConfirmation.plan.losses, key });
                setFiles(prev => prev.map(f => ({ ...f, status: 'idle', progress: 0 })));
                setIsProcessing(false);
                return;
            }

            // ---- can the whole job afford itself? --------------------------------
            //
            // Every plan exists before the first raster, so a batch that cannot
            // finish is refused before it starts rather than discovered with the
            // memory already claimed.
            const runnable = planned.filter(p => p.plan.status === PLAN_STATUS.READY);
            if (runnable.length > 1) {
                const job = planWholeJob(
                    runnable.map(p => p.plan.filePeakBytes),
                    runnable.map(p => p.plan.fileBytesEstimate),
                    runnable.map(p => p.row.file.name),
                    2048,
                    ceilings,
                );
                if (!job.ok) {
                    setFiles(prev => prev.map(f => ({
                        ...f, status: 'refused', progress: 100,
                        code: PLAN_STATUS.OVER_MEMORY_BUDGET, reason: job.reason,
                    })));
                    setBatchNote(job.reason);
                    setIsProcessing(false);
                    return;
                }
            }

            // ---- run ------------------------------------------------------------
            for (const { row, bytes, plan } of planned) {
                token.assertCurrent();

                if (plan.status !== PLAN_STATUS.READY) {
                    setRow(row.id, { status: 'refused', progress: 100, code: plan.code, reason: plan.reason });
                    results.push({
                        name: row.file.name,
                        status: FILE_RESULT.FAILED,
                        code: plan.code,
                        reason: plan.reason,
                        bytes: null,
                        outputName: null,
                    });
                    continue;
                }

                // What is already held, plus what this file will peak at. The
                // ceiling is a job ceiling, so it is re-checked here rather than
                // only at the archive.
                const boundary = canStartNextFile(results, plan.filePeakBytes, ceilings);
                if (!boundary.ok) {
                    setRow(row.id, {
                        status: 'refused', progress: 100,
                        code: PLAN_STATUS.OVER_MEMORY_BUDGET, reason: boundary.reason,
                    });
                    results.push({
                        name: row.file.name,
                        status: FILE_RESULT.FAILED,
                        code: PLAN_STATUS.OVER_MEMORY_BUDGET,
                        reason: boundary.reason,
                        bytes: null,
                        outputName: null,
                    });
                    continue;
                }

                setRow(row.id, { status: 'processing', progress: 30 });
                try {
                    let out: Uint8Array;
                    let suffix = SUFFIX[activeTool];
                    let summary: NormalizeSummary | undefined;
                    let titleBlockSummary: TitleBlockSummary | undefined;

                    if (activeTool === 'title-block-update') {
                        if (!templateReady || !template) {
                            throw new ProcessorError(
                                '代表ページの読み込みが完了していません。プレビューにページが表示されてから実行してください。',
                                PLAN_STATUS.UNSUPPORTED_DOCUMENT,
                            );
                        }
                        const updated = await updateTitleBlocks(row.file, {
                            rules: titleRules, templateOrientation: template.orientation,
                        });
                        out = updated.data;
                        titleBlockSummary = updated.summary;
                        suffix = titleBlockSummary.filenameSuffix;
                    } else if (activeTool === 'normalize-size') {
                        const normalized = await normalizePageSize(row.file, { target: normalizeTarget });
                        out = normalized.data;
                        summary = normalized.summary;
                        suffix = summary.filenameSuffix;
                    } else if (activeTool === 'layer') {
                        out = await runLayer(bytes, { color: layerColor, opacity: layerOpacity }, token);
                    } else if (activeTool === 'monochrome') {
                        out = await runFlatten(bytes, 'monochrome', { dpi: monoDpi, contrast: monoContrast }, token);
                    } else if (activeTool === 'both') {
                        out = await runBoth(
                            bytes,
                            { dpi: monoDpi, contrast: monoContrast },
                            { color: layerColor, opacity: layerOpacity },
                            token,
                        );
                    } else if (activeTool === 'margin') {
                        out = await runMargin(bytes, { scale: marginScale, position: marginPosition }, token);
                    } else {
                        const optimized = await runOptimizeLossless(bytes, token);
                        out = optimized.bytes;
                        if (!optimized.changed) suffix = '';
                    }

                    token.assertCurrent();

                    // The ceiling applied to bytes that exist. Planning
                    // estimated; this is the only check that knows — including
                    // when 最適化 hands back the source unchanged.
                    const actual = checkActualOutput(out.length, ceilings);
                    if (!actual.ok) {
                        setRow(row.id, {
                            status: 'refused', progress: 100,
                            code: PLAN_STATUS.OVER_OUTPUT_BUDGET, reason: actual.reason,
                        });
                        results.push({
                            name: row.file.name,
                            status: FILE_RESULT.FAILED,
                            code: PLAN_STATUS.OVER_OUTPUT_BUDGET,
                            reason: actual.reason,
                            bytes: null,
                            outputName: null,
                        });
                        continue;
                    }

                    const base = row.file.name.replace(/\.pdf$/i, '');
                    const outputName = `${base}${suffix}.pdf`;
                    results.push({
                        name: row.file.name,
                        status: FILE_RESULT.SUCCEEDED,
                        code: 'SUCCEEDED',
                        reason: activeTool === 'optimize' && suffix === ''
                            ? '再保存しても小さくならなかったため、元のファイルをそのまま返しました。'
                            : '完了しました。',
                        bytes: out,
                        outputName,
                    });
                    // Held at `processed`: the artifact exists, but nobody has
                    // it yet. The green tick waits for publication.
                    setRow(row.id, {
                        status: 'processed',
                        progress: 90,
                        code: 'SUCCEEDED',
                        reason: results[results.length - 1].reason,
                        summary,
                        titleBlockSummary,
                    });
                } catch (error) {
                    const isProcessorError = error instanceof ProcessorError;
                    const code = isProcessorError ? error.code : PLAN_STATUS.UNSUPPORTED_DOCUMENT;
                    const message = error instanceof Error ? error.message : String(error);
                    if (code === PLAN_STATUS.CANCELLED) throw error;
                    setRow(row.id, { status: isProcessorError ? 'refused' : 'failed', progress: 100, code, reason: message });
                    results.push({
                        name: row.file.name,
                        status: FILE_RESULT.FAILED,
                        code,
                        reason: message,
                        bytes: null,
                        outputName: null,
                    });
                }
            }

            // ---- publish, and only if this run is still the one that matters ----
            //
            // Nothing above this point turned a row green. A batch can still be
            // refused its memory or its output here, and a superseded run still
            // publishes nothing — in either case the rows stay at 書き出し待ち
            // rather than claiming a file the person never received.
            token.assertCurrent();
            const successes = results.filter(r => r.status === FILE_RESULT.SUCCEEDED && r.bytes);
            const markPublished = () => setFiles(prev => prev.map(f => (
                f.status === 'processed' ? { ...f, status: 'succeeded', progress: 100 } : f
            )));

            if (files.length === 1) {
                const only = successes[0];
                if (only?.bytes) {
                    const blob = new Blob([only.bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
                    if (!token.isCurrent()) return;
                    saveAs(blob, only.outputName ?? only.name);
                    markPublished();
                }
            } else if (successes.length > 0) {
                try {
                    const batch = await publishBatch(
                        TOOL_LABEL[activeTool], results, ceilings, () => token.isCurrent(),
                    );
                    if (batch.archive && batch.archiveName && token.isCurrent()) {
                        saveAs(batch.archive, batch.archiveName);
                        markPublished();
                        setBatchNote(
                            batch.status === BATCH_RESULT.PARTIAL
                                ? `${successes.length} / ${results.length} 件を書き出しました。失敗したファイルは manifest.json に記載しています。`
                                : `${successes.length} 件すべてを書き出しました。`,
                        );
                    } else {
                        setBatchNote('設定またはファイルが変更されたため、ZIPは保存しませんでした。');
                    }
                } catch (error) {
                    // The batch was refused its own budget. The files were
                    // produced; none of them was delivered, and the rows say so.
                    const code = error instanceof ProcessorError ? error.code : PLAN_STATUS.OVER_OUTPUT_BUDGET;
                    const message = error instanceof Error ? error.message : String(error);
                    setFiles(prev => prev.map(f => (
                        f.status === 'processed'
                            ? { ...f, status: 'refused', progress: 100, code, reason: message }
                            : f
                    )));
                    setBatchNote(`ZIPを作成できなかったため、書き出していません: ${message}`);
                }
            } else {
                setBatchNote('書き出せたファイルはありません。各行の理由を確認してください。');
            }
        } catch (error) {
            const cancelled = error instanceof ProcessorError && error.code === PLAN_STATUS.CANCELLED;
            setFiles(prev => prev.map(f => (
                f.status === 'planning' || f.status === 'processing'
                    ? { ...f, status: cancelled ? 'cancelled' : 'failed', progress: 100, reason: error instanceof Error ? error.message : String(error) }
                    : f
            )));
            setBatchNote(cancelled
                ? '設定またはファイルが変更されたため、処理を中止しました。書き出しは行っていません。'
                : `処理を中止しました: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setIsProcessing(false);
        }
    };

    const acceptLosses = () => {
        if (!pendingLosses) return;
        const key = pendingLosses.key;
        setConfirmedKey(key);
        setPendingLosses(null);
        // The key goes with the call, not through state: the run that starts
        // here is the one the person just authorised, and it must still match
        // the snapshot they were shown.
        void startProcessing(key);
    };

    const toolButton = (tool: ToolType, Icon: typeof Layers) => (
        <button
            className={`tool-btn ${activeTool === tool ? 'active' : ''}`}
            onClick={() => { supersede(); setActiveTool(tool); }}
            disabled={isProcessing}
        >
            <Icon size={20} />
            <span>{TOOL_LABEL[tool]}</span>
        </button>
    );

    return (
        <div className="pdf-tools-container">
            <div className="tools-sidebar" data-usage-target="processor-tools">
                {toolButton('layer', Layers)}
                {toolButton('monochrome', Sliders)}
                {toolButton('both', Blend)}
                {toolButton('margin', BoxSelect)}
                {toolButton('normalize-size', Ruler)}
                {toolButton('title-block-update', Stamp)}
                {toolButton('optimize', FileText)}
            </div>

            <div className="tools-main">
                <div
                    className="drop-zone"
                    data-usage-target="processor-upload"
                    onDragOver={e => e.preventDefault()}
                    onDrop={handleDrop}
                    onClick={() => document.getElementById('file-input')?.click()}
                >
                    <UploadCloud size={48} className="drop-icon" />
                    <h3>PDFファイルをドロップ</h3>
                    <p>またはクリックして選択</p>
                    <input
                        id="file-input"
                        type="file"
                        multiple
                        accept=".pdf"
                        className="file-input-hidden"
                        onChange={e => {
                            if (e.target.files) {
                                const newFiles = Array.from(e.target.files).map(f => ({
                                    id: Math.random().toString(36).slice(2, 11),
                                    file: f,
                                    status: 'idle' as const,
                                    progress: 0,
                                }));
                                supersede();
                                setFiles(prev => [...prev, ...newFiles]);
                            }
                        }}
                    />
                </div>

                {activeTool === 'title-block-update' && (
                    <TitleBlockUpdater
                        key={files[0]?.id ?? 'no-file'}
                        file={files[0]?.file ?? null}
                        rules={titleRules}
                        onRulesChange={setTitleRules}
                        onTemplateOrientationChange={handleTemplateOrientation}
                        disabled={isProcessing}
                    />
                )}

                {pendingLosses && (
                    <div className="confirm-panel" data-usage-target="processor-confirm" style={{
                        border: '1px solid #ffcc80', borderRadius: 8, padding: '14px 16px',
                        margin: '12px 0', background: 'rgba(255, 204, 128, 0.08)',
                    }}>
                        <h4 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' }}>
                            <ShieldAlert size={18} color="#ffcc80" />
                            この操作はページを画像に置き換えます
                        </h4>
                        <p style={{ margin: '0 0 8px' }}>
                            {TOOL_LABEL[activeTool]}（{monoDpi} dpi・コントラスト {monoContrast}・
                            処理メモリ上限 {MEMORY_LABEL(memoryBudget)}）を
                            {files.length} 件のファイルに実行します。次の内容が失われる可能性があります。
                        </p>
                        <ul style={{ margin: '0 0 10px 18px' }}>
                            {pendingLosses.losses.map(l => <li key={l}>{LOSS_LABEL_JA[l]}</li>)}
                        </ul>
                        <p style={{ margin: '0 0 10px', color: '#ffcc80' }}>
                            この確認は、いま表示されているファイル・ツール・設定の組み合わせにのみ有効です。
                            いずれかを変更すると、もう一度確認します。
                        </p>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button className="process-btn" style={{ width: 'auto' }} onClick={acceptLosses}>
                                内容を理解して実行
                            </button>
                            <button className="remove-btn" style={{ width: 'auto', padding: '0 14px' }} onClick={() => setPendingLosses(null)}>
                                中止
                            </button>
                        </div>
                    </div>
                )}

                {batchNote && <div className="file-summary" style={{ marginBottom: 10 }}>{batchNote}</div>}

                <div className="file-list">
                    {files.map(f => (
                        <div key={f.id} className="file-row">
                            <div className="file-item">
                                <span className="file-name">{f.file.name}</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span className={`file-status ${f.status}`}>{STATUS_LABEL[f.status]}</span>
                                    {f.status === 'succeeded' && <Check size={16} color="#4cd964" />}
                                    {(f.status === 'refused' || f.status === 'failed') && <AlertCircle size={16} color="#ff3b30" />}
                                    <button className="remove-btn" onClick={() => removeFile(f.id)} disabled={isProcessing}>
                                        <X size={16} />
                                    </button>
                                </div>
                                {f.status === 'processing' && (
                                    <div className="progress-bar-container">
                                        <div className="progress-bar">
                                            <div className="progress-fill" style={{ width: `${f.progress}%` }}></div>
                                        </div>
                                    </div>
                                )}
                            </div>
                            {f.summary && (
                                <div className="file-summary">
                                    {f.summary.pageCount}ページ処理 → {f.summary.targetLabel}へ統一
                                    （元サイズ: {f.summary.sourceCounts.map(s => `${s.label} × ${s.count}`).join(', ')}）
                                </div>
                            )}
                            {f.titleBlockSummary && (
                                <div className="file-summary">
                                    {f.titleBlockSummary.pageCount}ページへ{f.titleBlockSummary.ruleCount}か所の更新を反映しました
                                    {f.titleBlockSummary.embeddedJapaneseFont ? '（日本語フォントを埋め込み）' : ''}
                                </div>
                            )}
                            {f.reason && f.status !== 'succeeded' && (
                                <div className="file-error">
                                    {f.code && <code style={{ marginRight: 8 }}>{f.code}</code>}
                                    {f.reason}
                                </div>
                            )}
                        </div>
                    ))}
                    {files.length === 0 && <div className="empty-state">ファイルが選択されていません</div>}
                </div>
            </div>

            <div className="tools-settings" data-usage-target="processor-settings">
                <h3><Settings size={18} /> 設定</h3>

                {(activeTool === 'layer' || activeTool === 'both') && (
                    <div className="settings-group">
                        <h4>半透明レイヤ設定</h4>
                        <label>不透明度: {Math.round(layerOpacity * 100)}%</label>
                        <input type="range" min="0" max="1" step="0.1" value={layerOpacity}
                            onChange={e => { supersede(); setLayerOpacity(parseFloat(e.target.value)); }} />
                        <label>色</label>
                        <input type="color" value={layerColor}
                            onChange={e => { supersede(); setLayerColor(e.target.value); }} />
                        <p className="info-text">
                            レイヤは表示領域（CropBox）全体に重ねます。注釈はレイヤより上に表示されます。
                        </p>
                        {activeTool === 'both' && <hr style={{ borderColor: '#444', width: '100%' }} />}
                    </div>
                )}

                {(activeTool === 'monochrome' || activeTool === 'both') && (
                    <div className="settings-group">
                        <h4>モノクロ化設定</h4>
                        <label>解像度 (DPI): {monoDpi}</label>
                        <select value={monoDpi} onChange={e => { supersede(); setMonoDpi(parseInt(e.target.value)); }}>
                            <option value={150}>150 (高速)</option>
                            <option value={300}>300 (標準)</option>
                            <option value={600}>600 (高画質)</option>
                        </select>
                        <label>コントラスト: {monoContrast}</label>
                        <input type="range" min="0.5" max="2.0" step="0.1" value={monoContrast}
                            onChange={e => { supersede(); setMonoContrast(parseFloat(e.target.value)); }} />
                        <p className="info-text">
                            この操作はページを画像に置き換えます。実行前に失われる内容を確認します。
                        </p>
                    </div>
                )}

                {(activeTool === 'monochrome' || activeTool === 'both') && (
                    <div className="settings-group">
                        <h4>処理メモリ上限</h4>
                        <select value={memoryBudget}
                            onChange={e => { supersede(); setMemoryBudget(parseInt(e.target.value)); }}>
                            {MEMORY_PRESETS.map(p => (
                                <option key={p} value={p}>{MEMORY_LABEL(p)}{p === DEFAULT_MEMORY_BUDGET ? '（既定）' : ''}</option>
                            ))}
                        </select>
                        <p className="info-text">
                            この処理が使ってよい上限であり、ブラウザ全体で使える容量の保証ではありません。
                            超える場合は解像度を下げずに中止し、理由を表示します。
                        </p>
                    </div>
                )}

                {activeTool === 'margin' && (
                    <div className="settings-group">
                        <p className="info-text">
                            元の内容を縮小し、周囲に余白を作成します。注釈・リンク・フォーム・回転・CropBoxはそのまま保持します。
                            表示領域からはみ出す注釈がある場合は、変更前に中止します。
                        </p>
                        <label>縮小率: {Math.round(marginScale * 100)}%</label>
                        <input type="range" min="0.25" max="0.9" step="0.05" value={marginScale}
                            onChange={e => { supersede(); setMarginScale(parseFloat(e.target.value)); }} />
                        <label>配置</label>
                        <div className="position-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '5px', width: '100px', margin: '0 auto' }}>
                            {(['tl', null, 'tr', null, 'center', null, 'bl', null, 'br'] as const).map((pos, i) => (
                                pos ? (
                                    <button
                                        key={pos}
                                        className={`pos-btn ${marginPosition === pos ? 'active' : ''}`}
                                        onClick={() => { supersede(); setMarginPosition(pos); }}
                                        style={{ height: '30px', border: '1px solid #444', backgroundColor: marginPosition === pos ? '#61dafb' : '#333', cursor: 'pointer' }}
                                    />
                                ) : (
                                    <button key={`gap-${i}`} style={{ height: '30px', border: '1px solid #222', backgroundColor: 'transparent', cursor: 'default' }} disabled />
                                )
                            ))}
                        </div>
                    </div>
                )}

                {activeTool === 'normalize-size' && (
                    <div className="settings-group">
                        <p className="info-text">
                            用紙サイズが混在したPDFを、全ページ同じ用紙サイズへ統一します。
                            画像化せずベクターや検索可能テキストを保持したまま、縦横比を維持して中央に配置します（切り取りなし）。
                        </p>
                        <label>ターゲット用紙</label>
                        <select value={normalizeTarget}
                            onChange={e => { supersede(); setNormalizeTarget(e.target.value as NormalizeTarget); }}>
                            {PAPER_SIZE_KEYS.map(key => <option key={key} value={key}>{key}</option>)}
                            <option value="first-page">最初のページに合わせる</option>
                        </select>
                    </div>
                )}

                {activeTool === 'title-block-update' && (
                    <div className="settings-group">
                        <p className="info-text">
                            図枠の文字を全ページへ一括更新します。中央のプレビューで代表ページの更新したい領域をドラッグして選び、
                            新しい文字を入力してください。最大3か所まで設定できます。
                        </p>
                        <p className="info-text" style={{ color: '#ffcc80' }}>
                            表示を上書きする機能です。元の文字がPDF内部の検索対象として残る場合があるため、
                            墨消し（redaction）には使用しないでください。
                        </p>
                    </div>
                )}

                {activeTool === 'optimize' && (
                    <div className="settings-group">
                        <p className="info-text">
                            構造を保ったまま、ファイルを無損失で再保存します。
                            検索できる文字・ベクター・注釈・リンク・フォーム・回転・メタデータはそのまま残ります。
                        </p>
                        <p className="info-text">
                            画像化は行わないため、解像度の設定はありません。
                            小さくならなかった場合は、元のファイルをそのまま返します。
                        </p>
                    </div>
                )}

                <button
                    className="process-btn"
                    data-usage-target="processor-run"
                    onClick={() => { void startProcessing(); }}
                    disabled={isProcessing || files.length === 0 || titleBlockNotReady}
                    title={titleBlockNotReady ? '代表ページの読み込みが完了するまで実行できません' : undefined}
                >
                    {isProcessing ? <>処理中...</> : <><Play size={18} /> 実行開始</>}
                </button>
            </div>
            <VersionFooter
                toolName="tools"
                version={TOOL_VERSIONS.tools.version}
                lastUpdate={TOOL_VERSIONS.tools.lastUpdate}
            />
        </div>
    );
}
