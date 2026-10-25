import React, { useEffect, useRef, useState } from 'react';
import type { Sheet } from '../../utils/drawing-set/model';
import { displayOrientation, displaySizeMm, ORIENTATION_LABEL, paperSizeName } from '../../utils/drawing-set/page-facts';
import { computeVirtualWindow, scrollTopToReveal } from '../../utils/drawing-set/virtual-window';

/**
 * The Sheet List: every live Sheet, one fixed-height row each, with only the
 * rows in view (and a small overscan) in the DOM. At the contract's 5000 Sheets
 * the list holds a few dozen row elements, never 5000.
 *
 * A row shows what P1 knows -- file, page, paper, orientation, whether the page
 * has native text -- and nothing it does not: no drawing number, revision,
 * date or QA result appears here before a later phase can read one.
 *
 * M7-P2-B2: a row can be ticked (the Sheets a profile is assigned to or that
 * are read), and shows the profile it is on and how its confirmation stands.
 * A drawing number appears in a row only once a person has confirmed one for
 * that Sheet; a machine reading never appears here. `describe` is asked for
 * the rows in view only, so 5000 Sheets cost nothing extra.
 */

export const SHEET_ROW_HEIGHT = 48;
export const SHEET_ROW_OVERSCAN = 6;

/** What a row adds for one Sheet. */
export interface SheetRowFacts {
    profile: string | null;
    badge: { text: string; title: string; tone: string; state: string } | null;
    /** The confirmed drawing number, when a person confirmed one. */
    confirmedNumber: string | null;
    /** What that number is, as the confirmation's state says (a stale one is the previous confirmation's). */
    confirmedNumberTitle?: string;
}

interface Props {
    sheets: readonly Sheet[];
    sourceNames: ReadonlyMap<string, string>;
    selectedSheetId: string | null;
    onSelect: (sheetId: string) => void;
    checked?: ReadonlySet<string>;
    onToggle?: (sheetId: string) => void;
    describe?: (sheet: Sheet) => SheetRowFacts;
}

export const VirtualSheetList: React.FC<Props> = ({ sheets, sourceNames, selectedSheetId, onSelect, checked, onToggle, describe }) => {
    const viewportRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);

    useEffect(() => {
        const element = viewportRef.current;
        if (!element) return;
        const observer = new ResizeObserver((entries) => {
            const height = Math.floor(entries[0]?.contentRect.height ?? 0);
            setViewportHeight((current) => (current === height ? current : height));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const selectedIndex = selectedSheetId ? sheets.findIndex((sheet) => sheet.id === selectedSheetId) : -1;

    // Keep the selected row in view when the selection moves (keyboard, or a
    // Source chosen from the file list).
    useEffect(() => {
        const element = viewportRef.current;
        if (!element || selectedIndex < 0) return;
        const next = scrollTopToReveal(selectedIndex, SHEET_ROW_HEIGHT, element.scrollTop, element.clientHeight);
        if (next !== element.scrollTop) element.scrollTop = next;
    }, [selectedIndex]);

    const window_ = computeVirtualWindow({
        rowCount: sheets.length,
        rowHeight: SHEET_ROW_HEIGHT,
        scrollTop,
        viewportHeight,
        overscan: SHEET_ROW_OVERSCAN,
    });

    const move = (index: number): void => {
        if (sheets.length === 0) return;
        const clamped = Math.min(sheets.length - 1, Math.max(0, index));
        onSelect(sheets[clamped].id);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        const page = Math.max(1, Math.floor(viewportHeight / SHEET_ROW_HEIGHT) - 1);
        const from = selectedIndex < 0 ? -1 : selectedIndex;
        const target = {
            ArrowDown: from + 1,
            ArrowUp: from - 1,
            PageDown: from + page,
            PageUp: from - page,
            Home: 0,
            End: sheets.length - 1,
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        move(target);
    };

    const rows: React.ReactNode[] = [];
    for (let index = window_.start; index < window_.end; index++) {
        const sheet = sheets[index];
        const facts = sheet.pageFacts;
        const selected = sheet.id === selectedSheetId;
        const paper = facts ? paperSizeName(facts.uprightWidthPt, facts.uprightHeightPt) : null;
        const orientation = facts ? ORIENTATION_LABEL[displayOrientation(facts)] : '';
        const extra = describe?.(sheet) ?? null;
        rows.push(
            <div
                key={sheet.id}
                role="option"
                aria-selected={selected}
                className={`ds-sheet-row${selected ? ' is-selected' : ''}`}
                style={{ top: index * SHEET_ROW_HEIGHT, height: SHEET_ROW_HEIGHT }}
                onClick={() => onSelect(sheet.id)}
                data-ds-sheet-row
                data-ds-sheet-id={sheet.id}
                data-ds-row-index={index}
                data-ds-page={sheet.pageNumber}
            >
                {onToggle && (
                    <input
                        type="checkbox"
                        className="ds-sheet-check"
                        checked={checked?.has(sheet.id) ?? false}
                        onChange={() => onToggle(sheet.id)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`p.${sheet.pageNumber}を選ぶ`}
                        data-ds-sheet-check
                    />
                )}
                <span className="ds-sheet-page">p.{sheet.pageNumber}</span>
                <span className="ds-sheet-main">
                    <span className="ds-sheet-source" title={sourceNames.get(sheet.sourceId) ?? ''}>
                        {sourceNames.get(sheet.sourceId) ?? ''}
                        {extra?.profile && <span className="ds-sheet-profile" title="割り当てたプロファイル" data-ds-sheet-profile>{extra.profile}</span>}
                    </span>
                    <span className="ds-sheet-facts">
                        {extra && extra.confirmedNumber !== null && (
                            <span className="ds-sheet-number" title={extra.confirmedNumberTitle ?? '確定した図面番号'} data-ds-sheet-number>{extra.confirmedNumber || '（空欄）'}</span>
                        )}
                        {facts ? `${paper ? `${paper} ` : ''}${orientation}・${displaySizeMm(facts)}` : '用紙情報なし'}
                    </span>
                </span>
                {extra?.badge && (
                    <span className={`ds-currency is-${extra.badge.tone}`} title={extra.badge.title} data-ds-sheet-badge={extra.badge.state}>{extra.badge.text}</span>
                )}
                {facts && (
                    <span
                        className={`ds-kind-badge ${facts.kind === 'text-native' ? 'is-text' : 'is-no-text'}`}
                        title={facts.kind === 'text-native' ? 'PDF内に読み取れるテキスト情報があります' : 'PDF内に読み取れるテキスト情報がありません（スキャン画像など）'}
                    >
                        {facts.kind === 'text-native' ? 'テキストあり' : 'テキストなし'}
                    </span>
                )}
            </div>,
        );
    }

    return (
        <div
            ref={viewportRef}
            className="ds-sheet-list"
            role="listbox"
            aria-label="ページ一覧"
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            data-ds-sheet-list
            data-ds-row-count={sheets.length}
            data-ds-rendered-rows={window_.end - window_.start}
        >
            <div className="ds-sheet-list-inner" style={{ height: window_.totalHeight }}>
                {rows}
            </div>
        </div>
    );
};
