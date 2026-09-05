/**
 * What each numbered marker on a usage-guide screenshot points at.
 *
 * This file holds only the meaning: which controls a badge covers, and what to
 * call them. Where those controls actually sit in the picture is measured from
 * the running app by scripts/capture-usage-screenshots.mjs and written to
 * usage-screenshot-geometry.json, because hand-tuned percentages are what made
 * the old annotations drift every time a screen was recaptured.
 *
 * `targets` are `data-usage-target` attributes on the real components. A badge
 * may name more than one, and the box drawn is the union of them all -- which
 * is how a group of controls that share no wrapper element can still be circled
 * without adding a wrapper purely for the documentation's benefit.
 */
export interface UsageBadge {
    /** data-usage-target values this badge covers, in DOM order. */
    targets: string[];
    /** Shown beside the number in the guide. */
    desc: string;
}

export interface UsageScreenshot {
    /** Served path, and the key used in the measured geometry file. */
    src: string;
    /** Short note on what state the screen is in, for the capture script. */
    state: string;
    badges: UsageBadge[];
}

export const USAGE_SCREENSHOTS: Record<string, UsageScreenshot> = {
    annotator: {
        src: '/screenshots/annotator.png',
        state: 'PDF加筆 with a synthetic PDF loaded',
        badges: [
            { targets: ['annotator-zoom'], desc: '表示・ズーム' },
            { targets: ['annotator-draw'], desc: '描画・消去・テキスト・範囲選択' },
            { targets: ['annotator-measure', 'annotator-scale'], desc: '計測・縮尺の設定' },
            {
                targets: ['annotator-select-actions', 'annotator-color', 'annotator-style', 'annotator-layers'],
                desc: '複製・削除／色・太さ・透明度／レイヤー',
            },
            { targets: ['annotator-save'], desc: 'PDFとして保存' },
        ],
    },
    comparator: {
        src: '/screenshots/comparator.png',
        state: 'PDF比較 with two synthetic PDFs loaded',
        badges: [
            { targets: ['comparator-files'], desc: 'PDFの読み込み（最大4つ・色分け）と表示切替' },
            { targets: ['comparator-match'], desc: '一致箇所の色と透明度' },
            { targets: ['comparator-report'], desc: '変更箇所抽出レポート' },
            { targets: ['comparator-view'], desc: 'ページ移動・ズーム・差分しきい値' },
            { targets: ['comparator-export'], desc: '書き出し設定と実行' },
        ],
    },
    processor: {
        src: '/screenshots/processor.png',
        state: 'PDF加工 with a synthetic PDF loaded',
        badges: [
            { targets: ['processor-tools'], desc: '7種類の加工メニュー' },
            { targets: ['processor-upload'], desc: 'PDFの読み込み' },
            { targets: ['processor-settings'], desc: '選んだ加工の設定' },
            { targets: ['processor-run'], desc: '実行開始' },
        ],
    },
    split_extract: {
        src: '/screenshots/split_extract.png',
        state: 'PDF抽出・統合, Extract tab, synthetic PDF loaded',
        badges: [
            { targets: ['split-tabs'], desc: '抽出／統合の切替タブ' },
            { targets: ['extract-source'], desc: 'PDFの読み込みと表示サイズ' },
            { targets: ['extract-pages'], desc: 'ページを選択' },
            { targets: ['extract-export'], desc: '選択したページを書き出し' },
        ],
    },
    split_merge: {
        src: '/screenshots/split_merge.png',
        state: 'PDF抽出・統合, Merge tab, two synthetic PDFs added',
        badges: [
            { targets: ['split-tabs'], desc: '抽出／統合の切替タブ' },
            { targets: ['merge-source'], desc: 'PDFを追加' },
            { targets: ['merge-list'], desc: '結合する順序の入れ替えと削除' },
            { targets: ['merge-export'], desc: '統合PDFを書き出し' },
        ],
    },
    textifier: {
        src: '/screenshots/textifier.png',
        state: 'PDFテキスト化, Text Extraction + Word, synthetic scan loaded',
        badges: [
            { targets: ['textifier-upload'], desc: 'PDFの読み込みとプレビュー' },
            { targets: ['textifier-settings'], desc: 'OCR前処理・モード・出力形式' },
            { targets: ['textifier-run'], desc: '実行開始' },
        ],
    },
};

/** Every target the capture script has to find, per screenshot. */
export function targetsFor(key: string): string[] {
    return [...new Set((USAGE_SCREENSHOTS[key]?.badges ?? []).flatMap((b) => b.targets))];
}
