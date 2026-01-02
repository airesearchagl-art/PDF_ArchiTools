import React from 'react';
import { PenTool, Layers, Ruler, ZoomIn, Download, Sliders, Blend, FileText, UploadCloud, Eye, Combine, ArrowUp, ArrowDown, ScanText, Settings } from 'lucide-react';

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
                <p style={{ margin: '10px 0 0', fontSize: '0.9em', color: '#ffecb3', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    ※ アップロードされたPDFデータは、すべてお客様のブラウザ内（ローカル環境）でのみ処理されます。<br />
                    外部サーバーへ送信・保存されることは一切ありませんので、機密情報を含む図面データでも安心してご利用いただけます。
                </p>
            </div>

            {/* 1. ANNOTATOR */}
            <section style={{ marginBottom: '60px' }}>
                <h3 style={{ borderBottom: '2px solid #4a90e2', paddingBottom: '10px', color: '#4a90e2', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <PenTool size={24} /> 1. PDF加筆 (Annotator)
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
                </h3>
                <p style={{ marginBottom: '20px' }}>
                    一括処理ツールです。「半透明レイヤー追加」「モノクロ化」「最適化」などを複数のファイルに対して一度に行えます。
                </p>

                <ScreenWithBadges
                    src="/screenshots/processor.png"
                    badges={[
                        // 1. Function Select (Left Sidebar)
                        { top: '15%', left: '1%', width: '25%', height: '70%', desc: '加工機能の選択' },
                        // 2. File List (Right Top)
                        { top: '21%', left: '30%', width: '68%', height: '30%', desc: 'ファイル追加・リスト' },
                        // 3. Settings (Right Middle)
                        { top: '60%', left: '30%', width: '68%', height: '25%', desc: '詳細設定' },
                        // 4. Run Button (Right Bottom)
                        { top: '85%', left: '30%', width: '68%', height: '10%', desc: '処理実行ボタン' }
                    ]}
                />

                <div style={gridStyle}>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>①</strong> 機能選択</h4>
                        <p>「半透明レイヤー」「モノクロ化」「最適化」など、実行したい処理を選択します。</p>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>②</strong> ファイル追加</h4>
                        <p>処理したいPDFファイルを左側のエリアに追加します（ドラッグ&ドロップ可）。</p>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>③</strong> 詳細設定</h4>
                        <p>選択した機能に応じて、透明度やDPIなどのパラメータを調整します。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>半透明レイヤー:</b> 色と不透明度を設定。</li>
                            <li><b>モノクロ化:</b> コントラストと解像度を調整。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>④</strong> 処理実行</h4>
                        <p>「Start Processing」ボタンを押すと、すべてのファイルに対して処理が実行され、完了後にダウンロードされます。</p>
                    </div>
                </div>
            </section>


            {/* 4. EXTRACT & MERGE */}
            <section style={{ marginBottom: '60px' }}>
                <h3 style={{ borderBottom: '2px solid #e2a84a', paddingBottom: '10px', color: '#e2a84a', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Blend size={24} /> 4. PDF抽出・統合 (Extract & Merge)
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
                </h3>
                <p style={{ marginBottom: '20px' }}>
                    スキャンデータを解析し、テキスト情報を付与(OCR)したり、Word/Excel形式に変換したりします。
                </p>

                <ScreenWithBadges
                    src="/screenshots/textifier.png"
                    badges={[
                        // 1. Upload (Center)
                        { top: '20%', left: '25%', width: '50%', height: '30%', desc: 'ファイルアップロードエリア' },
                        // 2. Settings (Center Middle)
                        { top: '52%', left: '25%', width: '50%', height: '25%', desc: 'OCR/クリーニング設定' },
                        // 3. Output (Center Bottom)
                        { top: '70%', left: '25%', width: '50%', height: '15%', desc: '出力フォーマット設定' }
                    ]}
                />

                <div style={gridStyle}>
                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>①</strong> <UploadCloud size={18} /> ファイルアップロード</h4>
                        <p>中央の点線エリア内をクリック、またはファイルをドラッグ&ドロップして対象PDFを読み込みます。</p>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>②</strong> <Settings size={18} /> 設定 (Settings)</h4>
                        <p>変換のパラメータを設定します。</p>
                        <ul style={{ paddingLeft: '20px', fontSize: '0.9em', color: '#555' }}>
                            <li><b>ノイズ除去:</b> スキャン時の汚れ（黒点など）を除去して認識率を高めます。</li>
                            <li><b>OCR / Text:</b> 画像から文字を読み取るOCRモードか、埋め込みテキストを抽出するモードかを選択します。</li>
                        </ul>
                    </div>

                    <div style={cardStyle}>
                        <h4 style={cardHeadStyle}><strong style={{ color: 'red' }}>③</strong> <Download size={18} /> 出力・実行</h4>
                        <p>出力形式 (PDF / Word / Excel) を選択して実行ボタンを押します。</p>
                        <p style={{ fontSize: '0.85em', color: '#777' }}>※処理には時間がかかる場合があります。完了するとダウンロードボタンが表示されます。</p>
                    </div>
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
    color: '#333'
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

