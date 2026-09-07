/**
 * The drawing register workflow: profile, assign, extract, review, export.
 *
 * The shape of this screen follows from one rule: **a row is a candidate until
 * a person confirms it**. So there is no "confirm all", the export button is
 * backed by a function-level check rather than a disabled attribute, and the
 * review list holds every row -- not the flagged ones. A list that showed only
 * flagged rows would quietly turn "nothing flagged" into "nothing to check",
 * and a value read confidently and wrongly carries no flag at all.
 *
 * Lifecycle follows the pattern the Excel exporter established: a generation
 * per kind of async job, a named owner for the busy flag, and the workbook URL
 * owned by a ref so unmount can revoke it directly. React does not run state
 * updaters for a component that is going away, so a URL revoked only inside a
 * setState leaks.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import './DrawingRegisterExporter.css';
import {
    analyseRegisterPage, attentionQueue, AssignmentSet, buildRegisterWorkbook,
    confirmRow, createProfile, exportReadiness, extractRegister, FIELD_LABELS, invalidateRow,
    missingFields, parsePageRange, registerFileName, RegisterOcrEngine, reviewSurface,
    toUprightRect, TRANSFER_MODEL_LABELS, REGISTER_FIELDS, XLSX_MIME,
} from '../utils/pdf-textifier';
import type {
    RegisterFieldName, RegisterPageGeometry, RegisterRow, SelectionRect,
    TemplateProfile, TransferModel,
} from '../utils/pdf-textifier';

const RENDER_WIDTH = 720;

interface Props {
    file: File;
    doc: pdfjsLib.PDFDocumentProxy;
}

type DraftFields = Partial<Record<RegisterFieldName, SelectionRect>>;

export const DrawingRegisterExporter: React.FC<Props> = ({ file, doc }) => {
    const [pageNumber, setPageNumber] = useState(1);
    const [geometry, setGeometry] = useState<RegisterPageGeometry | null>(null);
    const [analysing, setAnalysing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [profiles, setProfiles] = useState<TemplateProfile[]>([]);
    const [draftName, setDraftName] = useState('');
    const [draftModel, setDraftModel] = useState<TransferModel>('normalised');
    const [draftFields, setDraftFields] = useState<DraftFields>({});
    const [activeField, setActiveField] = useState<RegisterFieldName>('drawing_number');

    const [assignProfileId, setAssignProfileId] = useState<string>('');
    const [assignRange, setAssignRange] = useState('');
    const [assignmentVersion, setAssignmentVersion] = useState(0);

    const [rows, setRows] = useState<RegisterRow[] | null>(null);
    // Bumped whenever the profiles or the assignments change. Rows carry the
    // number they were read under, and the export refuses any that do not match.
    const [sourceRevision, setSourceRevision] = useState(0);
    const [openPage, setOpenPage] = useState<number | null>(null);
    const [edits, setEdits] = useState<Partial<Record<RegisterFieldName, string>>>({});
    const [workbookUrl, setWorkbookUrl] = useState<string | null>(null);

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
    const assignmentsRef = useRef(new AssignmentSet());
    const ocrRef = useRef<RegisterOcrEngine | null>(null);
    const dragRef = useRef<{ x: number; y: number } | null>(null);
    const [dragRect, setDragRect] = useState<SelectionRect | null>(null);
    const [renderScale, setRenderScale] = useState(1);

    const pageGeneration = useRef(0);
    const extractGeneration = useRef(0);
    const workbookGeneration = useRef(0);

    const busyOwner = useRef<string | null>(null);
    const claimBusy = useCallback((owner: string) => {
        busyOwner.current = owner;
        setBusy(true);
    }, []);
    const releaseBusy = useCallback((owner: string) => {
        if (busyOwner.current !== owner) return;
        busyOwner.current = null;
        setBusy(false);
    }, []);

    const workbookUrlRef = useRef<string | null>(null);
    const dropWorkbook = useCallback(() => {
        const previous = workbookUrlRef.current;
        workbookUrlRef.current = null;
        if (previous) URL.revokeObjectURL(previous);
        setWorkbookUrl(null);
    }, []);
    const publishWorkbook = useCallback((url: string) => {
        const previous = workbookUrlRef.current;
        workbookUrlRef.current = url;
        if (previous && previous !== url) URL.revokeObjectURL(previous);
        setWorkbookUrl(url);
    }, []);

    /**
     * A change to the profiles or the assignments discards the whole reading.
     *
     * Taking the confirmations off is not enough. The values would still be
     * sitting there -- read through a template that has since moved, or a page
     * that now belongs to a different profile -- ready to be confirmed a second
     * time and exported. So the rows go, the revision moves on, and the
     * register has to be read again.
     *
     * That is blunter than a partial recompute and it is the right size for
     * this: "the screen shows the new arrangement, the file holds the old one"
     * is a silent failure, and nothing here is expensive enough to justify
     * risking it.
     */
    const invalidateArrangement = useCallback((reason: string) => {
        extractGeneration.current++;
        workbookGeneration.current++;
        setSourceRevision((r) => r + 1);
        dropWorkbook();
        setRows(null);
        setOpenPage(null);
        setEdits({});
        setStatus(`${reason} もう一度読み取ってください。`);
    }, [dropWorkbook]);

    // A new document is a new everything.
    useEffect(() => {
        pageGeneration.current++;
        extractGeneration.current++;
        workbookGeneration.current++;
        busyOwner.current = null;
        setBusy(false);
        setPageNumber(1);
        setGeometry(null);
        setProfiles([]);
        setDraftFields({});
        setDraftName('');
        setActiveField('drawing_number');
        assignmentsRef.current = new AssignmentSet();
        setAssignmentVersion((v) => v + 1);
        setAssignProfileId('');
        setAssignRange('');
        setRows(null);
        setSourceRevision(0);
        setOpenPage(null);
        setEdits({});
        setError(null);
        setStatus(null);
        dropWorkbook();
        void ocrRef.current?.terminate();
        ocrRef.current = null;
    }, [doc, dropWorkbook]);

    // Leaving takes everything with it. React will not run a state updater for
    // a component that is unmounting, so the URL and the worker are released
    // here directly rather than through setState.
    useEffect(() => () => {
        pageGeneration.current++;
        extractGeneration.current++;
        workbookGeneration.current++;
        busyOwner.current = null;

        try {
            renderTaskRef.current?.cancel();
        } catch { /* a task that has already settled cannot be cancelled */ }
        renderTaskRef.current = null;

        void ocrRef.current?.terminate();
        ocrRef.current = null;

        const url = workbookUrlRef.current;
        workbookUrlRef.current = null;
        if (url) URL.revokeObjectURL(url);
    }, []);

    // Render the representative page, and read its geometry.
    useEffect(() => {
        const id = ++pageGeneration.current;
        let page: pdfjsLib.PDFPageProxy | null = null;
        setAnalysing(true);

        (async () => {
            try {
                page = await doc.getPage(pageNumber);
                if (pageGeneration.current !== id) return;

                const base = page.getViewport({ scale: 1 });
                const scale = RENDER_WIDTH / base.width;
                const viewport = page.getViewport({ scale });
                const canvas = canvasRef.current;
                if (!canvas) return;
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                setRenderScale(scale);

                const task = page.render({ canvas, viewport, intent: 'print' });
                renderTaskRef.current = task;
                await task.promise;
                if (pageGeneration.current !== id) return;

                const geom = await analyseRegisterPage(doc, pageNumber);
                if (pageGeneration.current !== id) return;
                setGeometry(geom);
            } catch (err) {
                if (pageGeneration.current !== id) return;
                if ((err as Error)?.name === 'RenderingCancelledException') return;
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                page?.cleanup();
                if (pageGeneration.current === id) setAnalysing(false);
            }
        })();

        return () => {
            try {
                renderTaskRef.current?.cancel();
            } catch { /* already settled */ }
            renderTaskRef.current = null;
        };
    }, [doc, pageNumber]);

    // ---- drawing a field region --------------------------------------------

    const canDraw = Boolean(geometry) && !analysing && !busy && geometry?.pageNumber === pageNumber;

    const canvasPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * (event.currentTarget.width / rect.width),
            y: (event.clientY - rect.top) * (event.currentTarget.height / rect.height),
        };
    };

    const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (!canDraw) return;
        dragRef.current = canvasPoint(event);
        setDragRect(null);
    };
    const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (!dragRef.current) return;
        const now = canvasPoint(event);
        const start = dragRef.current;
        setDragRect({
            left: Math.min(start.x, now.x), right: Math.max(start.x, now.x),
            top: Math.min(start.y, now.y), bottom: Math.max(start.y, now.y),
        });
    };
    const onMouseUp = () => {
        const start = dragRef.current;
        dragRef.current = null;
        if (!start || !dragRect || !geometry) { setDragRect(null); return; }
        if (dragRect.right - dragRect.left < 6 || dragRect.bottom - dragRect.top < 6) {
            setDragRect(null);
            return;
        }
        // Canvas pixels -> display points -> upright points, which is the one
        // space the profile is stored in.
        const display: SelectionRect = {
            left: dragRect.left / renderScale, right: dragRect.right / renderScale,
            top: dragRect.top / renderScale, bottom: dragRect.bottom / renderScale,
        };
        const upright = toUprightRect(display, geometry.rotate, geometry.displayWidth, geometry.displayHeight);
        setDraftFields((current) => ({ ...current, [activeField]: upright }));
        setDragRect(null);

        const remaining = REGISTER_FIELDS.filter((name) => name !== activeField && !draftFields[name]);
        if (remaining.length > 0) setActiveField(remaining[0]);
    };

    const draftMissing = useMemo(() => missingFields(draftFields), [draftFields]);

    const saveProfile = () => {
        if (!geometry) return;
        try {
            const profile = createProfile({
                name: draftName, model: draftModel, page: geometry, fields: draftFields,
            });
            setProfiles((current) => [...current, profile]);
            setAssignProfileId(profile.id);
            setDraftFields({});
            setDraftName('');
            setActiveField('drawing_number');
            setStatus(`プロファイル「${profile.name}」を保存しました。ページを割り当ててください。`);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const deleteProfile = (profileId: string) => {
        const dropped = assignmentsRef.current.clearProfile(profileId);
        setProfiles((current) => current.filter((p) => p.id !== profileId));
        setAssignmentVersion((v) => v + 1);
        if (assignProfileId === profileId) setAssignProfileId('');
        invalidateArrangement(dropped.length > 0
            ? `プロファイルを削除しました。${dropped.length}ページの割り当てが外れました。`
            : 'プロファイルを削除しました。');
    };

    // ---- assignment ---------------------------------------------------------

    const assignPages = (force: boolean) => {
        if (!assignProfileId) return;
        const { pages, errors } = parsePageRange(assignRange, doc.numPages);
        if (errors.length > 0) { setError(errors.join(' / ')); return; }
        if (pages.length === 0) { setError('割り当てるページを入力してください。'); return; }

        if (force) {
            assignmentsRef.current.reassign(pages, assignProfileId);
            setAssignmentVersion((v) => v + 1);
            setError(null);
            invalidateArrangement(`${pages.length}ページを割り当て直しました。`);
            return;
        }
        const result = assignmentsRef.current.assign(pages, assignProfileId);
        setAssignmentVersion((v) => v + 1);
        if (result.conflicts.length > 0) {
            setError(`${result.conflicts.map((c) => c.pageNumber).join(', ')} は別のプロファイルに割り当て済みです。`
                + '「割り当て直す」を押すと変更できます。');
        } else {
            setError(null);
        }
        if (result.assigned.length > 0) {
            invalidateArrangement(`${result.assigned.length}ページを割り当てました。`);
        }
    };

    const unassigned = useMemo(
        () => { void assignmentVersion; return assignmentsRef.current.unassigned(doc.numPages); },
        [assignmentVersion, doc.numPages],
    );
    const assignedCount = doc.numPages - unassigned.length;

    // ---- extraction ---------------------------------------------------------

    const runExtraction = async () => {
        if (profiles.length === 0) { setError('先にプロファイルを作成してください。'); return; }
        const id = ++extractGeneration.current;
        const owner = `extract:${id}`;
        const stale = () => extractGeneration.current !== id;
        claimBusy(owner);
        setError(null);
        dropWorkbook();

        const ocr = ocrRef.current ?? new RegisterOcrEngine();
        ocrRef.current = ocr;
        try {
            const result = await extractRegister({
                doc,
                profiles: new Map(profiles.map((p) => [p.id, p])),
                assignments: assignmentsRef.current,
                ocr,
                sourceRevision,
                shouldCancel: stale,
                onProgress: (n, total) => {
                    if (stale()) return;
                    setStatus(`${total}ページ中 ${n}ページ目を読み取り中…`);
                },
            });
            if (stale()) return;
            setRows(result.rows);
            setOpenPage(null);
            setEdits({});
            setStatus(`${result.rows.length}行を読み取りました。すべての行を確認してください。`);
        } catch (err) {
            if (stale() || (err as Error)?.message === 'cancelled') return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            releaseBusy(owner);
        }
    };

    // ---- review -------------------------------------------------------------

    const surface = useMemo(() => (rows ? reviewSurface(rows) : []), [rows]);
    const attention = useMemo(() => (rows ? attentionQueue(rows) : []), [rows]);
    const readiness = useMemo(
        () => exportReadiness(rows ?? [], doc.numPages, sourceRevision),
        [rows, doc.numPages, sourceRevision],
    );

    const openRow = rows?.find((row) => row.pageNumber === openPage) ?? null;

    const startReview = (page: number) => {
        setOpenPage(page);
        const row = rows?.find((r) => r.pageNumber === page);
        setEdits(row
            ? Object.fromEntries(REGISTER_FIELDS.map((name) => [name, row.fields[name].value]))
            : {});
    };

    const confirmOpenRow = () => {
        if (!openRow) return;
        const confirmed = confirmRow(openRow, edits);
        setRows((current) => (current
            ? current.map((row) => (row.pageNumber === confirmed.pageNumber ? confirmed : row))
            : current));
        workbookGeneration.current++;
        dropWorkbook();
        setOpenPage(null);
        setEdits({});
        setStatus(`ページ ${confirmed.pageNumber} を確認済みにしました。`);
    };

    const unconfirmRow = (page: number) => {
        setRows((current) => (current
            ? current.map((row) => (row.pageNumber === page ? invalidateRow(row) : row))
            : current));
        workbookGeneration.current++;
        dropWorkbook();
    };

    // ---- export -------------------------------------------------------------

    const buildWorkbook = async () => {
        if (!rows) return;
        const id = ++workbookGeneration.current;
        const owner = `workbook:${id}`;
        const stale = () => workbookGeneration.current !== id;
        const snapshot = rows.map((row) => ({ ...row }));
        claimBusy(owner);
        setError(null);
        try {
            // The readiness check lives inside buildRegisterWorkbook too. A
            // disabled button is a suggestion; that check is the rule.
            const result = await buildRegisterWorkbook(snapshot, doc.numPages, {
                shouldCancel: stale, sourceRevision,
            });
            if (stale()) return;
            const blob = new Blob([result.bytes as BlobPart], { type: XLSX_MIME });
            publishWorkbook(URL.createObjectURL(blob));
            setStatus(`図面一覧（${result.cellCount}セル）を作成しました。`);
        } catch (err) {
            if (stale() || (err as Error)?.message === 'cancelled') return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            releaseBusy(owner);
        }
    };

    const profileName = (id: string | null) => profiles.find((p) => p.id === id)?.name ?? '—';

    return (
        <div className="drawing-register" data-usage-target="drawing-register-workflow">
            <h3>図面一覧（Excel）</h3>
            <p className="dr-lead">
                表題欄の位置を指定して、1ページ＝1行の図面一覧を作ります。
                読み取りはこの端末の中だけで行われ、ファイルは外部に送信されません。
                <strong>すべての行を確認するまで書き出しはできません。</strong>
            </p>

            {/* Step 1: the template */}
            <section className="dr-step" data-usage-target="drawing-register-profile">
                <h4>1. 表題欄プロファイルを作る</h4>
                <div className="dr-page-nav">
                    <button type="button" disabled={pageNumber <= 1 || busy}
                        onClick={() => setPageNumber((n) => Math.max(1, n - 1))}>前のページ</button>
                    <span>{pageNumber} / {doc.numPages}</span>
                    <button type="button" disabled={pageNumber >= doc.numPages || busy}
                        onClick={() => setPageNumber((n) => Math.min(doc.numPages, n + 1))}>次のページ</button>
                    {analysing && <span className="dr-muted">読み込み中…</span>}
                </div>

                <div className="dr-canvas-wrap">
                    <canvas
                        ref={canvasRef}
                        data-usage-target="drawing-register-canvas"
                        data-geometry-page={geometry?.pageNumber ?? ''}
                        className={canDraw ? 'dr-canvas dr-canvas-active' : 'dr-canvas'}
                        onMouseDown={onMouseDown}
                        onMouseMove={onMouseMove}
                        onMouseUp={onMouseUp}
                        onMouseLeave={onMouseUp}
                    />
                    {dragRect && (
                        <div className="dr-drag" style={{
                            left: `${(dragRect.left / (canvasRef.current?.width ?? 1)) * 100}%`,
                            top: `${(dragRect.top / (canvasRef.current?.height ?? 1)) * 100}%`,
                            width: `${((dragRect.right - dragRect.left) / (canvasRef.current?.width ?? 1)) * 100}%`,
                            height: `${((dragRect.bottom - dragRect.top) / (canvasRef.current?.height ?? 1)) * 100}%`,
                        }} />
                    )}
                </div>

                <div className="dr-fields">
                    {REGISTER_FIELDS.map((name) => (
                        <button
                            key={name}
                            type="button"
                            className={activeField === name ? 'dr-field dr-field-active' : 'dr-field'}
                            onClick={() => setActiveField(name)}
                            disabled={busy}
                        >
                            {FIELD_LABELS[name]}
                            <span>{draftFields[name] ? '指定済み' : '未指定'}</span>
                        </button>
                    ))}
                </div>
                <p className="dr-muted">
                    {canDraw
                        ? `「${FIELD_LABELS[activeField]}」の範囲を図面上でドラッグしてください。`
                        : 'ページの読み込みが終わるまでお待ちください。'}
                </p>

                <div className="dr-profile-form">
                    <label>
                        プロファイル名
                        <input type="text" value={draftName} disabled={busy}
                            onChange={(e) => setDraftName(e.target.value)}
                            placeholder="例: A社 表題欄" />
                    </label>
                    <label>
                        用紙サイズが違うページへの当てはめ方
                        <select value={draftModel} disabled={busy}
                            onChange={(e) => setDraftModel(e.target.value as TransferModel)}>
                            {(Object.keys(TRANSFER_MODEL_LABELS) as TransferModel[]).map((model) => (
                                <option key={model} value={model}>{TRANSFER_MODEL_LABELS[model]}</option>
                            ))}
                        </select>
                    </label>
                    <button type="button" onClick={saveProfile}
                        disabled={busy || draftMissing.length > 0 || !geometry}>
                        プロファイルを保存
                    </button>
                </div>
                {draftMissing.length > 0 && (
                    <p className="dr-muted">
                        未指定: {draftMissing.map((name) => FIELD_LABELS[name]).join('、')}
                    </p>
                )}
            </section>

            {/* Step 2: assignment */}
            {profiles.length > 0 && (
                <section className="dr-step" data-usage-target="drawing-register-assign">
                    <h4>2. ページにプロファイルを割り当てる</h4>
                    <ul className="dr-profile-list">
                        {profiles.map((profile) => (
                            <li key={profile.id}>
                                <span>{profile.name}</span>
                                <span className="dr-muted">{TRANSFER_MODEL_LABELS[profile.model]}</span>
                                <button type="button" disabled={busy}
                                    onClick={() => deleteProfile(profile.id)}>削除</button>
                            </li>
                        ))}
                    </ul>
                    <div className="dr-assign-form">
                        <select value={assignProfileId} disabled={busy}
                            onChange={(e) => setAssignProfileId(e.target.value)}>
                            <option value="">プロファイルを選択</option>
                            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <input type="text" value={assignRange} disabled={busy}
                            onChange={(e) => setAssignRange(e.target.value)}
                            placeholder="例: 1-5, 8" />
                        <button type="button" onClick={() => assignPages(false)} disabled={busy}>割り当て</button>
                        <button type="button" onClick={() => assignPages(true)} disabled={busy}>割り当て直す</button>
                    </div>
                    <p className="dr-muted" data-usage-target="drawing-register-unassigned">
                        割り当て済み {assignedCount} / {doc.numPages} ページ
                        {unassigned.length > 0 && `  未割り当て: ${unassigned.join(', ')}`}
                    </p>
                    {unassigned.length > 0 && (
                        <p className="dr-note">
                            未割り当てのページも一覧には残ります。どのプロファイルにあたるかは推測しません。
                        </p>
                    )}
                </section>
            )}

            {/* Step 3: extract */}
            {profiles.length > 0 && (
                <section className="dr-step">
                    <h4>3. 読み取る</h4>
                    <button type="button" onClick={runExtraction} disabled={busy}
                        data-usage-target="drawing-register-extract">
                        {rows ? '読み取り直す' : '図面一覧を読み取る'}
                    </button>
                </section>
            )}

            {/* Step 4: review */}
            {rows && (
                <section className="dr-step" data-usage-target="drawing-register-review">
                    <h4>4. すべての行を確認する</h4>
                    <p className="dr-muted">
                        確認済み {readiness.confirmedCount} / {rows.length} 行
                        （うち注意表示あり {attention.length} 行）。
                        注意表示がない行も確認が必要です。
                    </p>
                    <table className="dr-table">
                        <thead>
                            <tr>
                                <th>ページ</th><th>図面番号</th><th>図面名称</th><th>版</th><th>日付</th>
                                <th>取得元</th><th>状態</th><th />
                            </tr>
                        </thead>
                        <tbody>
                            {surface.map((entry) => {
                                const row = rows.find((r) => r.pageNumber === entry.pageNumber)!;
                                return (
                                    <tr key={entry.pageNumber}
                                        className={row.reviewStatus === 'confirmed' ? 'dr-confirmed' : undefined}
                                        data-register-page={entry.pageNumber}
                                        data-register-status={row.reviewStatus}>
                                        <td>{row.pageNumber}</td>
                                        <td>{row.fields.drawing_number.value || '—'}</td>
                                        <td>{row.fields.drawing_title.value || '—'}</td>
                                        <td>{row.fields.revision.value || '—'}</td>
                                        <td>{row.fields.revision_date.value || '—'}</td>
                                        <td className="dr-muted">
                                            {row.extraction === 'unassigned' ? '未割り当て' : row.extraction}
                                        </td>
                                        <td>
                                            {row.reviewStatus === 'confirmed' ? '確認済み' : '未確認'}
                                            {entry.reasons.length > 0 && (
                                                <span className="dr-flag" title={entry.reasons.join(' / ')}>
                                                    要注意
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            <button type="button" disabled={busy}
                                                onClick={() => (row.reviewStatus === 'confirmed'
                                                    ? unconfirmRow(row.pageNumber)
                                                    : startReview(row.pageNumber))}>
                                                {row.reviewStatus === 'confirmed' ? '確認を取り消す' : '確認する'}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </section>
            )}

            {/* One row, opened for review. */}
            {openRow && (
                <section className="dr-step dr-review-row" data-usage-target="drawing-register-row">
                    <h4>ページ {openRow.pageNumber} を確認</h4>
                    <p className="dr-muted">プロファイル: {profileName(openRow.profileId)}</p>
                    {openRow.reviewReasons.length > 0 && (
                        <ul className="dr-reasons">
                            {openRow.reviewReasons.map((reason, i) => <li key={i}>{reason}</li>)}
                        </ul>
                    )}
                    {REGISTER_FIELDS.map((name) => {
                        const field = openRow.fields[name];
                        return (
                            <div className="dr-review-field" key={name}>
                                <label>
                                    {FIELD_LABELS[name]}
                                    <input
                                        type="text"
                                        value={edits[name] ?? ''}
                                        onChange={(e) => setEdits((c) => ({ ...c, [name]: e.target.value }))}
                                        data-register-field={name}
                                    />
                                </label>
                                <div className="dr-raw">
                                    <span className="dr-muted">読み取った文字（全文）</span>
                                    <pre data-register-raw={name}>{field.rawText || '（なし）'}</pre>
                                    <span className="dr-muted">
                                        取得元: {field.source === 'native' ? '文字情報' : field.source === 'ocr' ? '画像認識' : 'なし'}
                                        {field.ocrScore !== null && `  OCR内部スコア: ${field.ocrScore}`}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                    <p className="dr-note">
                        OCR内部スコアは認識エンジン自身の指標で、正しさの保証ではありません。
                    </p>
                    <div className="dr-row-actions">
                        <button type="button" onClick={confirmOpenRow} disabled={busy}
                            data-usage-target="drawing-register-confirm">この行を確認済みにする</button>
                        <button type="button" onClick={() => { setOpenPage(null); setEdits({}); }}
                            disabled={busy}>閉じる</button>
                    </div>
                </section>
            )}

            {/* Step 5: export */}
            {rows && (
                <section className="dr-step" data-usage-target="drawing-register-export">
                    <h4>5. 図面一覧を書き出す</h4>
                    {!readiness.ready && <p className="dr-note">{readiness.reason}</p>}
                    <button type="button" onClick={buildWorkbook} disabled={busy || !readiness.ready}>
                        Excel を作成
                    </button>
                    {workbookUrl && (
                        <a className="dr-download" href={workbookUrl} download={registerFileName(file.name)}>
                            ダウンロード（{registerFileName(file.name)}）
                        </a>
                    )}
                </section>
            )}

            {status && <p className="dr-status">{status}</p>}
            {error && <p className="dr-error">{error}</p>}
        </div>
    );
};
