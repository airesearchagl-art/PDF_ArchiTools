import React from 'react';
import { PenTool, Layers, Ruler, ZoomIn, Download, Sliders, Blend, FileText, UploadCloud, Eye, Combine, ArrowUp, ArrowDown, ScanText, Settings, BoxSelect, History, Play, Stamp } from 'lucide-react';
import { TOOL_VERSIONS } from '../config/versions';

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
        marginLeft: 'auto',
        fontSize: '0.8rem',
        backgroundColor: '#f0f0f0',
        color: '#666',
        padding: '2px 8px',
        borderRadius: '12px',
        border: '1px solid #ddd',
        display: 'flex',
        alignItems: 'center',
        gap: '4px'
    }}>
        v{version}
    </span>
);

export function HowToUse() {
    // Responsive grid style
    const gridStyle: React.CSSProperties = {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: '20px',
        marginTop: '20px'
    };

    return (
        <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto', overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
            <div style={{ textAlign: 'center', marginBottom: '40px', padding: '0 20px' }}>
                <h2 style={{ fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', marginBottom: '10px', color: '#fff' }}>建築設計お役立ちPDFツール集へようこそ</h2>
                <p style={{ color: '#ccc', fontSize: '1.1rem' }}>
                    設計業務の効率化を目指して開発された、5つの主要なPDFツール機能の使い方ガイドです。
                </p>
                <p style={{ color: '#ccc', fontSize: '1rem', margin: '10px 0 0' }}>
                    <b>PDF加筆</b> ／ <b>PDF比較</b> ／ <b>PDF加工</b> ／ <b>PDF抽出・統合</b> ／ <b>PDFテキスト化</b> の5カテゴリがあります。
                    画面上部のタブから切り替えてご利用ください。
                </p>
                <p style={{ margin: '16px 0 0', fontSize: '0.9em', color: '#ffecb3', lineHeight: 1.7 }}>
                    ※ 読み込んだPDFファイルは、お使いのブラウザ内で処理されます。
                    文字認識（OCR）もブラウザ内で実行され、PDFを外部のAI・OCRサービスへ送信することはありません。
                </p>
                <p style={{ margin: '16px 0 0', fontSize: '0.95em', color: '#9fd3ff' }}>
                    <History size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '6px' }} />
                    最近の更新: <b>Word（.docx）書き出し</b>（PDFテキスト化 v1.5.0） / <b>OCR前処理（傾き補正・ノイズ除去）</b>（PDFテキスト化 v1.4.0） / <b>TXT書き出し</b>（PDFテキスト化 v1.3.0）
                    — 詳しくはページ下部の<a href="#release-history" style={{ color: '#9fd3ff' }}>更新履歴</a>をご覧ください。
                </p>
            </div>

            {/* 1. ANNOTATOR */}
            <section style={{ marginBottom: '60px' }}>
                <h3 style={{ borderBottom: '2px solid #4a90e2', paddingBottom: '10px', color: '#4a90e2', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <PenTool size={24} /> 1. PDF加筆 (Annotator)
                    <VersionBadge version={TOOL_VERSIONS.annotator.version} />
                </h3>
                <p style={{ marginBottom: '20px' }}>
                    PDF図面に手書き感覚で加筆修正を行えるツールです。タブレットやペン入力に最適化されています。
                </p>

                <ScreenWithBadges
                    src="/screenshots/annotator.png?v=4"
                    badges={[
                        // 1. View & Edit Actions
                        {
                            top: '0', left: '0', desc: '基本操作（表示・編集）', rects: [
                                { top: '4%', left: '0.5%', width: '10%', height: '9%' }, // Zoom/View
                                { top: '4%', left: '63%', width: '5%', height: '9%' }    // Copy/Trash
                            ]
                        },
                        // 2. Drawing Tools & Settings
                        {
                            top: '0', left: '0', desc: '描画・注釈ツール', rects: [
                                { top: '4%', left: '11%', width: '21%', height: '9%' },  // Pen, Text, Shapes
                                { top: '4%', left: '69%', width: '16%', height: '9%' }   // Colors, Sliders
                            ]
                        },
                        // 3. Measure
                        { top: '4%', left: '33%', width: '29%', height: '9%', desc: '計測・キャリブレーション' },
                        // 4. Layers
                        { top: '4%', left: '86%', width: '9%', height: '9%', desc: 'レイヤー管理' },
                        // 5. Download
                        { top: '4%', left: '95.5%', width: '4%', height: '9%', desc: 'PDF保存' }
                    ]}
                />

                <div style={gridStyle}>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>①</strong> <ZoomIn size={18} /> 基本操作（表示・編集）</h4>
                        <p>表示の調整や、選択したオブジェクトの操作を行います。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>左側:</b> ズーム、パン、全体表示などの画面操作。</li>
                            <li><b>中央右:</b> 選択した注釈のコピーや削除（ゴミ箱）を行います。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>②</strong> <PenTool size={18} /> 描画・注釈ツール</h4>
                        <p>ペンや図形などのツール選択と、詳細設定を行います。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>左側:</b> ペン、消しゴム、テキスト、図形ツールを選択します。</li>
                            <li><b>右側:</b> 色、太さ、透明度などを調整します。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>③</strong> <Ruler size={18} /> 計測・キャリブレーション</h4>
                        <p>図面の縮尺合わせや距離計測を行います。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>計測:</b> 定規アイコンでモード切り替え、プリセットで縮尺を設定します。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>④</strong> <Layers size={18} /> レイヤー・<Download size={18} /> 保存</h4>
                        <p>レイヤー管理とファイルの保存を行います。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>④ レイヤー:</b> レイヤーの追加・表示切替を行います。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>⑤</strong> <Download size={18} /> PDF保存</h4>
                        <p>作業内容を保存します。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>⑤ 保存:</b> 編集した内容をPDFとしてダウンロードします。</li>
                        </ul>
                    </div>
                </div>
            </section>


            {/* 2. COMPARATOR */}
            <section style={{ marginBottom: '60px' }}>
                <h3 style={{ borderBottom: '2px solid #e24a4a', paddingBottom: '10px', color: '#e24a4a', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Eye size={24} /> 2. PDF比較 (Comparator)
                    <VersionBadge version={TOOL_VERSIONS.comparator.version} />
                </h3>
                <p style={{ marginBottom: '20px' }}>
                    修正前後の図面など、最大4つのPDFファイルを重ね合わせて差分を視覚的に確認できます。
                    ファイルは <b>赤・青・緑・黄</b> の4色に色分けされて表示されます。
                </p>

                <ScreenWithBadges
                    src="/screenshots/comparator.png"
                    badges={[
                        // 1. File Slots (Top Left)
                        { top: '11%', left: '0.5%', width: '85%', height: '13%', desc: 'ファイルスロット(赤/青/緑/黄)' },
                        // 2. Diff Area (Center)
                        { top: '48%', left: '25%', width: '50%', height: '50%', desc: '比較プレビューエリア' },
                        // 3. Toolbar (Middle Row)
                        { top: '28%', left: '0.5%', width: '75%', height: '9%', desc: '表示操作・エクスポート' }
                    ]}
                />

                <div style={gridStyle}>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>①</strong> <UploadCloud size={18} /> ファイル読み込み</h4>
                        <p>画面上部の4つのスロットにPDFファイルをドラッグ&ドロップして読み込みます。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li>左から順に優先して表示されます。読み込んだファイル名が表示されます。</li>
                            <li><Eye size={12} /> アイコンで一時的にそのレイヤー（色）を非表示にできます。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>②</strong> <Blend size={18} /> 差分確認エリア</h4>
                        <p>中央のキャンバスに全てのPDFが乗算合成され表示されます。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li>一致する部分は黒（または混色）になり、差分がある部分は各ファイルの色（赤や青）で浮き上がって見えます。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>③</strong> <Sliders size={18} /> 表示調整・出力</h4>
                        <p>右上のコントロールバーで表示を調整します。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>Diff Threshold:</b> 微妙な位置ズレやスキャンノイズを無視するため、差分判定の閾値を調整できます。</li>
                            <li><b>Export PDF:</b> <Settings size={14} style={{ display: 'inline', verticalAlign: 'middle' }} /> アイコンから<b>書き出し設定</b>（ページ範囲・解像度）を変更し、結果をPDFとして保存します。
                                <ul style={{ marginTop: '5px', color: '#666' }}>
                                    <li><b>Pages:</b> "All" (全ページ), "Current" (表示中のみ), "Range" (例: 1-3, 5) から選択可能。</li>
                                    <li><b>Quality:</b> 72 DPI (軽量) 〜 1200 DPI (最高画質) まで選択可能。</li>
                                </ul>
                            </li>
                        </ul>
                    </div>
                </div>
            </section>


            {/* 3. PROCESSOR */}
            <section style={{ marginBottom: '60px' }}>
                <h3 style={{ borderBottom: '2px solid #4ae290', paddingBottom: '10px', color: '#4ae290', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <FileText size={24} /> 3. PDF加工 (Processor)
                    <VersionBadge version={TOOL_VERSIONS.tools.version} />
                </h3>
                <p style={{ marginBottom: '20px' }}>
                    複数のPDFをまとめて加工できるツールです。左のサイドバーから
                    <b>半透明レイヤ追加</b> / <b>モノクロ化</b> / <b>両方実行</b> / <b>余白生成</b> /
                    <b>図面サイズ統一</b> / <b>図枠一括更新</b> / <b>最適化</b> の7つの機能を選べます。
                    ファイルを1つだけ入れた場合は加工後のPDFがそのまま、複数入れた場合はZIPでまとめてダウンロードされます。
                </p>

                <ScreenWithBadges
                    src="/screenshots/processor.png"
                    badges={[
                        // 1. Function Select (Left Sidebar) - now seven entries
                        { top: '9%', left: '1.2%', width: '13.2%', height: '51%', desc: '加工機能の選択' },
                        // 2. Work Area (Centre). Shown here with 図枠一括更新 active,
                        //    so it carries the representative page and the rule list.
                        { top: '6.5%', left: '18%', width: '56.2%', height: '69%', desc: 'ファイル追加・作業エリア' },
                        // 3. Settings Panel (Right)
                        { top: '12%', left: '78.2%', width: '20%', height: '75%', desc: '詳細設定' },
                        // 4. Run Button (Right Bottom)
                        { top: '90.5%', left: '78.2%', width: '20%', height: '6%', desc: '実行開始ボタン' }
                    ]}
                />

                <div style={gridStyle}>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>①</strong> 機能選択</h4>
                        <p>左のサイドバーから、実行したい加工を1つ選びます。</p>
                        <ul style={listStyle}>
                            <li><b>半透明レイヤ追加:</b> 図面の上に色付きの半透明レイヤを重ねます。</li>
                            <li><b>モノクロ化:</b> 白黒に変換し、コントラストを調整します。</li>
                            <li><b>両方実行:</b> モノクロ化のあとに半透明レイヤ追加を続けて行います。</li>
                            <li><b>余白生成:</b> 内容を縮小して、まわりに余白をつくります。</li>
                            <li><b>図面サイズ統一:</b> 用紙サイズをそろえます（下に詳しい説明があります）。</li>
                            <li><b>図枠一括更新:</b> 図枠の文字を全ページへ一括反映します（下に詳しい説明があります）。</li>
                            <li><b>最適化:</b> 解像度を下げてファイルサイズを小さくします。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>②</strong> ファイル追加・作業エリア</h4>
                        <p>処理したいPDFファイルを中央のエリアに追加します（ドラッグ&ドロップ可）。複数まとめて追加できます。</p>
                        <p style={noteStyle}>
                            「図枠一括更新」を選んでいるときは、この場所に代表ページのプレビューと更新領域の一覧が表示されます
                            （上の画面例）。
                        </p>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>③</strong> 詳細設定</h4>
                        <p>選んだ機能に応じて、右側の設定パネルの内容が切り替わります。</p>
                        <ul style={listStyle}>
                            <li><b>半透明レイヤ追加:</b> 色と不透明度を設定。</li>
                            <li><b>モノクロ化:</b> コントラストと解像度を調整。</li>
                            <li><b>余白生成:</b> 縮小率と配置を指定。</li>
                            <li><b>図面サイズ統一:</b> ターゲット用紙を選択。</li>
                            <li><b>図枠一括更新:</b> 中央のプレビューで領域を選び、新しい文字を入力。</li>
                            <li><b>最適化:</b> 圧縮解像度（DPI）を選択。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>④</strong> <Play size={18} /> 処理実行</h4>
                        <p>「実行開始」ボタンを押すと、追加したすべてのファイルが処理されます。</p>
                        <ul style={listStyle}>
                            <li><b>1ファイル:</b> 加工後のPDFがそのままダウンロードされます。</li>
                            <li><b>複数ファイル:</b> まとめてZIPでダウンロードされます。</li>
                        </ul>
                    </div>
                </div>

                {/* 3-b. Drawing page size normalizer */}
                <div style={{ ...cardStyle, marginTop: '24px', borderLeft: '6px solid #4ae290' }}>
                    <h4 style={{ ...cardHeadStyle, fontSize: '1.15rem' }}>
                        <BoxSelect size={20} /> 図面サイズ統一
                        <VersionBadge version={TOOL_VERSIONS.tools.version} />
                    </h4>
                    <p>
                        A1とA3など<b>用紙サイズが混在したPDF</b>を、全ページ同じ用紙サイズにそろえます。
                        図面を画像に変換せずに処理するため、線や文字はベクターのまま残り、検索できる文字情報も失われません。
                    </p>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginTop: '12px' }}>
                        <div>
                            <h5 style={subHeadStyle}>選べるターゲット用紙</h5>
                            <ul style={listStyle}>
                                <li>A0 / A1 / A2 / A3 / A4</li>
                                <li>「最初のページに合わせる」</li>
                            </ul>
                            <p style={noteStyle}>初期設定はA1です。</p>
                        </div>
                        <div>
                            <h5 style={subHeadStyle}>処理の内容</h5>
                            <ul style={listStyle}>
                                <li>縦横比を保ったまま拡大・縮小</li>
                                <li>用紙の中央に配置</li>
                                <li>内容の切り取り（crop）はしない</li>
                                <li>ページごとの縦向き・横向きはそのまま</li>
                                <li>線や文字はベクターのまま保持</li>
                                <li>検索できる文字情報を保持</li>
                                <li>PDFテキスト化で付けた文字情報も保持</li>
                            </ul>
                        </div>
                        <div>
                            <h5 style={subHeadStyle}>基本の手順</h5>
                            <ol style={listStyle}>
                                <li>「PDF加工」を開く</li>
                                <li>「図面サイズ統一」を選ぶ</li>
                                <li>PDFを追加する</li>
                                <li>ターゲット用紙を選ぶ</li>
                                <li>「実行開始」を押す</li>
                                <li>できあがったPDFをダウンロード</li>
                            </ol>
                            <p style={noteStyle}>複数のPDFを入れた場合はZIPでまとめてダウンロードされます。</p>
                        </div>
                    </div>

                    <p style={calloutStyle}>
                        <b>ご注意:</b> 処理が終わると、元の用紙サイズの内訳（例: A1 × 2、A3 × 2）がファイル名の下に表示されます。
                        なお、特殊な注釈が用紙の表示範囲の外にあるPDFは、意図しない注釈の露出を防ぐため処理を中止する場合があります。
                    </p>
                </div>

                {/* 3-c. Title block batch updater */}
                <div style={{ ...cardStyle, marginTop: '24px', borderLeft: '6px solid #4ae290' }}>
                    <h4 style={{ ...cardHeadStyle, fontSize: '1.15rem' }}>
                        <Stamp size={20} /> 図枠一括更新
                        <VersionBadge version={TOOL_VERSIONS.tools.version} />
                    </h4>
                    <p>
                        図枠の中の文字を、<b>全ページまとめて書き換える</b>機能です。
                        「実施設計図」を「竣工図」に変える、日付や改訂記号を更新する、といった使い方を想定しています。
                        ページ全体を画像に変換せずに処理するため、図面の線や文字はそのまま残ります。
                    </p>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginTop: '12px' }}>
                        <div>
                            <h5 style={subHeadStyle}>基本の手順</h5>
                            <ol style={listStyle}>
                                <li>「PDF加工」を開く</li>
                                <li>「図枠一括更新」を選ぶ</li>
                                <li>PDFを追加する（代表ページが表示されます）</li>
                                <li>更新したい場所をドラッグして囲む</li>
                                <li>新しい文字を入力する</li>
                                <li>必要なら2か所目・3か所目を追加する</li>
                                <li>プレビューで位置と文字を確認する</li>
                                <li>「実行開始」を押してダウンロード</li>
                            </ol>
                        </div>
                        <div>
                            <h5 style={subHeadStyle}>できること</h5>
                            <ul style={listStyle}>
                                <li>更新領域は<b>最大3か所</b>まで</li>
                                <li>設定した内容を全ページへ一括反映</li>
                                <li>代表ページは前後のページに切り替え可能</li>
                                <li>用紙に対する相対位置で反映するので、A1とA3が混在していても同じ場所に入る</li>
                                <li>選んだ範囲だけ白く塗り、新しい文字を中央に配置</li>
                                <li>文字の大きさは枠内に収まるよう自動調整</li>
                                <li>複数ファイルへ同じ設定をまとめて適用（ZIPでダウンロード）</li>
                            </ul>
                        </div>
                        <div>
                            <h5 style={subHeadStyle}>うまくいかないとき</h5>
                            <ul style={listStyle}>
                                <li>代表ページと縦横方向が違うページがあると、位置がずれないよう処理を中止します</li>
                                <li>選んだ範囲に対して文字が長すぎる場合も中止します。範囲を広げるか文字を短くしてください</li>
                                <li>ページのサイズや枚数、並び順は変わりません</li>
                            </ul>
                        </div>
                    </div>

                    <p style={{ ...calloutStyle, background: '#fdecea', borderColor: '#f5b7b1' }}>
                        <b>重要 — 墨消し（redaction）には使えません:</b> この機能は図枠の
                        <b>表示を上書き</b>するものです。元の文字はPDFの内部に残るため、
                        文字の検索やコピーで見つかる場合があります。
                        機密情報を消す目的では使用しないでください。
                    </p>
                </div>
            </section>


            {/* 4. EXTRACT & MERGE */}
            <section style={{ marginBottom: '60px' }}>
                <h3 style={{ borderBottom: '2px solid #e2a84a', paddingBottom: '10px', color: '#e2a84a', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Blend size={24} /> 4. PDF抽出・統合 (Extract & Merge)
                    <VersionBadge version={TOOL_VERSIONS.splitMerge.version} />
                </h3>
                <p style={{ marginBottom: '20px' }}>
                    ページ単位の抜き出し（抽出）と、複数ファイルの結合（統合）を行うツールです。
                </p>

                <ScreenWithBadges
                    src="/screenshots/split_extract.png"
                    badges={[
                        // 1. Tabs (Top)
                        { top: '10%', left: '1%', width: '30%', height: '8%', desc: 'モード切替タブ' },
                        // 2. Extract Mode (Left)
                        { top: '20%', left: '1%', width: '48%', height: '70%', desc: 'PDF抽出 (Extract)' },
                        // 3. Merge Mode (Right)
                        { top: '20%', left: '51%', width: '48%', height: '70%', desc: 'PDF統合 (Merge)' }
                    ]}
                />

                <div style={gridStyle}>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>①</strong> モード切替</h4>
                        <p>左上のタブで「PDF抽出 (Extract)」と「PDF統合 (Merge)」を切り替えます。</p>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>②</strong> PDF抽出 (Extract)</h4>
                        <p>1つのPDFから特定のページだけを抜き出します。</p>
                        <ol style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li>PDFをアップロードすると、全ページが <strong style={{ color: 'red' }}>③</strong> サムネイルで一覧表示されます。</li>
                            <li>必要なページをクリックして選択（青枠表示）。</li>
                            <li>「選択したページを書き出し」ボタンで保存します。</li>
                        </ol>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>③</strong> <Combine size={18} /> PDF統合 (Merge)</h4>
                        <p>「PDF統合」タブでは、複数のPDFを1つにまとめられます。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li>複数のファイルを追加し、リスト上で順序を <ArrowUp size={12} /><ArrowDown size={12} /> で入れ替えて結合します。</li>
                        </ul>
                    </div>
                </div>
            </section>


            {/* 5. TEXTIFIER */}
            <section style={{ marginBottom: '60px' }}>
                <h3 style={{ borderBottom: '2px solid #9e4ae2', paddingBottom: '10px', color: '#9e4ae2', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <ScanText size={24} /> 5. PDFテキスト化 (Textifier)
                    <VersionBadge version={TOOL_VERSIONS.textifier.version} />
                </h3>
                <p style={{ marginBottom: '20px' }}>
                    PDFの文字を取り出すツールです。日本語と英語に対応し、2つのモードがあります。
                </p>
                <ul style={{ marginBottom: '20px', paddingLeft: '20px', lineHeight: 1.9 }}>
                    <li>
                        <b>OCR</b> — スキャンして画像になってしまったPDFを文字認識し、
                        <b>文字を検索・選択できるPDF</b>を作ります。見た目は元のPDFのまま変わりません
                        （文字情報が裏側に追加されます）。
                    </li>
                    <li>
                        <b>Text Extraction</b> — PDFの文字を<b>TXTファイル</b>または
                        <b>編集可能なWord（.docx）</b>として書き出します。
                        文字情報を持つページはその文字をそのまま取り出し、スキャンページはOCRを行います。
                        元のPDFのページ順は維持されます。
                    </li>
                </ul>

                <ScreenWithBadges
                    src="/screenshots/textifier.png"
                    badges={[
                        // Measured against the current capture by
                        // scripts/capture-textifier-screenshot.mjs, which prints
                        // these percentages when it retakes the image. They moved
                        // when the preview started drawing the page: an empty box
                        // is shorter than the sheet it stands in for.
                        // 1. Upload (Centre)
                        { top: '19.7%', left: '21.1%', width: '57.8%', height: '44.3%', desc: 'ファイルアップロードエリア' },
                        // 2. Settings row (Cleaning / Processing Mode / Output Format)
                        { top: '66.6%', left: '21.1%', width: '57.8%', height: '15.7%', desc: 'OCR前処理・モード・出力形式' },
                        // 3. Run button
                        { top: '84.9%', left: '40.3%', width: '19.5%', height: '4.1%', desc: '実行（Start Textification）' }
                    ]}
                />

                <div style={gridStyle}>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>①</strong> <UploadCloud size={18} /> ファイルアップロード</h4>
                        <p>中央の点線エリア内をクリック、またはファイルをドラッグ&ドロップして対象PDFを読み込みます。</p>
                        <p style={noteStyle}>1回につき1ファイルを処理します。</p>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>②</strong> <Settings size={18} /> 設定 (Settings)</h4>
                        <p><b>Processing Mode</b> で、やりたいことを選びます。出力形式は自動で切り替わります。</p>
                        <ul style={listStyle}>
                            <li><b>OCR</b> → 出力形式は <b>PDF (Searchable)</b>。検索できるPDFが保存されます。</li>
                            <li><b>Text Extraction</b> → 出力形式は <b>Text (.txt)</b> または <b>Word (.docx)</b>。
                                文字だけのTXT、または編集できるWord文書が保存されます。</li>
                            <li>どちらのモードでも、すでに文字情報を持つページには文字認識を行いません。</li>
                        </ul>
                        <p><b>OCR前処理</b>は、必要なときだけチェックします（初期状態はオフ）。</p>
                        <ul style={listStyle}>
                            <li><b>傾き補正:</b> 斜めに読み取られたスキャンページをまっすぐにしてから認識します。</li>
                            <li><b>ノイズ除去:</b> 点状の細かな汚れを取り除いてから認識します。</li>
                        </ul>
                        <p style={noteStyle}>
                            モードや前処理を切り替えると、前の設定で作った結果は破棄されます。切り替えたあとにもう一度実行してください。
                            画面上でグレー表示になっている項目は、まだご利用いただけません（下の「未対応の機能」を参照）。
                        </p>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>③</strong> <Download size={18} /> 実行・ダウンロード</h4>
                        <p>「Start Textification」を押すと処理が始まります。</p>
                        <ul style={listStyle}>
                            <li>進捗がページ単位で表示されます。</li>
                            <li>途中で「キャンセル」できます（現在のページの認識完了後に反映されます）。</li>
                            <li>キャンセルした場合、途中までのファイルは保存されません。</li>
                            <li>完了後に「Download Result」から保存します（OCRは <b>_searchable.pdf</b>、Text Extraction は <b>_extracted.txt</b> または <b>_extracted.docx</b>）。</li>
                        </ul>
                        <p style={noteStyle}>※ページ数や解像度によっては、処理に時間がかかる場合があります。</p>
                    </div>
                </div>

                {/* 5-b. What the OCR can and cannot do today */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginTop: '20px' }}>
                    <div style={{ ...cardStyle, borderLeft: '6px solid #9e4ae2' }}>
                        <h4 style={cardHeadStyle}><ScanText size={18} /> 現在できること</h4>
                        <ul style={listStyle}>
                            <li>PDFの読み込み</li>
                            <li>ページごとに「文字情報あり」「スキャン画像」を自動判定</li>
                            <li>スキャン画像のページだけをOCR</li>
                            <li>日本語・英語の文字認識</li>
                            <li><b>OCR前処理（傾き補正・ノイズ除去）</b></li>
                            <li>検索・選択できるPDFの生成</li>
                            <li>元の見た目をそのまま保持</li>
                            <li><b>PDFから文字をTXTとして抽出</b></li>
                            <li><b>PDFから文字を編集可能なWord（.docx）として書き出し</b></li>
                            <li>文字情報のあるページは、PDF内の文字をそのまま利用</li>
                            <li>スキャンページはOCRの結果を利用</li>
                            <li>文字ページとスキャンページが混在したPDFに対応</li>
                            <li>元のPDFのページ順を維持して書き出し</li>
                            <li>回転したページに対応</li>
                            <li>進捗表示とキャンセル</li>
                            <li>結果のダウンロード</li>
                            <li>処理はすべてブラウザ内で実行</li>
                        </ul>
                    </div>

                    <div style={{ ...cardStyle, borderLeft: '6px solid #b0b0b0' }}>
                        <h4 style={cardHeadStyle}><Settings size={18} /> 未対応の機能（今後対応予定）</h4>
                        <p style={{ margin: '0 0 8px' }}>次の項目は画面に表示されていますが、現在は選択できません。</p>
                        <ul style={listStyle}>
                            <li><b>Excel (.xlsx) 出力</b> — 未対応（Coming later）</li>
                        </ul>
                        <p style={noteStyle}>
                            現在ご利用いただける出力は「PDF (Searchable)」「Text (.txt)」「Word (.docx)」です。
                        </p>
                    </div>
                </div>

                {/* 5-c. What the TXT export is, and is not */}
                <div style={{ ...cardStyle, borderLeft: '6px solid #d9a441', marginTop: '20px' }}>
                    <h4 style={cardHeadStyle}><ScanText size={18} /> TXT書き出しについて知っておくこと</h4>
                    <ul style={listStyle}>
                        <li>TXTにはページの区切り（<code>===== Page 1 =====</code>）が入り、ページ順は元のPDFのままです。</li>
                        <li>文字のないページも、ページの見出しだけは残ります。</li>
                        <li>段組みや表が複雑なページでは、文字の順序が見た目どおりにならない場合があります。</li>
                        <li>表をExcelの表として復元する機能ではありません。</li>
                        <li>スキャンページの文字の正確さは、元の画像の品質によって変わります。</li>
                        <li>キャンセルは現在のページの認識が終わったあとに反映されます。</li>
                    </ul>
                </div>

                {/* 5-e. What the Word export is, and what it is not */}
                <div style={{ ...cardStyle, borderLeft: '6px solid #2b579a', marginTop: '20px' }}>
                    <h4 style={cardHeadStyle}><FileText size={18} /> Word（.docx）書き出しについて</h4>
                    <p style={{ margin: '0 0 8px' }}>
                        PDFの<b>文字</b>を、Wordで編集できる文書として書き出します。
                        文字情報を持つページはその文字を直接、スキャンページはOCRの結果を使い、
                        文字ページとスキャンページが混在したPDFにも対応します。OCR前処理も併用できます。
                        処理はすべてブラウザ内で行われます。
                    </p>
                    <ul style={listStyle}>
                        <li>元のPDFのページ順を保ち、ページの区切りをWordの改ページとして入れます。文字のないページも区切りを残します。</li>
                        <li><b>PDFの見た目をWordへ再現する機能ではありません。</b></li>
                        <li>表の構造は復元しません。</li>
                        <li>段組みや複雑なレイアウトのページでは、文字の順序が見た目どおりにならない場合があります。</li>
                        <li>画像・図形・線はWordへ移しません。文字だけを書き出します。</li>
                        <li>フォント・文字サイズ・太字などの体裁は再現しません。</li>
                        <li>Word側での実際のページ数は、お使いの環境やフォントによって変わることがあります。</li>
                    </ul>
                </div>

                {/* 5-d. What preprocessing is, and what it is not */}
                <div style={{ ...cardStyle, borderLeft: '6px solid #4a90e2', marginTop: '20px' }}>
                    <h4 style={cardHeadStyle}><Settings size={18} /> OCR前処理について</h4>
                    <ul style={listStyle}>
                        <li>補正するのは<b>文字認識用の画像だけ</b>です。元のPDFの見た目・線・文字情報は変更しません。</li>
                        <li>効果は元のスキャン画像の品質によって変わります。</li>
                        <li>傾きがほとんどないページや、判断できるだけの文字がないページでは、補正を行わないことがあります。誤って傾けないための動作です。</li>
                        <li>対象はおおよそ5度までの傾きです。用紙が90度単位で回転しているページは、これとは別に元から扱われます。</li>
                        <li>ノイズ除去は、紙の上に単独で載っている点だけを取り除きます。細い線や小さな文字を消さないよう控えめに動作します。</li>
                        <li>文字情報を持つページには前処理を行いません（そもそも文字認識をしないため）。</li>
                    </ul>
                </div>

                <p style={calloutStyle}>
                    <b>データの取り扱い:</b> 文字認識・OCR前処理・TXTの書き出しは、いずれもお使いのブラウザ内で実行されます。
                    PDFを外部のAI・OCRサービスへ送信することはありません。
                </p>
            </section>

            {/* 6. RELEASE HISTORY */}
            <section id="release-history" style={{ marginBottom: '60px', scrollMarginTop: '20px' }}>
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
                                <VersionBadge version={release.version} />
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

const cardStyle: React.CSSProperties = {
    background: 'white',
    padding: '20px',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    border: '1px solid #eee'
};

const cardHeadStyle: React.CSSProperties = {
    marginTop: 0,
    marginBottom: '10px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    color: '#333'
};

const subHeadStyle: React.CSSProperties = {
    margin: '0 0 6px',
    fontSize: '0.95rem',
    color: '#333'
};

const listStyle: React.CSSProperties = {
    paddingLeft: '20px',
    margin: 0,
    fontSize: '0.9em',
    color: '#555',
    lineHeight: 1.7,
    overflowWrap: 'anywhere'
};

const noteStyle: React.CSSProperties = {
    fontSize: '0.85em',
    color: '#777',
    margin: '6px 0 0'
};

const calloutStyle: React.CSSProperties = {
    fontSize: '0.9em',
    color: '#555',
    background: '#fff8e1',
    border: '1px solid #ffe0a3',
    borderRadius: '6px',
    padding: '10px 12px',
    marginTop: '16px'
};

// Helper Component for Screenshot with Badges
interface BadgeRect { top: string; left: string; width: string; height: string; }
interface BadgeItem { top: string; left: string; width?: string; height?: string; rects?: BadgeRect[]; desc: string; }

const ScreenWithBadges = ({ src, badges }: { src: string, badges: BadgeItem[] }) => (
    <div style={{ position: 'relative', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden', marginBottom: '20px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
        <img src={src} style={{ width: '100%', display: 'block' }} alt="Tool Screenshot" />
        {badges.map((b, i) => (
            <React.Fragment key={i}>
                {/* Render Multiple Boxes if provided */}
                {b.rects ? b.rects.map((r, ri) => (
                    <div key={ri} style={{
                        position: 'absolute',
                        top: r.top,
                        left: r.left,
                        width: r.width,
                        height: r.height,
                        border: '3px solid red',
                        borderRadius: '4px',
                        pointerEvents: 'none',
                        boxShadow: '0 0 4px rgba(255,0,0,0.4)'
                    }} />
                )) : (
                    /* Fallback to single box if width/height provided */
                    b.width && b.height && (
                        <div style={{
                            position: 'absolute',
                            top: b.top,
                            left: b.left,
                            width: b.width,
                            height: b.height,
                            border: '3px solid red',
                            borderRadius: '4px',
                            pointerEvents: 'none',
                            boxShadow: '0 0 4px rgba(255,0,0,0.4)'
                        }} />
                    )
                )}

                {/* Render Badge at the specified top/left (usually of the first box) */}
                <div style={{
                    position: 'absolute',
                    top: b.rects ? `calc(${b.rects[0].top} - 14px)` : (b.width ? `calc(${b.top} - 14px)` : b.top),
                    left: b.rects ? `calc(${b.rects[0].left} - 14px)` : (b.width ? `calc(${b.left} - 14px)` : b.left),
                    width: '28px',
                    height: '28px',
                    borderRadius: '50%',
                    background: 'red',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                    cursor: 'help',
                    border: '2px solid white',
                    zIndex: 10
                }} title={b.desc}>
                    {i + 1}
                </div>
            </React.Fragment>
        ))}
    </div>
);

