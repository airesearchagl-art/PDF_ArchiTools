import React, { useEffect, useState } from 'react';
import {
    PenTool, Ruler, ZoomIn, Download, Blend, FileText, UploadCloud, Combine,
    ArrowUp, ArrowDown, ScanText, Settings, History, Play, Stamp, ChevronDown,
    Layers, Eye, MousePointer2, Scissors,
} from 'lucide-react';
import { TOOL_VERSIONS } from '../config/versions';
import { USAGE_SCREENSHOTS } from './usageScreenshotBadges';
import measuredGeometry from './usage-screenshot-geometry.json';
import './HowToUse.css';

/**
 * ユーザー向けの更新履歴。
 *
 * technical changelog ではなく「使う人から見て何ができるようになったか」を書く。
 * PR番号・SHA・内部実装の用語はここには入れない。新しいものを先頭に追加する。
 */
interface ReleaseNote {
    date: string;
    tool: string;
    version: string;
    changes: string[];
}

const releaseHistory: ReleaseNote[] = [
    {
        date: '2026/09/05',
        tool: 'PDFテキスト化',
        version: '1.5.0',
        changes: [
            'PDFの文字を編集可能なWord（.docx）へ書き出せるようになりました。',
            '文字情報を持つページはその文字を、スキャンページはOCRの結果を使います。',
            '元のPDFのページ順を保ち、ページの区切りをWordの改ページとして入れます。',
            '元PDFのレイアウト・表・画像を再現する機能ではありません。',
        ],
    },
    {
        date: '2026/09/05',
        tool: 'PDFテキスト化',
        version: '1.4.0',
        changes: [
            'スキャンPDFのOCR前に、ページの傾きを補正できるようになりました。',
            '軽微なスキャンノイズを取り除いてから文字認識へ渡せるようになりました。',
            '前処理は文字認識用の画像だけに適用され、元のPDFの見た目は変わりません。',
            'どちらも初期状態はオフです。必要なときにチェックしてご利用ください。',
        ],
    },
    {
        date: '2026/09/05',
        tool: 'PDFテキスト化',
        version: '1.3.1',
        changes: [
            'PDF読み込み時に1ページ目のプレビューが正しく表示されない問題を修正しました。',
        ],
    },
    {
        date: '2026/09/05',
        tool: 'PDFテキスト化',
        version: '1.3.0',
        changes: [
            'PDFから文字をTXTファイルとして書き出せるようになりました。',
            '文字情報を持つページは、その文字を直接取得します。',
            'スキャンページは日本語・英語のOCRを行います。',
            '文字ページとスキャンページが混在したPDFにも対応します。',
            '元のPDFのページ順を維持して書き出します。',
        ],
    },
    {
        date: '2026/09/04',
        tool: 'PDF加工',
        version: '1.3.0',
        changes: [
            '「図枠一括更新」を追加しました。',
            '図枠の日付やステータスの文字を、複数ページへ一括で反映できます。',
            '代表ページで更新したい場所をドラッグして選び、最大3か所まで設定できます。',
            '用紙に対する相対位置で反映するため、A1とA3が混在していても同じ位置に入ります。',
            'ページ全体を画像化せずに処理します。',
        ],
    },
    {
        date: '2026/09/04',
        tool: 'PDF加工',
        version: '1.2.0',
        changes: [
            '「図面サイズ統一」を追加しました。',
            'A0〜A4への一括統一、または「最初のページに合わせる」を選べます。',
            'A1とA3などが混在したPDFを、1つの用紙サイズにそろえられます。',
            '線や文字はベクターのまま、検索できる文字情報も保持したまま処理します。',
        ],
    },
    {
        date: '2026/09/03',
        tool: 'PDFテキスト化',
        version: '1.2.0',
        changes: [
            '日本語・英語の文字認識（OCR）に対応しました。',
            'スキャンしたPDFから、検索・選択できるPDFを作れます。',
            'ページごとに「文字情報あり」「スキャン画像」を判定します。',
            '文字情報がないページだけをOCRするため、必要なところだけ処理します。',
            '文字認識はブラウザ内で実行されます。',
        ],
    },
];

const VersionBadge = ({ version }: { version: string }) => (
    <span style={{
        fontSize: '0.75rem',
        backgroundColor: '#f0f0f0',
        color: '#666',
        padding: '2px 8px',
        borderRadius: '12px',
        border: '1px solid #ddd',
        whiteSpace: 'nowrap',
        flexShrink: 0,
    }}>
        v{version}
    </span>
);

/** The five tools, in the order the top navigation shows them. */
const TOOL_IDS = ['annotator', 'comparator', 'processor', 'split-merge', 'textifier'] as const;
type ToolId = typeof TOOL_IDS[number];

/** The tool a URL hash points at, or null when it points elsewhere. */
function hashToolId(): ToolId | null {
    if (typeof window === 'undefined') return null;
    const id = window.location.hash.replace('#', '');
    return (TOOL_IDS as readonly string[]).includes(id) ? (id as ToolId) : null;
}

function scrollToHash(): void {
    const id = window.location.hash.replace('#', '');
    if (!id) return;
    // After the panel has been laid out, or the browser lands where the header
    // used to be rather than where it is now.
    requestAnimationFrame(() => {
        // A tool link points at its section wrapper; anything else -- the
        // release history -- is an id in its own right.
        const target = document.getElementById(`usage-section-${id}`) ?? document.getElementById(id);
        target?.scrollIntoView({ block: 'start' });
    });
}

export function HowToUse() {
    // Everything starts closed, so opening the guide shows the five tools
    // rather than the first tool's manual. A link straight to one tool is the
    // exception, and it is read here rather than in an effect so the very
    // first render already has the right section open.
    const [openId, setOpenId] = useState<ToolId | null>(hashToolId);

    useEffect(() => {
        const onHashChange = () => {
            const id = hashToolId();
            if (id) setOpenId(id);
            scrollToHash();
        };
        window.addEventListener('hashchange', onHashChange);
        // A deep link that was already in the URL still has to be scrolled to.
        if (window.location.hash) scrollToHash();
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    const toggle = (id: ToolId) => setOpenId((current) => (current === id ? null : id));

    return (
        <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
            <div style={{ textAlign: 'center', marginBottom: '24px', padding: '0 12px' }}>
                <h2 style={{ fontSize: 'clamp(1.3rem, 3.2vw, 2rem)', margin: '0 0 8px', color: '#fff' }}>
                    建築設計お役立ちPDFツール集へようこそ
                </h2>
                <p style={{ color: '#ccc', margin: '0 0 8px' }}>
                    5つのツールの使い方ガイドです。読みたいツールを選ぶと説明が開きます。
                </p>
                <p style={{ margin: '0 0 8px', fontSize: '0.85em', color: '#ffecb3', lineHeight: 1.6 }}>
                    ※ 読み込んだPDFファイルは、お使いのブラウザ内で処理されます。
                    文字認識（OCR）もブラウザ内で実行され、PDFを外部のAI・OCRサービスへ送信することはありません。
                </p>
                <p style={{ margin: 0, fontSize: '0.85em', color: '#9fd3ff' }}>
                    <History size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '6px' }} />
                    最近の更新: <b>Word（.docx）書き出し</b>（PDFテキスト化 v1.5.0）
                    — <a href="#release-history" style={{ color: '#9fd3ff' }}>更新履歴</a>
                </p>
            </div>

            <div className="usage-accordion">
                {/* 1. ANNOTATOR */}
                <ToolSection
                    id="annotator"
                    number={1}
                    accent="#4a90e2"
                    icon={<PenTool size={22} />}
                    titleJa="PDF加筆"
                    titleEn="Annotator"
                    summary="PDFへ手書き・文字・計測情報を追加"
                    version={TOOL_VERSIONS.annotator.version}
                    open={openId === 'annotator'}
                    onToggle={toggle}
                >
                    <p style={{ marginTop: 0 }}>
                        PDF図面に手書き感覚で加筆できるツールです。タブレットやペン入力に対応し、
                        距離・面積の計測もできます。
                    </p>

                    <ScreenWithBadges screenshot="annotator" />

                    <div style={gridStyle}>
                        <BadgeCard n={1} icon={<ZoomIn size={18} />} title="表示・ズーム">
                            <ul style={listStyle}>
                                <li>ズームの拡大・縮小、スライダー、等倍に戻すボタン。</li>
                                <li>Alt キーを押しながらホイールでもズームできます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={2} icon={<MousePointer2 size={18} />} title="描画・消去・テキスト・範囲選択">
                            <ul style={listStyle}>
                                <li><b>ペン:</b> フリーハンドで描きます。</li>
                                <li><b>消しゴム:</b> ピクセル／線ごと／矩形／投げ縄の4種類。</li>
                                <li><b>テキスト:</b> クリックした位置に文字を入力します（サイズ・書体を選択可）。</li>
                                <li><b>選択:</b> クリック選択のほか、矩形・投げ縄で範囲選択できます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={3} icon={<Ruler size={18} />} title="計測・縮尺の設定">
                            <ul style={listStyle}>
                                <li><b>計測:</b> 距離（直線）／折れ線／面積の3種類。折れ線と面積はダブルクリックで確定します。</li>
                                <li><b>縮尺校正:</b> 長さの分かっている箇所をなぞり、実寸を入力します。</li>
                                <li><b>プリセット:</b> 1:1 〜 1:1000 から選べます。単位は mm / cm / m / km / in / ft。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={4} icon={<Layers size={18} />} title="複製・削除／色・太さ・透明度／レイヤー">
                            <ul style={listStyle}>
                                <li>選択した内容の複製・削除。Delete キーでも削除できます。</li>
                                <li>色は10色のパレットと自由な色指定。太さ・透明度・筆圧のオン／オフ。</li>
                                <li>レイヤーの追加・表示切替・削除ができます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={5} icon={<Download size={18} />} title="PDFとして保存">
                            <ul style={listStyle}>
                                <li>加筆した内容を含めてPDFとしてダウンロードします。</li>
                            </ul>
                        </BadgeCard>
                    </div>

                    <div style={{ ...cardStyle, borderLeft: '6px solid #b0b0b0', marginTop: '20px' }}>
                        <h4 style={cardHeadStyle}><Settings size={18} /> 知っておくこと</h4>
                        <ul style={listStyle}>
                            <li>
                                <b>保存されるPDFは、各ページを画像として書き出したものです。</b>
                                元のPDFが持っていた文字情報やベクターの線は、保存後のファイルには残りません。
                                元のPDFは変更されないため、原本は別途保管してください。
                            </li>
                            <li>四角・円・矢印などの図形を描くツールはありません。ペン・テキスト・計測が対象です。</li>
                            <li>レイヤーは追加・表示切替・削除のみです（名前の変更・並べ替え・レイヤーごとの透明度はありません）。</li>
                            <li>計測の線は青色・固定の太さで描かれ、パレットの色や太さの設定は反映されません。</li>
                        </ul>
                    </div>
                </ToolSection>

                {/* 2. COMPARATOR */}
                <ToolSection
                    id="comparator"
                    number={2}
                    accent="#e24a4a"
                    icon={<Blend size={22} />}
                    titleJa="PDF比較"
                    titleEn="Comparator"
                    summary="最大4つのPDFを重ねて変更箇所を確認"
                    version={TOOL_VERSIONS.comparator.version}
                    open={openId === 'comparator'}
                    onToggle={toggle}
                >
                    <p style={{ marginTop: 0 }}>
                        複数のPDFを色分けして重ね合わせ、どこが変わったかを目で確認するツールです。
                        一致している部分と変わっている部分を色で見分けられます。
                    </p>

                    <ScreenWithBadges screenshot="comparator" />

                    <div style={gridStyle}>
                        <BadgeCard n={1} icon={<UploadCloud size={18} />} title="PDFの読み込みと表示切替">
                            <ul style={listStyle}>
                                <li>最大4つまで読み込めます。<b>Blue (Base)</b> ／ <b>Red</b> ／ <b>Green</b> ／ <b>Yellow</b> の色が割り当てられます。</li>
                                <li>各枠の目のアイコンで、そのPDFの表示・非表示を切り替えられます。</li>
                                <li>比較には表示中のPDFが2つ以上必要です。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={2} icon={<Eye size={18} />} title="一致箇所の色と透明度">
                            <ul style={listStyle}>
                                <li>すべてのPDFで一致している部分の色と、その透明度を変更できます。</li>
                                <li>一致箇所を薄くすると、変更箇所が見つけやすくなります。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={3} icon={<FileText size={18} />} title="変更箇所抽出レポート">
                            <ul style={listStyle}>
                                <li>変更が見つかったページだけを切り出したPDFを作成します。</li>
                                <li>表示中のPDFが2つ以上必要です。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={4} icon={<ZoomIn size={18} />} title="ページ移動・ズーム・差分しきい値">
                            <ul style={listStyle}>
                                <li>ページの前後移動、ズーム（スライダー／Fit／1:1、Ctrl+ホイール）。</li>
                                <li><b>Diff Threshold:</b> 0〜5px。わずかなずれを変更として扱わないための設定です。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={5} icon={<Download size={18} />} title="書き出し設定と実行">
                            <ul style={listStyle}>
                                <li><b>対象ページ:</b> すべて／現在のページ／範囲指定（例: 1-3, 5）。</li>
                                <li><b>画質:</b> 72 / 150 / 300 / 450 DPI から選べます。</li>
                            </ul>
                        </BadgeCard>
                    </div>

                    <p style={calloutStyle}>
                        比較結果は画像として重ね合わせたものです。文字を検索できるPDFにはなりません。
                        高いDPIを選ぶほど書き出しに時間がかかります。
                    </p>
                </ToolSection>

                {/* 3. PROCESSOR */}
                <ToolSection
                    id="processor"
                    number={3}
                    accent="#7b4ae2"
                    icon={<Settings size={22} />}
                    titleJa="PDF加工"
                    titleEn="Processor"
                    summary="図面サイズ統一・図枠更新など7種類の加工"
                    version={TOOL_VERSIONS.tools.version}
                    open={openId === 'processor'}
                    onToggle={toggle}
                >
                    <p style={{ marginTop: 0 }}>
                        複数のPDFへ同じ加工をまとめて行うツールです。7種類の加工から1つを選んで実行します。
                    </p>

                    <ScreenWithBadges screenshot="processor" />

                    <div style={gridStyle}>
                        <BadgeCard n={1} icon={<Settings size={18} />} title="7種類の加工メニュー">
                            <ul style={listStyle}>
                                <li><b>半透明レイヤ追加</b> — 全ページへ半透明の色を重ねます。</li>
                                <li><b>モノクロ化</b> — グレースケールにします。</li>
                                <li><b>両方実行</b> — モノクロ化のあとに半透明レイヤを重ねます。</li>
                                <li><b>余白生成</b> — 指定した向きへ余白を追加します。</li>
                                <li><b>図面サイズ統一</b> — 用紙サイズをそろえます。</li>
                                <li><b>図枠一括更新</b> — 図枠の文字を全ページへ反映します。</li>
                                <li><b>最適化</b> — 圧縮解像度（DPI）を指定して軽くします。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={2} icon={<UploadCloud size={18} />} title="PDFの読み込み">
                            <ul style={listStyle}>
                                <li>ドラッグ&amp;ドロップ、またはクリックして選択します。複数まとめて追加できます。</li>
                                <li>1ファイルならPDFがそのまま、複数ならZIPでダウンロードされます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={3} icon={<Settings size={18} />} title="選んだ加工の設定">
                            <ul style={listStyle}>
                                <li>選んだ加工に応じて、色・不透明度・用紙サイズなどの設定が表示されます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={4} icon={<Play size={18} />} title="実行開始">
                            <ul style={listStyle}>
                                <li>「実行開始」で処理します。ファイルごとに進捗と結果が表示されます。</li>
                            </ul>
                        </BadgeCard>
                    </div>

                    <div style={gridStyle}>
                        <div style={{ ...cardStyle, borderLeft: '6px solid #7b4ae2' }}>
                            <h4 style={cardHeadStyle}><Ruler size={18} /> 図面サイズ統一</h4>
                            <ul style={listStyle}>
                                <li>A0 / A1 / A2 / A3 / A4 のいずれか、または「最初のページに合わせる」を選べます（初期値は A1）。</li>
                                <li>縦横比が違う場合は、内容が切れないように中央に配置します。切り取りは行いません。</li>
                                <li>線や文字はベクターのまま、検索できる文字情報も保持したまま処理します。</li>
                            </ul>
                            <p style={noteStyle}>
                                表示範囲の外に隠れていた注釈が新しい用紙で見えてしまう可能性がある場合は、
                                安全のため処理を中止します。
                            </p>
                        </div>

                        <div style={{ ...cardStyle, borderLeft: '6px solid #7b4ae2' }}>
                            <h4 style={cardHeadStyle}><Stamp size={18} /> 図枠一括更新</h4>
                            <ul style={listStyle}>
                                <li>代表ページで更新したい場所をドラッグして選び、最大3か所まで設定できます。</li>
                                <li>入力した文字を全ページの同じ位置へ反映します。</li>
                                <li>用紙に対する相対位置で反映するため、A1とA3が混在していても同じ位置に入ります。</li>
                                <li>実行前にプレビューで位置と文字を確認してください。</li>
                            </ul>
                            <p style={{ ...calloutStyle, background: '#fdecea', borderColor: '#f5c6cb', color: '#8a2b22', marginTop: '10px' }}>
                                <b>墨消し（redaction）ではありません。</b>
                                新しい文字で表示を上書きするだけで、元の文字はPDFの内部に残る可能性があります。
                                機密情報を消す目的では使用しないでください。
                            </p>
                        </div>
                    </div>
                </ToolSection>

                {/* 4. EXTRACT & MERGE */}
                <ToolSection
                    id="split-merge"
                    number={4}
                    accent="#2aa198"
                    icon={<Combine size={22} />}
                    titleJa="PDF抽出・統合"
                    titleEn="Extract / Merge"
                    summary="ページの抜き出しと複数PDFの結合"
                    version={TOOL_VERSIONS.splitMerge.version}
                    open={openId === 'split-merge'}
                    onToggle={toggle}
                >
                    <p style={{ marginTop: 0 }}>
                        1つのPDFから必要なページだけを抜き出す「PDF抽出」と、複数のPDFを1つにまとめる「PDF統合」があります。
                        <b>画面上部のタブで切り替えて使います。抽出と統合が同時に表示されることはありません。</b>
                    </p>

                    <h4 style={subHeadStyle}>PDF抽出 (Extract)</h4>
                    <ScreenWithBadges screenshot="split_extract" />

                    <div style={gridStyle}>
                        <BadgeCard n={1} icon={<Scissors size={18} />} title="抽出／統合の切替タブ">
                            <ul style={listStyle}>
                                <li>「PDF抽出 (Extract)」と「PDF統合 (Merge)」をここで切り替えます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={2} icon={<UploadCloud size={18} />} title="PDFの読み込みと表示サイズ">
                            <ul style={listStyle}>
                                <li>PDFを1つ読み込むと、全ページがサムネイルで並びます。</li>
                                <li>「表示サイズ」でサムネイルの大きさを変えられます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={3} icon={<FileText size={18} />} title="ページを選択">
                            <ul style={listStyle}>
                                <li>サムネイルをクリックすると選択され、青い枠が付きます。もう一度クリックで解除します。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={4} icon={<Download size={18} />} title="選択したページを書き出し">
                            <ul style={listStyle}>
                                <li>1ページ以上選ぶとボタンが表示されます。</li>
                                <li>書き出されるページは、選んだ順ではなく元のページ順に並びます。</li>
                            </ul>
                        </BadgeCard>
                    </div>

                    <h4 style={{ ...subHeadStyle, marginTop: '24px' }}>PDF統合 (Merge)</h4>
                    <ScreenWithBadges screenshot="split_merge" />

                    <div style={gridStyle}>
                        <BadgeCard n={1} icon={<Scissors size={18} />} title="抽出／統合の切替タブ">
                            <ul style={listStyle}>
                                <li>「PDF統合 (Merge)」を選ぶと、結合の画面に切り替わります。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={2} icon={<UploadCloud size={18} />} title="PDFを追加">
                            <ul style={listStyle}>
                                <li>複数のPDFをまとめて追加できます。追加するたびにリストへ積み上がります。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={3} icon={<ArrowUp size={18} />} title="順序の入れ替えと削除">
                            <ul style={listStyle}>
                                <li>各行の <ArrowUp size={12} /> <ArrowDown size={12} /> で順番を入れ替えます。</li>
                                <li>×ボタンでリストから外します。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={4} icon={<Download size={18} />} title="統合PDFを書き出し">
                            <ul style={listStyle}>
                                <li>リストの順番どおりに、全ページを1つのPDFへ結合します。</li>
                            </ul>
                        </BadgeCard>
                    </div>
                </ToolSection>

                {/* 5. TEXTIFIER */}
                <ToolSection
                    id="textifier"
                    number={5}
                    accent="#9e4ae2"
                    icon={<ScanText size={22} />}
                    titleJa="PDFテキスト化"
                    titleEn="Textifier"
                    summary="OCR・TXT・Wordへの文字情報変換"
                    version={TOOL_VERSIONS.textifier.version}
                    open={openId === 'textifier'}
                    onToggle={toggle}
                >
                    <p style={{ marginTop: 0 }}>
                        PDFの文字を取り出すツールです。日本語と英語に対応し、2つのモードがあります。
                    </p>
                    <ul style={{ ...listStyle, marginBottom: '16px' }}>
                        <li>
                            <b>OCR</b> — スキャンして画像になったPDFを文字認識し、
                            <b>文字を検索・選択できるPDF</b>を作ります。見た目は元のPDFのまま変わりません。
                        </li>
                        <li>
                            <b>Text Extraction</b> — PDFの文字を<b>TXTファイル</b>または
                            <b>編集可能なWord（.docx）</b>として書き出します。
                            文字情報を持つページはその文字をそのまま取り出し、スキャンページはOCRを行います。
                            元のPDFのページ順は維持されます。
                        </li>
                    </ul>

                    <ScreenWithBadges screenshot="textifier" />

                    <div style={gridStyle}>
                        <BadgeCard n={1} icon={<UploadCloud size={18} />} title="PDFの読み込みとプレビュー">
                            <ul style={listStyle}>
                                <li>1回につき1ファイルを処理します。1ページ目がプレビュー表示されます。</li>
                            </ul>
                        </BadgeCard>

                        <BadgeCard n={2} icon={<Settings size={18} />} title="OCR前処理・モード・出力形式">
                            <ul style={listStyle}>
                                <li><b>OCR</b> → 出力形式は <b>PDF (Searchable)</b>。</li>
                                <li><b>Text Extraction</b> → <b>Text (.txt)</b> または <b>Word (.docx)</b>。</li>
                                <li><b>OCR前処理</b>（傾き補正・ノイズ除去）は初期状態はオフです。</li>
                                <li>すでに文字情報を持つページには文字認識を行いません。</li>
                            </ul>
                            <p style={noteStyle}>
                                モードや前処理を切り替えると、前の設定で作った結果は破棄されます。
                                切り替えたあとにもう一度実行してください。
                            </p>
                        </BadgeCard>

                        <BadgeCard n={3} icon={<Play size={18} />} title="実行開始">
                            <ul style={listStyle}>
                                <li>進捗がページ単位で表示され、途中でキャンセルできます（現在のページの認識完了後に反映）。</li>
                                <li>キャンセルした場合、途中までのファイルは保存されません。</li>
                                <li>完了後に「Download Result」から保存します（<b>_searchable.pdf</b> ／ <b>_extracted.txt</b> ／ <b>_extracted.docx</b>）。</li>
                            </ul>
                        </BadgeCard>
                    </div>

                    <div style={gridStyle}>
                        <div style={{ ...cardStyle, borderLeft: '6px solid #9e4ae2' }}>
                            <h4 style={cardHeadStyle}><ScanText size={18} /> TXT書き出しについて</h4>
                            <ul style={listStyle}>
                                <li>TXTにはページの区切り（<code>===== Page 1 =====</code>）が入り、ページ順は元のPDFのままです。</li>
                                <li>文字のないページも、ページの見出しだけは残ります。</li>
                                <li>段組みや表が複雑なページでは、文字の順序が見た目どおりにならない場合があります。</li>
                                <li>表をExcelの表として復元する機能ではありません。</li>
                                <li>スキャンページの文字の正確さは、元の画像の品質によって変わります。</li>
                            </ul>
                        </div>

                        <div style={{ ...cardStyle, borderLeft: '6px solid #2b579a' }}>
                            <h4 style={cardHeadStyle}><FileText size={18} /> Word（.docx）書き出しについて</h4>
                            <ul style={listStyle}>
                                <li>元のPDFのページ順を保ち、ページの区切りをWordの改ページとして入れます。文字のないページも区切りを残します。</li>
                                <li><b>PDFの見た目をWordへ再現する機能ではありません。</b></li>
                                <li>表の構造は復元しません。</li>
                                <li>画像・図形・線はWordへ移しません。文字だけを書き出します。</li>
                                <li>フォント・文字サイズ・太字などの体裁は再現しません。</li>
                                <li>Word側での実際のページ数は、お使いの環境やフォントによって変わることがあります。</li>
                            </ul>
                        </div>

                        <div style={{ ...cardStyle, borderLeft: '6px solid #4a90e2' }}>
                            <h4 style={cardHeadStyle}><Settings size={18} /> OCR前処理について</h4>
                            <ul style={listStyle}>
                                <li>補正するのは<b>文字認識用の画像だけ</b>です。元のPDFの見た目・線・文字情報は変更しません。</li>
                                <li>効果は元のスキャン画像の品質によって変わります。</li>
                                <li>傾きがほとんどないページや、判断できるだけの文字がないページでは、補正を行わないことがあります。</li>
                                <li>ノイズ除去は、紙の上に単独で載っている点だけを取り除きます。</li>
                                <li>ページサイズが非常に大きい場合は、前処理を行わずに文字認識します。その場合は画面にお知らせが出ます。</li>
                            </ul>
                        </div>

                        <div style={{ ...cardStyle, borderLeft: '6px solid #b0b0b0' }}>
                            <h4 style={cardHeadStyle}><Settings size={18} /> 未対応の機能（今後対応予定）</h4>
                            <ul style={listStyle}>
                                <li><b>Excel (.xlsx) 出力</b> — 未対応（Coming later）</li>
                            </ul>
                            <p style={noteStyle}>
                                現在ご利用いただける出力は「PDF (Searchable)」「Text (.txt)」「Word (.docx)」です。
                            </p>
                        </div>
                    </div>

                    <p style={calloutStyle}>
                        <b>データの取り扱い:</b> 文字認識・OCR前処理・TXT／Wordの書き出しは、
                        いずれもお使いのブラウザ内で実行されます。
                        PDFを外部のAI・OCRサービスへ送信することはありません。
                    </p>
                </ToolSection>
            </div>

            {/* RELEASE HISTORY */}
            <section id="release-history" style={{ margin: '48px 0 60px', scrollMarginTop: '20px' }}>
                <h3 style={{ borderBottom: '2px solid #bbb', paddingBottom: '10px', color: '#ddd', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <History size={24} /> 更新履歴
                </h3>
                <p style={{ marginBottom: '20px', color: '#ccc' }}>
                    ユーザーの皆さまから見て何ができるようになったかを、新しい順に記載しています。
                </p>

                <div style={gridStyle}>
                    {/* A tool can ship twice on one day, so the version belongs in the key. */}
                    {releaseHistory.map((release) => (
                        <div key={`${release.date}-${release.tool}-${release.version}`} style={cardStyle}>
                            <h4 style={cardHeadStyle}>
                                <span style={{ color: '#333' }}>{release.date}</span>
                                <span style={{ color: '#666', fontWeight: 'normal' }}>／ {release.tool}</span>
                                <span style={{ marginLeft: 'auto' }}><VersionBadge version={release.version} /></span>
                            </h4>
                            <ul style={listStyle}>
                                {release.changes.map((change) => (
                                    <li key={change}>{change}</li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}

/**
 * One collapsible tool.
 *
 * The header is a real button, so Enter and Space work, focus is visible and
 * the expanded state is announced without any of it being re-implemented. The
 * body is only mounted while open, which keeps a screenful of screenshots out
 * of the first paint and out of reach of anyone reading a collapsed section.
 */
function ToolSection({
    id, number, accent, icon, titleJa, titleEn, summary, version, open, onToggle, children,
}: {
    id: ToolId;
    number: number;
    accent: string;
    icon: React.ReactNode;
    titleJa: string;
    titleEn: string;
    summary: string;
    version: string;
    open: boolean;
    onToggle: (id: ToolId) => void;
    children: React.ReactNode;
}) {
    return (
        <section
            id={`usage-section-${id}`}
            style={{ scrollMarginTop: '16px', ['--usage-accent' as string]: accent }}
        >
            <h3 style={{ margin: 0 }}>
                <button
                    type="button"
                    className="usage-header"
                    id={`usage-header-${id}`}
                    aria-expanded={open}
                    aria-controls={`usage-panel-${id}`}
                    onClick={() => onToggle(id)}
                    data-usage-tool={id}
                >
                    <span className="usage-header-icon">{icon}</span>
                    <span className="usage-header-text">
                        <span className="usage-header-title">
                            {number}. {titleJa}
                            <span className="usage-header-en">{titleEn}</span>
                        </span>
                        <span className="usage-header-summary">{summary}</span>
                    </span>
                    <VersionBadge version={version} />
                    <ChevronDown size={20} className="usage-header-chevron" aria-hidden="true" />
                </button>
            </h3>
            <div
                className="usage-panel"
                id={`usage-panel-${id}`}
                role="region"
                aria-labelledby={`usage-header-${id}`}
                hidden={!open}
            >
                {open ? children : null}
            </div>
        </section>
    );
}

function BadgeCard({ n, icon, title, children }: {
    n: number; icon: React.ReactNode; title: string; children: React.ReactNode;
}) {
    return (
        <div style={cardStyle}>
            <h4 style={cardHeadStyle}>
                <span style={{
                    background: 'red', color: '#fff', borderRadius: '50%',
                    width: '22px', height: '22px', display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', flexShrink: 0,
                }}>{n}</span>
                {icon} {title}
            </h4>
            {children}
        </div>
    );
}

interface MeasuredRect { left: number; top: number; width: number; height: number }
interface MeasuredScreen {
    frame: { width: number; height: number };
    screenshot: { file: string; width: number; height: number; sha256: string };
    targets: Record<string, MeasuredRect | null>;
}

const GEOMETRY = measuredGeometry as unknown as Record<string, MeasuredScreen>;

/**
 * A screenshot with its numbered boxes.
 *
 * Positions come from usage-screenshot-geometry.json, which is measured from
 * the running app rather than typed by hand -- that is what stops the boxes
 * drifting away from the controls every time a screen is recaptured. A badge
 * covering several controls is drawn as the union of them.
 */
function ScreenWithBadges({ screenshot }: { screenshot: string }) {
    const config = USAGE_SCREENSHOTS[screenshot];
    const measured = GEOMETRY[screenshot];
    if (!config || !measured) return null;

    const boxes = config.badges.map((badge) => {
        const rects = badge.targets.map((t) => measured.targets[t]);
        // All of a badge's targets or none of them. A box drawn from whichever
        // half happened to be measured would point somewhere nobody chose, and
        // would look exactly as authoritative as a correct one. The gate keeps
        // this from happening; this keeps it from being drawn if it ever does.
        if (rects.some((r) => !r)) return null;
        const left = Math.min(...(rects as MeasuredRect[]).map((r) => r.left));
        const top = Math.min(...(rects as MeasuredRect[]).map((r) => r.top));
        const right = Math.max(...(rects as MeasuredRect[]).map((r) => r.left + r.width));
        const bottom = Math.max(...(rects as MeasuredRect[]).map((r) => r.top + r.height));
        return { left, top, width: right - left, height: bottom - top, desc: badge.desc };
    });

    return (
        <div className="usage-screen" data-usage-screenshot={screenshot}>
            <img src={config.src} alt={`${screenshot} の画面`} loading="lazy" />
            {boxes.map((box, i) => box && (
                <React.Fragment key={i}>
                    <div
                        className="usage-screen-box"
                        data-usage-box={i + 1}
                        style={{
                            left: `${box.left}%`, top: `${box.top}%`,
                            width: `${box.width}%`, height: `${box.height}%`,
                        }}
                    />
                    <div
                        className="usage-screen-number"
                        data-usage-number={i + 1}
                        // Clamped inside the frame: a marker hanging off the top
                        // left corner of a control at the edge would be cut off.
                        style={{
                            left: `max(2px, calc(${box.left}% - 13px))`,
                            top: `max(2px, calc(${box.top}% - 13px))`,
                        }}
                        title={box.desc}
                    >
                        {i + 1}
                    </div>
                </React.Fragment>
            ))}
        </div>
    );
}

const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '20px',
    marginTop: '20px',
};

const cardStyle: React.CSSProperties = {
    background: 'white',
    padding: '16px',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    border: '1px solid #eee',
};

const cardHeadStyle: React.CSSProperties = {
    marginTop: 0,
    marginBottom: '10px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    color: '#333',
    fontSize: '0.95rem',
};

const subHeadStyle: React.CSSProperties = {
    margin: '0 0 8px',
    fontSize: '1rem',
    color: '#333',
};

const listStyle: React.CSSProperties = {
    paddingLeft: '20px',
    margin: 0,
    fontSize: '0.9em',
    color: '#555',
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
};

const noteStyle: React.CSSProperties = {
    fontSize: '0.85em',
    color: '#777',
    margin: '8px 0 0',
};

const calloutStyle: React.CSSProperties = {
    fontSize: '0.9em',
    color: '#555',
    background: '#fff8e1',
    border: '1px solid #ffe0a3',
    borderRadius: '6px',
    padding: '10px 12px',
    marginTop: '16px',
};
