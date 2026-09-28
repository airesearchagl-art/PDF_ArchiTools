# Comparator Large-set Compressed Output Writer — Architecture Research Report

M4 deferred topic **large-set Output Writer** の再開。関連: *Large real drawing performance / edge cases*。
モード: **Architecture / Research only**。`src/` は一切変更していない。

> 表記: サイズは bytes / MiB（2^20）。「MB」は 10^6。**Structural** = 実行ごとに一致すべき値（ファイルサイズ、判定、画素一致、受理/拒否）。**MeasuredOnly** = 時間・RSS（参考値、比較しない）。数値の出典は `evidence/gate-*.json`。

---

## 0. 結論（先に）

| | 現行（jsPDF 3.0.4, stored PNG → 無圧縮 RGB） | 推奨案（Owned writer + 4-bit Indexed + PNG Up predictor + ネイティブ `CompressionStream`） |
|---|---|---|
| A1 × 5 p × 150 dpi | **拒否**（2 GiB でも `OVER_OUTPUT_BUDGET`「先頭から 3 ページまで」）。強制実行すると 261,549,245 bytes | **1 本で出力可**。**520,711 bytes（0.50 MiB）**、画素完全一致、512 MiB 既定で受理（予算モデル上 191 MiB） |
| A1 × 5 p × 300 dpi | 1 ページでも拒否。強制実行すると jsPDF が**例外を握りつぶし 0 byte**を返す | **1,148,669 bytes（1.10 MiB）**、画素完全一致、**1 GiB** で受理（765 MiB） |
| A1 × 5 p × 450 dpi | 1 ページでも拒否（1 ページ強制で 470,736,676 bytes、writer 自身 ≈ 2.2 GB） | **1,844,718 bytes（1.76 MiB）**、画素完全一致。推奨の案 A では出力上界 374 MiB > 256 MiB のため **3 p まで**（2 GiB）、案 B なら 5 p @ 2 GiB（1,721 MiB）— 調査枠 |
| writer 自身のピーク（MeasuredOnly） | 150 dpi × 5 p で +761 MiB | 150 dpi × 5 p で +22 MiB、450 dpi × 5 p で +33 MiB |

**比較結果の合成画像は、1 ペアあたり最大 9 状態のパレット画像である**（engine.ts:163-204 の `paintPair` は各画素をマスク状態だけで塗る）。これを 4-bit Indexed のまま可逆で書けば、比較判定・色・幾何・ページ順を一切変えずに、現行比 **約 500 倍（150 dpi）〜 900 倍（300 dpi 換算）** 小さくなる。しかも RGBA 合成画像そのものがファイル出力には不要になる（マスクから行単位で直接エンコード）。

推奨: **Build**（小さな owned PDF writer）＋ プラットフォームの `CompressionStream('deflate')`（新規依存ゼロ）。jsPDF は Comparator 専用依存なので、Comparison PDF と Change Report の両方を移せば依存ごと外せる。

> **RF-01 / RF-02 で改訂（§25–§27）**: 安全上の権威は owned bounded DEFLATE（推奨 B）に移し、`CompressionStream` は owned 上界でガードした任意の最適化（C）に格下げ。初回 Production は Comparison PDF Output Writer v2 のみ、Change Report は既存 jsPDF 経路に据え置き（DEFER）、jsPDF 削除はしない。

**前回 M4 研究の H5 / H11 の緊張（「圧縮すると厳密なサイズ保証を失う」）は、spool なしで解ける**: 4-bit 行 + stored フォールバックにより、ページごとの出力は作業前に**決定的な上界**（≈ 0.5 B/px、現行 stored PNG の 1/8）で縛れる。その上界だけで判定しても 150 dpi × 5 p（41.6 MiB）と 300 dpi × 5 p（166.4 MiB）は現行の `MAX_OUTPUT_BYTES` 256 MiB に収まる（§14、§24）。

---

## 1. Fresh Gate

- `git fetch origin` 後 `origin/main` = **`96c28de3dba40322393e83b3f08fd723885cd7c5`**（Merge PR #27）。期待値と一致。
- 研究 branch `research/m4-large-set-output-writer` を `origin/main` から worktree で作成。ローカルの `feat/m6-split-merge-reliability` と未追跡の `public/tessdata/` 等には触れていない。

## 2. 現在の `main`

`96c28de`。Comparator の出力経路（`src/utils/comparator/`）:
`contract.ts`（`MAX_OUTPUT_BYTES = 256 MiB`、メモリプリセット 512 MiB / 1 GiB / 2 GiB）、`png.ts`（`encodePngStored`, filter 0 + stored DEFLATE）、`budget.ts`（jsPDF 3.0.4 を束縛したメモリ/出力モデル）、`artifacts.ts`（`createComparisonPdf` / `createChangeReport`、jsPDF は `compress` なし）。jsPDF を import しているのは `src` 全体で `artifacts.ts` だけ。

## 3. 現行 A1 制限の再現

合成 A1 コーパス（§18）を本番の preflight（`planArtifact` + `preflightArtifact`、無改変）に掛けた結果（`evidence/budget-matrix.json`）:

| 150 dpi | 512 MiB | 1 GiB | 2 GiB |
|---|---|---|---|
| 1 p | ACCEPT (333 MiB) | ACCEPT | ACCEPT |
| 2 p | ACCEPT (450 MiB) | ACCEPT | ACCEPT |
| 3 p | OVER_MEMORY (650 MiB) | ACCEPT | ACCEPT |
| 4 p | OVER_MEMORY | **OVER_OUTPUT 266.11 MiB「先頭から 3 ページまで」** | **同左** |
| 5 p | OVER_MEMORY (1,050 MiB) | OVER_MEMORY | **OVER_OUTPUT 332.63 MiB「先頭から 3 ページまで」** |

実際の報告（2 GiB でも 1–3 / 4–5 に分割が必要）と一致する。既定 512 MiB では **2 ページまで**しか出せない。300 dpi は **1 ページでも** 出力上限（266.06 MiB > 256 MiB）で拒否、450 dpi は全組合せでメモリ拒否。

本番 sink（`createComparisonPdf`、無改変）を preflight なしで直接駆動した実測（`evidence/matrix-*.jsonl`）: 150 dpi 1–3 p = 156,930,668 bytes、1–5 p = **261,549,245 bytes**（≈ 250 MB 報告と一致）。

## 4. 約 50 MB/page の内訳（実測）

`harness/inspect-images.mjs` で現行出力を解剖: 各ページの画像は `/DeviceRGB`, 8 bpc, **Filter なし**, **52,308,663 bytes = 4969 × 3509 × 3**（ちょうど無圧縮 RGB）。150 dpi の A1 フレームは 4969 × 3509 = 17,436,221 px（依頼書の概算 3508 × 4967 と一致、`ceil(pt × dpi/72)`）。

| 項目 | 1 ページ（150 dpi, A1 横） | 根拠 |
|---|---|---|
| ラスタ寸法 | 4969 × 3509 = 17.44 Mpx | `prepare.mjs` meta |
| RGBA 作業バッファ（合成画像） | 69,744,884 bytes（66.5 MiB） | `paintPair` 出力 |
| owned stored PNG | 69,754,573 bytes（66.52 MiB, **4.0006 B/px**） | `pngStoredSize`、`budget-matrix.json` |
| jsPDF 保持 RGB 文字列 | 52,308,663 chars + rope overhead（50.29 MiB） | `jsPdfRetained` |
| PDF ファイル寄与 | 52,308,663 + ≈ 200 bytes/page（**≈ 52.3 MB = 49.9 MiB**） | 実ファイル |
| コンテナ overhead | 5 ページで 5,930 bytes | 261,549,245 − 5 × 52,308,663 |
| 公開時ピーク（モデル） | 5 p: 1,050 MiB（保持画像 + 結合文字列 + ArrayBuffer + Blob） | `preflightArtifact.publish` |
| 公開時ピーク（writer 自身, MeasuredOnly） | 5 p: +761 MiB（Node RSS） | sink-only 計測 |
| 累積 Output Budget 課金 | 5 p: 332.63 MiB（上限 256 MiB） | 同上 |
| 累積ファイルサイズ | 5 p: 261,549,245 bytes | 実ファイル |

## 5. 3 ページは通り 4 ページは拒否される証明

`itemCost` の `outputBytes = max(ownedPNG, fileShare)`（budget.ts:360）。stored PNG（4.0006 B/px）がファイル寄与（3 B/px）より大きいので、**課金されるのは stored PNG**。

```
raster     = 3509 × (1 + 4969 × 4)                       = 69,748,393
blocks     = ceil(69,748,393 / 65,535)                    = 1,065
zlib       = 2 + 1,065 × 5 + 69,748,393 + 4                = 69,753,724
IDAT       = ceil(69,753,724 / 1,048,576)                  = 67
pngStored  = 8 + 25 + 67 × 12 + 69,753,724 + 12            = 69,754,573   (66.52 MiB)

pngStored(3509 × 4969, 縦の p4)                              = 69,756,033

3 p: 16,384 + 3 × 69,754,573              = 209,280,103 (199.59 MiB) ≤ 268,435,456 → 通る
4 p: 209,280,103 + 69,756,033             = 279,036,136 (266.11 MiB) > 268,435,456 → OVER_OUTPUT_BUDGET
```

つまり 4 ページ目で落ちるのは**実ファイル（3 B/px）ではなく、ファイルに一度も書かれない stored PNG（4 B/px）で課金している**ためで、さらにその下の実ファイルも無圧縮。メモリプリセットを 2 GiB に上げても `MAX_OUTPUT_BYTES` は独立なので変わらない（報告どおり）。

**追加発見（重大）**: 300 dpi × 5 p を preflight なしで本番 sink に通すと、`doc.output()` 内の `content.join()` が V8 の最大文字列長を超えて `RangeError: Invalid string length` を投げ、**jsPDF がそれを捕捉してコンソールに出すだけで `undefined` を返す**（空の成果物、例外なし）。現行の `MAX_OUTPUT_BYTES` は暗黙にこの沈黙失敗も防いでいる。**jsPDF のまま定数を上げる案は安全ではない**ことの直接証拠。

## 6. 現行のアロケーション / 成果物ライフサイクル

```
render member (canvas RGBA + readback RGBA) → inkMask ×members → dilation → comparison
→ paintPair: RGBA composite (4 B/px)
→ encodePngStored: stored PNG (4.0006 B/px)        → composite 解放
→ jsPDF addImage: fast-png decode → pako inflate (chunks + flat) → unfilter RGBA
   → RGB + alpha split → binary string (3 B/px, 文書終了まで保持)
→ save(): content.join("\n") (文書全体の文字列) → ArrayBuffer (同サイズ) → Blob (同サイズ)
```

ページごとに 3 B/px が保持され、公開時に文書全体が文字列 → ArrayBuffer → Blob と 3 重化する。

## 7. 候補アーキテクチャ

すべて「判定確定後の合成結果」を入力にする（stage 1 で本番 kernel が判定済み。stage 2 は出力エンコードのみ）。

| ID | 経路 | 役割 |
|---|---|---|
| `current` | 本番 sink（jsPDF） | 基準 |
| `rgb-flate` / `rgb-up` / `rgb-paeth` / `rgb-adaptive` | RGBA 合成 → RGB → (PNG 予測) → Flate | 「普通に圧縮する」案 |
| `idx4c-*` | RGBA 合成 → 9 色パレット索引 → 4-bit Indexed → Flate | 合成画像を残す Indexed |
| `idx4m-flate` / `-up` / `-L1` / `-L9` | **マスクから直接** 4-bit 状態行 → fflate | 合成 RGBA を作らない |
| `idx4m-cs` / **`idx4m-cs-up`** | 同上 → ブラウザ標準 `CompressionStream('deflate')` | 依存ゼロ |
| `idx4m-down2` | 優先度付き 2×2 縮小（変更 > 一致 > 紙） | 解像度削減（非可逆） |
| `jpeg-q90` / `jpeg-q75` | RGBA → JPEG (DCTDecode) | 非可逆 |

writer は全候補共通の試作 `harness/pdf-writer.mjs`（append-only、オブジェクトを完成時に Uint8Array チャンク化、xref は最後、`finish()` まで何も公開しない）。

**パレットの厳密性**: 9 状態（各レイヤー: インクなし / 一致 / 不一致）の色は、本番 `paintPair` に 9 画素を塗らせて得る（`statePalette`）。コンポジタとパレットがずれる余地はない。許容値 0.15 mm（一致色の不透明度合成で色数 5）でも画素完全一致を確認。

## 8. PDF writer / encoder Reuse Scan

| 候補 | 版 / 保守 | License | Browser | Bundle (min+gz) | 圧縮ストリーム | メモリ | 判定 |
|---|---|---|---|---|---|---|---|
| **jsPDF** | 3.0.4 導入済（最新 4.2.1, 2026-03） | MIT | ○ | ≈ 130 kB | `addImage` は PNG を全デコード後に再圧縮（Predictor 11–14 固定）。**圧縮済みストリームを渡す公開 API なし** | 文書全体を JS 文字列で保持、画像も binary string、`output()` は例外を握りつぶす | **却下** |
| **pdf-lib** | 1.17.1（2021-11 以降更新なし、fork `@cantoo/pdf-lib` は活発） | MIT | ○ | ≈ 178 kB | `context.stream()` で任意 dict の生ストリームを登録可 | 全オブジェクトを `save()` まで保持、`save()` がファイル全体の単一バッファを確保 | **却下**（使うのは一部の機能だけ、本家は保守停止、公開時に全体コピー） |
| **pdfkit** | 0.20.2（2026-08） | MIT | ○（browser build） | ≈ 212 kB（fontkit 大） | 非インターレース・αなし PNG の IDAT を Predictor 15 で素通し、ページごとフラッシュ | ストリーム出力可 | **保留**（Indexed 4-bit を PNG 化する手間、Buffer polyfill 問題、サイズ） |
| **CompressionStream** | Web 標準 | — | Baseline widely available（2023-05〜、MDN）、Worker 可 | 0 | `'deflate'` = zlib 形式 = FlateDecode そのもの（実機で header `78 9C` を確認） | ストリーミング | ~~採用~~ ← **RF-01 で改訂**: 安全経路には採用しない（内部状態・出力上限は Web API の契約ではない）。owned 上界でガードした任意最適化としてのみ（§25） |
| fflate | 0.8.3（2026-05） | MIT | ○ | ≈ 8–12 kB | 同期/ストリーム Zlib、レベル指定可 | ストリーミング | フォールバック候補（CS 非対応環境用）。本命は不要 |
| pako | 3.0.2（2026-09, 3.x で breaking） | MIT+Zlib | ○ | ≈ 13.5 kB | ストリーム Deflate | — | 不要（pdf-lib 用に 2.1.0 が既にあるが使わない） |
| fast-png / UPNG.js / @jsquash/* | — | MIT / Apache-2.0 | ○ | — | PNG エンコード | — | 不要（PNG コンテナは使わない） |
| muhammara / hummus | — | — | **×**（native addon） | — | — | — | 対象外 |

→ **Build / Reuse / Hybrid 判定: Build**（owned writer、試作 ≈ 150 行）＋ **Reuse はプラットフォーム API（CompressionStream）のみ**。新規 npm 依存なし、jsPDF 依存を削除可能。

> **RF-01 で改訂**: Build の中身は owned writer ＋ **owned bounded DEFLATE**（§25）。プラットフォーム API は安全経路に入れない。jsPDF 削除は Change Report 移行後（§26）。

## 9. 可逆圧縮の測定（Structural）

150 dpi, A1 × 5 p, 2 members, tolerance 0（全行 pdf.js で開き直し **画素不一致 0**）:

| 候補 | bytes | 対現行 |
|---|---:|---:|
| current | 261,549,245 | 1× |
| rgb-flate（予測なし） | 1,281,177 | 204× |
| rgb-up | 828,271 | 316× |
| rgb-paeth | 810,636 | 323× |
| rgb-adaptive | 815,602 | 321× |
| idx4c-flate / idx4m-flate | 662,307 | 395× |
| idx4m-flate-L1 | 1,072,748 | 244× |
| idx4m-flate-L9 | 564,842 | 463× |
| idx4c-up / idx4m-up（fflate L6） | 552,001 | 474× |
| idx4m-cs（CompressionStream） | 648,738 | 403× |
| **idx4m-cs-up** | **520,711** | **502×** |

- 「予測なしの素の DEFLATE で十分か」→ RGB では予測の有無で 1.55 倍差、Indexed では 1.2〜1.8 倍差。**PNG Up 予測は常に効く**（依頼書の懸念どおり、測って確認）。
- adaptive（libpng のヒューリスティック）は Up/Paeth に勝たない（線画は行間相関が支配的）。
- 許容値 0.15 mm: idx4m-flate 662,625 bytes、画素一致 0 差。

## 10. 非可逆（任意）の測定

| 候補 | bytes (150 dpi 5 p) | 変更画素の再現率 p2 / p3 / p5 | 誤変更画素 |
|---|---:|---|---|
| jpeg-q90 | 3,926,323 | 49.4 % / 5.8 % / 1.1 % | 0 |
| jpeg-q75 | 3,029,914 | 45.0 % / 0 % / 0.7 % | 0 |
| idx4m-down2（優先度 2×2） | 234,663 | 96.0 % / 100 % / 92.6 % | 6,057 / 87 / 5,372 |
| (参考) 72 dpi で比較し直し | 218,523 | — | 判定自体が変わるので成果物エンコードではない |

300 dpi jpeg-q90 = 10,426,707 bytes（再現率 67 / 39 / 63 %）、450 dpi = 18,294,051 bytes（79 / 46 / 55 %）。

**JPEG は可逆 Indexed より 6〜10 倍大きく、しかも赤/青の変更マークの色が 4:2:0 色差間引きで崩れて変更画素の大半が別クラスに化ける。**比較成果物としては無条件に不適格。優先度付き縮小は小さいが変更マークの形が変わる（誤変更画素が出る）。可逆で既に 0.5 MB なので、**軽量共有モードを追加する根拠はない**（推奨: 作らない）。

**Acrobat の 250 MB → 2 MB について**: 合成コーパスでは**可逆だけで 502 倍**縮む。実案件の 125 倍は可逆圧縮だけで十分説明でき、Acrobat が非可逆化したとは推定できないし、しなかったとも言えない（未検証）。実ファイルを外に出さずに確かめる手段として `harness/inspect-images.mjs` を用意した（§22-1）。

## 11. 150 / 300 / 450 dpi マトリクス

| | 150 dpi | 300 dpi | 450 dpi |
|---|---|---|---|
| フレーム（A1 横） | 4969 × 3509 = 17.4 Mpx | 9938 × 7017 = 69.7 Mpx | 14907 × 10526 = 156.9 Mpx |
| Chrome 143 canvas 生成 + `getImageData` | ○ | ○ | ○（readback 627,644,328 bytes） |
| kernel ピーク（本番 `estimatePhaseMemory`, render 相） | 149.7 MiB | **598.5 MiB** | **1,346.8 MiB** |
| 現行 5 p | 拒否 / 強制 261.5 MB | 拒否 / 強制で **0 byte（沈黙失敗）** | 拒否 / 1 p 強制 470.7 MB |
| idx4m-cs-up 5 p | **520,711** | **1,148,669** | **1,844,718** |
| idx4m-up（fflate）5 p | 552,001 | 1,203,603 | 1,920,123 |
| rgb-up 5 p | 828,271 | 2,159,825 | 4,088,305 |
| writer 自身ピーク cs-up（MeasuredOnly） | +22 MiB | +44 MiB | +33 MiB |
| 新モデル: メモリ（512 M / 1 G / 2 G） | Y / Y / Y | n / Y / Y | n / n / Y |
| 新モデル: 出力上界 ≤ 256 MiB（案 A） | ○（41.6 MiB） | ○（166.4 MiB） | 3 p まで ○（5 p は 374.3 MiB） |
| Chrome PDF viewer で開く | ○ | ○ | ○（5 p、縦横混在、スクショ `out/chrome/`） |

- **150 dpi（必須）**: 512 MiB 既定で 5 ページ 1 本。達成可能。
- **300 dpi（望ましい）**: 1 GiB で 5 ページ 1 本。512 MiB に収まらない**唯一の原因は writer ではなく kernel の render 相**（member の canvas RGBA 278.9 MB + readback RGBA 278.9 MB + 他 member のマスク 69.7 MB = 598.5 MiB）。
- **450 dpi（調査）**: メモリは 2 GiB で 5 ページでもモデル上 1,721 MiB（支配項は kernel 1,347 MiB、writer は数十 MiB）。Chrome の canvas は通るが、Production の必須要件にはしない。**信頼できる安全上限: 案 A で 450 dpi × 3 p @ 2 GiB（出力上界 224.6 MiB）、案 B なら × 5 p @ 2 GiB**。

## 12. メモリモデル比較

| 項 | 現行 | 提案 |
|---|---|---|
| kernel 相 | `estimatePhaseMemory`（不変） | 同じ（不変） |
| sink ピーク | 合成 RGBA + stored PNG + jsPDF ingest（inflate/unfilter/split/stringify）≈ 10 B/px 超 | engine が保持中のマスク + バンドバッファ（64 行）+ 圧縮器状態（上限 4 MiB）+ そのページの圧縮出力の**上界** | ← RF-01: 「4 MiB」は CompressionStream の契約値ではない。改訂後は owned encoder の固定バッファ `encoderScratch`（§25） |
| ページ後に残るもの | 3 B/px の binary string（150 dpi で 52.3 MB/page） | **圧縮済みチャンクのみ**（cs-up 実測 ≈ 104 KB/page @150 dpi） |
| 公開時 | 保持画像 + 結合文字列 + ArrayBuffer + Blob（≈ 4 × 文書） | チャンク + Blob（2 × 文書、結合コピーなし） |
| 5 p @150 dpi 全体ピーク | 1,050 MiB | 191 MiB（上界ベース） |

「最大アクティブページ + 保持圧縮出力」に依存し、無圧縮ページの総和に依存しない、という目標性質を満たす。

## 13. 出力サイズ比較

§9–§11 の表のとおり。要約: 可逆で **現行比 ≈ 500 倍（150 dpi）**、300/450 dpi でもページあたり 0.2–0.4 MB。非可逆で得られる追加削減は **なし**（JPEG はむしろ大きい）。解像度削減（2×）で追加 2.2 倍だが変更マークの形が変わる。

## 14. 提案: Preflight Safety Gate（作業開始前・確定的）

1. DPI、ページ寸法、フレーム寸法（`ceil`）、既知のブラウザ制約（canvas 最大面積・辺長、`CompressionStream` の有無 → 無ければ `UNSUPPORTED` で拒否）。
2. kernel 相（`estimatePhaseMemory`、不変）、work units（不変）。
3. **ページごとの出力上界** `B(page) = max(zlibBound(raw), storedSize(raw)) + 4 KiB`、`raw = (ceil(w/2) + 1) × h`（4-bit 行 + 予測バイト）。Deflate の最悪膨張は実測でも `zlibBound` 以内（一様乱数 8 MiB: 8,390,314 ≤ 8,391,181）。万一超えたら writer はそのページを stored ブロックで出し直す（`png.ts` と同じ厳密サイズ）ので、**上界は構成的に保証**。
   > **RF-01 で改訂**: `zlibBound` 以内という実測は zlib / fflate の振る舞いであり、ブラウザの `CompressionStream` 実装の契約ではない。上界の根拠は owned encoder の構成（ブロックごとに固定ハフマンと stored の小さい方）に置き換えた: `B = ownedDeflateBound(raw) + 4 KiB`（§25）。
4. `jobPeak = max( max(kernel, sinkPeak) + ΣB,  2 × ΣB )` をメモリプリセットと比較。
5. **`ΣB ≤ MAX_OUTPUT_BYTES`（256 MiB、値は据え置き）**。上界で判定するので、現行と同じく「作業前にすべて決まる」契約のまま。

| ΣB（上界） | 1 p | 3 p | 5 p |
|---|---:|---:|---:|
| 150 dpi | 8.3 MiB | 25.0 MiB | **41.6 MiB** |
| 300 dpi | 33.3 MiB | 99.8 MiB | **166.4 MiB** |
| 450 dpi | 74.9 MiB | 224.6 MiB | 374.3 MiB（超過 → 3 p まで） |

→ 「最終圧縮サイズを事前に**厳密に**知る」要件は、「事前に**決定的な上界**を知る」に置き換える。上界はメモリ・出力の両方を縛り、圧縮が期待より悪くても安全性は崩れない（実際のバイトは上界の 1〜2 %）。

## 15. 提案: Runtime Artifact Gate（実行中）

- ページ追加の直前に「現在の出力バイト + このページの実圧縮バイト + 4 KiB」を `MAX_OUTPUT_BYTES` と比較（試作 `ChunkedPdfWriter({ maxBytes })`）。圧縮中のチャンク累積でも同様に早期中断できる。
- 超過したら `abort()`: チャンクを破棄し、**Blob を作らず、ダウンロードも起動しない**。型付き拒否（`OVER_OUTPUT_BUDGET`）に要求 DPI・要求ページ範囲・完了ページ数を載せる。
- 実証: 150 dpi × 5 p に 300,000 bytes の上限を課すと 3 ページ完了後に拒否、**ファイルは存在しない**（`gate-*.json` の `runtimeCeiling`）。出力パスは開始時に削除するので、古い成果物が成功に見えることもない。
- 既存のステイルラン保護（generation token、ペアごとの `taskBoundary`、保存直前の owner 再確認）はそのまま。writer は `finish()` まで何も公開しないので、中断・取消・所有権喪失のいずれでも部分成果物は構造的に発生しない。
- **`MAX_OUTPUT_BYTES` は定数を上げない**。推奨（案 A）は §14-5 のとおり事前に上界で判定し、実行時ゲートは実装の誤り（上界計算の不備、エンコーダの逸脱）に対する多重防御として同じ値で実バイトを数える。案 B（Human 判断）は事前判定を上界ではメモリだけに使い、出力上限は実行時の実バイトにだけ課すもので、450 dpi × 4–5 p も受理できるが、「作業前にすべて決まる」契約を 1 項だけ緩めることになる。

## 16. UX 提案

```
解像度      150 DPI（変更しない限りこのまま）
ページ      5 ページ（1–5）
用紙        A1 横 841 × 594 mm
作業メモリ   推定ピーク 191 MiB ／ 上限 512 MiB
出力サイズ   最大 42 MiB（保証上限）・通常は数 MB 以下（図面の内容で変わります）
状態        出力できます
```

- 出力サイズは**上限のみ確約**し、見込みは幅として表示、完了後に実サイズを表示する（事前に厳密値は出さない）。
- 実行時拒否の文言例: 「出力が上限 256 MiB を超えたため中止しました（150 DPI・1–5 ページを要求、3 ページ完了時点）。ファイルは作成されていません。」
- メモリプリセット（512 MiB / 1 GiB / 2 GiB）は**残す**。150 dpi では不要になるが、300/450 dpi では kernel の render 相が支配し、依然として人の明示的な選択が必要（「予算が勝手に増えない」原則も維持）。ラベルは「作業メモリ上限」とし、出力サイズとは別物だと分かるようにする。

## 17. 回帰リスク

| 領域 | リスク | 対策 |
|---|---|---|
| 判定 / 幾何 / 許容値 | なし（kernel と `paintPair` は不変、エンコードは判定後） | 状態パレットを `paintPair` から導出、画素完全一致の gate |
| プレビュー | なし（RGBA `paintPair` 経路を残す） | 既存 gate |
| sink API | `onPair` が非同期化（`CompressionStream`）。ペアの受け渡しにマスク参照を追加 | 各 await 後に既存の取消/所有者チェック、マスク非改変を assert |
| Change Report | レイアウト（A4 mm、クロップ、テキスト 2 行、通知）を owned writer で再実装 | 同じ PR で移行するなら jsPDF 削除まで一気に。分けるなら 2 つの container モデルが一時共存 |
| （RF-02 改訂）Change Report | **初回は移行しない（DEFER）**。既存 jsPDF 経路と既存 budget の jsPDF 項を残す | §26 |
| 通知ページ | Canvas で描いた日本語テキスト RGBA → DeviceRGB + Up + Flate（可逆） | 不透明 assert は維持 |
| タイトル行 | Helvetica / WinAnsi。日本語ファイル名の扱いは現行 jsPDF と同等の制約（未測定） | 同等性を gate で確認、改善は別課題 |
| ダウンロード | `doc.save` → `Blob` + `file-saver`（既存依存） | artifacts gate で実ダウンロードを再検証 |
| 既存 gate | `smoke-comparator*` が jsPDF 内部（`addImage_images` 等）を検査している | gate の書き換えが必要（規模の主要因） |
| Annotator / Processor / Split-Merge / Textifier | 影響なし（jsPDF 利用は comparator のみ、`MAX_OUTPUT_BYTES` は comparator 固有） | 既存 CI |

## 18. Fixture / テスト計画

- **合成コーパス**（本研究の `make-a1-corpus.mjs` を `scripts/` 側へ移植、生成物は ignore）: A1 横 3 枚（一致 / 真の変更 + 雲・三角 / 高密度 + 微小変更 69 px）、A1 縦 2 枚（数量表 一致 / 数字・罫線変更）、日本語小文字、ハッチ、寸法、細線。
- **Node gate（新）**: ①マスク → 4-bit → PDF → pdf.js デコードが `paintPair` と画素完全一致（fixture ×（72/150/300 dpi）× 許容値 0 / 0.15 mm、加えてランダムマスク・任意色・不透明度の property test）②pdf-lib / pdf.js の二重再オープン（ページ数・順序・寸法・向き・判定行）③Deflate 最悪ケースが上界内 ④Runtime ceiling で Blob/ダウンロードなし ⑤取消・ステイルランで公開なし。
- **ブラウザ gate（既存 2 本の更新）**: 実 UI から A1 150 dpi × 5 p を 1 本でダウンロード、512 MiB 既定で受理、再オープン、サイズ上界内。300 dpi × 5 p は 1 GiB で受理。
- 構造フィールドは 2 回一致、時間・RSS は MeasuredOnly。

## 19. Build / Reuse / Hybrid 推奨

**Build**（owned writer）＋ **プラットフォーム API の再利用**（`CompressionStream`）。理由:（**RF-01 で改訂 → §27**: Build = owned writer ＋ owned bounded DEFLATE）
1. 必要な PDF 機能は Image XObject・Indexed 色空間・FlateDecode + Predictor・Type1 標準フォント 1 つ・xref だけで、試作は ≈ 150 行で pdf.js / pdf-lib / PDFium が開ける。
2. どのライブラリも「圧縮済みの 4-bit Indexed ストリームを、保持も再コピーもせず、ページ単位で追記する」を素直には提供しない（jsPDF は不可、pdf-lib は全体バッファ化、pdfkit は PNG 経由）。
3. 所有することで、上界・中断・非公開の各保証を予算モデルに直接束縛できる（現行 `png.ts` が encoder を所有したのと同じ理由）。
4. 新規依存ゼロ、jsPDF（≈ 130 kB gz）を削除可能。

## 20. 推奨アーキテクチャ

```
page N:
  render members → inkMask → dilation → comparison → verdict   (不変)
  [preview のみ] paintPair → RGBA → 画面
  [ファイル]   state rows ← (refMask, otherMask, dilations) 1 行ずつ
               → 4-bit Indexed（パレット = paintPair が塗る 9 状態）
               → PNG Up 予測（/Predictor 15）
               → CompressionStream('deflate')（ストリーミング、64 行バンド）   ← RF-01 改訂: owned bounded DEFLATE（§27）
               → Runtime gate（実バイト累積 ≤ MAX_OUTPUT_BYTES）
               → Image XObject + 判定行 + Page を append-only チャンクへ
               → マスク等を解放
page N+1 ...
finish(): Pages / Catalog / xref / trailer → new Blob(chunks) → ダウンロード
中断・拒否・取消: chunks 破棄、Blob なし、型付き拒否
```

- Tiling: **不要**。writer のメモリは行幅に比例し、ページ全体のバッファを持たない。450 dpi の 1 画像 14907 × 10526 は PDF 上の制約内で、Chrome のビューアも表示した。タイル化が効くのは kernel（render 相）とリーダー側だが、前者は本件の対象外、後者は未観測の問題。
- 非可逆モード: **作らない**（§10）。

## 21. 後で変更が見込まれる Production ファイル

| ファイル | 変更 |
|---|---|
| `src/utils/comparator/pdf-writer.ts`（新規） | append-only チャンク writer、`maxBytes`、`abort` |
| `src/utils/comparator/state-raster.ts`（新規） | `statePalette`（`paintPair` から導出）、マスク → 4-bit 行、Up 予測、`CompressionStream` エンコード、上界関数 |
| `src/utils/comparator/artifacts.ts` | jsPDF sink を owned writer に置換（Comparison PDF / Change Report / 通知） |
| `src/utils/comparator/budget.ts` | `JSPDF_CONTAINER` / `jsPdfIngest` / `jsPdfRetained` を新コンテナモデル（上界、チャンク、Blob）に置換、`MEMORY_TERMS` 更新 |
| `src/utils/comparator/contract.ts` | `MAX_OUTPUT_BYTES` の意味（実行時・実バイト）とコメント、`UNSUPPORTED`（CompressionStream 不在）の使用 |
| `src/utils/comparator/png.ts` | stored PNG は不要になる（stored フォールバックの厳密サイズ関数だけ流用するか削除） |
| `src/utils/comparator/engine.ts` | `PairResult` にマスク参照を追加、ファイル成果物では `paintPair` を呼ばない、非同期 sink の await 後に取消/所有者チェック |
| `src/components/PdfComparator.tsx` | 保存を Blob ダウンロードに、見積り表示（§16）、実行時拒否の表示 |
| `scripts/smoke-comparator.mjs` + harness html、`scripts/smoke-comparator-artifacts.mjs` + harness html、`scripts/make-comparator-fixtures.mjs` | gate の書き換えと A1 fixture 追加 |
| `package.json` / `package-lock.json` | `jspdf` 削除（Change Report も移行する場合） | ← RF-02 改訂: 初回は削除しない |

## 22. 未解決事項（Human / 次段で決めること）

1. **Acrobat の手法**: 実ファイルの元版と Acrobat 版に `node research/m4-large-set-output-writer/harness/inspect-images.mjs <pdf>` を各 1 回（ローカル・読み取り専用）。結果の共有は任意。
2. **`MAX_OUTPUT_BYTES` の適用先**: 推奨は案 A「事前・上界 + 実行時・実バイト（多重防御）」。必須（150 dpi）と望ましい（300 dpi）の目標は案 A で満たせ、450 dpi は 3 ページまで。案 B「事前はメモリのみ、出力は実行時・実バイト」なら 450 dpi × 5 p も受理（§15）。
3. **Change Report を同じ PR で移すか**（推奨: 同じ PR。jsPDF と旧コンテナモデルを一度に外せる）。 → **RF-02 で解決: DEFER**（§26）
4. **`CompressionStream` 非対応環境**: `UNSUPPORTED` で拒否（推奨、対象ブラウザは全対応）か、fflate 同梱か。 → **RF-01 で解消**: 安全経路は CompressionStream に依存しない（§25）
5. **タイトル行の日本語**: 現行同等で据え置くか、改善を別課題にするか。
6. **300 dpi を 512 MiB に**入れたい場合は kernel の render 相（帯状 readback）の別課題になる。本件の範囲外。
7. **Acrobat / PDFium のリーダー側メモリ**（450 dpi 全面画像）: Chrome では表示を確認。Acrobat は未検証。

## 23. 実装規模見積り

中規模、1 PR（または Comparison PDF → Change Report の 2 段）。新規 ≈ 400–500 行（writer + state raster）、置換 ≈ 400 行（artifacts / budget / engine / UI）、gate の書き換えが最大の塊（≈ 600–900 行、既存 gate が jsPDF 内部を検査しているため）。M4 / M6 の実績から、独立レビューは複数ラウンドを見込む。

> **RF 改訂後の見積り（§27）**: Comparison PDF Output Writer v2 のみ。新規 ≈ 500–600 行（writer + state raster + owned DEFLATE）、置換 ≈ 300 行（Comparison PDF sink、budget の Comparison PDF 項、engine は変更なしでも可）、gate ≈ 500–700 行。

## 24. 前回 M4 研究（`research/m4-comparator-reliability-architecture`）との関係

前回は大規模ジョブの答えを **browser-local spool** とし、「H5（出力バイト契約）が H11（sink）を決める。圧縮エンコーダは数百ページを受理する代わりに厳密なサイズ保証を失う」として、spool を **Output Writer Sub-Spike** 条件付きの follow-on に回した。本研究の位置付け:

- **H5 の前提が変わる**: 合成画像は 9 状態なので、「圧縮」と「決定的な上界」が両立する（4-bit 行 ≈ 0.5 B/px + Deflate の構成的上界、万一は stored で出し直し）。現行の厳密サイズ（4.0006 B/px）より 8 倍小さい**上界**で、同じ「事前にすべて決まる」契約が保てる。
- **H11 は memory-resident のままでよい**: 対象ワークロード（A1 × 5 p、150–450 dpi）の実出力は 0.5–1.8 MB、上界でも 42–374 MiB で、OPFS 等の spool・ストレージ quota・orphan 回収は不要。spool は「数百ページ」級の要求が現れた時の選択肢として引き続き deferred。
- Sub-Spike が要求していた項目との対応:

| Sub-Spike 要件 | 本研究 |
|---|---|
| bounded streaming container writer | ○ append-only チャンク writer（試作）、ページ後に残るのは圧縮バイトのみ、writer 自身 +22〜44 MiB（MeasuredOnly） |
| deterministic pair and page ordering carried into the artifact | ○ 判定行 `pN: … — VERDICT` を pdf.js で全ページ照合、順序・判定一致 |
| reopen validation of page count, dimensions, orientation | ○ pdf-lib + pdf.js 二重、縦横混在 A1、全候補 |
| storage-quota preflight against a real refusal | 該当なし（spool を使わない）。代わりに出力上界の preflight と実行時上限の実拒否（ファイル不在）を実証 |
| crash and tab-close orphan recovery | 該当なし（何も永続化しない。`finish()` 前は Blob も作らない） |
| browser-local only | ○（外部送信なし、実 Chrome で canvas / CompressionStream / viewer 確認） |
| no new dependency without human approval | ○ 新規依存なし（CompressionStream はプラットフォーム API） |

---

# Focused Repair（RF-01 / RF-02）

起点 head `b9ca0ca`。エビデンス: `evidence/rf-gate-rf*.json`、`evidence/rf01-*.jsonl`、`evidence/rf02-*.json`、`evidence/rf01-model.json`。stage-1 の合成画像は再利用し、`rf-gate.mjs` が最初に `gate-g1.json`（`572ecca`）の構造値と一致することを確認してから進む（一致しなければ実行拒否）。§1–§24 の本文は歴史として残し、誇張していた箇所には改訂注記を付けた。

## 25. RF-01 — CompressionStream の安全契約

### 25.1 何が誇張だったか

- `CompressionStream('deflate')` の出力サイズの上限も、内部の作業メモリも、**Web API の契約ではない**。§14 の `zlibBound` の実測は zlib / fflate の振る舞いであり、ブラウザ実装の保証ではなかった。
- `model.mjs` の `COMPRESSOR_STATE = 4 MiB` は保守的に置いた定数で、どの仕様にも根拠がない。

### 25.2 構成で所有する上界（owned bounded DEFLATE）

`harness/owned-deflate.mjs`（≈ 200 行、依存なし）:

- 入力を 65,535 bytes のブロックに切る。各ブロックでは次を行う。
  - 字句化する。一致は距離 1（直前バイトの繰り返し）と距離 = 1 行分（真上のバイト）の 2 種類だけで、ハッシュ表を持たない。
  - 固定ハフマン符号での正確なビット数を計算し、固定ハフマンと stored の**小さい方**を出力する。
- したがって出力は `ownedDeflateBound(n) = 2 + 6·⌈n/65535⌉ + n + 4` を**構成上**超えない。`finish()` でもこの不等式を assert する。
- 作業メモリは固定: `ownedDeflateScratchBytes(L) = (L + 65535) + 65535·4 + 65536`（履歴 1 行 + 1 ブロック + トークン列 + 出力チャンク 1 つ）。ページの大きさに比例する確保はない。
- 単体テスト（`rf-gate` の `unit`、8 入力）は全件、zlib で展開して完全一致し、上界以内だった。
  - 一様乱数: 400,041 ≤ 400,048、全ブロックが stored になる。
  - 9 状態のランダム nibble: 400,013。
  - 行幅が 32 KiB 窓を超える入力（行一致なし）、ブロック境界ちょうど・+1、空入力も含む。

### 25.3 分類した安全契約

| 区分 | 内容 | 安全上の扱い |
|---|---|---|
| **OWNED**（構成で決まる） | 画像 1 枚の出力上界 `ownedDeflateBound((rowBytes+1)·h) + 4 KiB`、encoder の固定バッファ `encoderScratch`、ページ追加前の実バイト上限チェック、stored への退避 | **決定的な上界。preflight はこれだけで判定する** |
| **PRODUCTION**（既存 M4 契約） | kernel 相 `estimatePhaseMemory`、sink 中に engine が保持するマスク `engineLiveDuringSink`、`NOTICE_RASTER` | 既存のまま |
| **PLATFORM**（前提、ここでは縛らない） | フレームサイズの canvas を確保できること（Chrome 143 で 450 dpi A1 を確認）、`new Blob(chunks)` のコピーは最大 1 回 | 前提として明示する。既存 M4 と同じ扱い |
| **MEASURED**（証拠であって上界ではない） | `CompressionStream` の出力サイズとフォールバックの振る舞い、RSS・時間 | 報告のみ |

### 25.4 ガード付き platform 経路（任意の最適化）

`encodeIndexedGuarded`:

1. 4-bit 状態ラスタを `CompressionStream` に流し、出てくるバイトを数える。
2. owned 上界を超えた時点、またはストリームがエラーになった時点で、その試行を**破棄**し、同じ行を owned encoder で作り直す。
3. 部分出力は発行しない（`ChunkedPdfWriter` は `finish()` まで何も公開しない）。

故障注入の結果（150 dpi × 5 p、owned 上界 8,724,184 bytes/page）:

| セル | 結果 |
|---|---|
| `guard`（Node の実 CompressionStream） | platform、520,711 bytes、画素不一致 0 |
| `guard-expanding`（入力の 2 倍を吐くストリーム） | 全ページ owned にフォールバック、1,069,532 bytes、画素不一致 0、上界内 |
| `guard-throwing`（1 MiB 後に例外） | 全ページ owned にフォールバック、1,069,532 bytes、画素不一致 0、上界内 |

→ **CompressionStream の圧縮率が今の Chrome と違っても、あるいは失敗しても、出力の安全性は変わらない。**ただし platform 経路を使うとき、その**内部メモリは上界の外**に残る（PLATFORM 前提が 1 つ増える）。

### 25.5 A / B / C の判定

| 候補（5 p, 全ページ画素一致 0） | 150 dpi | 300 dpi | 450 dpi | writer 自身（sink-only, MeasuredOnly） | 出力上界 | メモリ上界 |
|---|---:|---:|---:|---|---|---|
| **B: owned bounded DEFLATE** | **1,069,532** | **2,842,729** | **5,166,882** | 18 / 22 / 16 MiB | owned | **owned** |
| C: CS（owned ガード付き） | 520,711 | 1,148,669 | 1,844,718 | 21 / 27 / 35 MiB（g1 の cs-up） | owned | platform 前提 |
| 参考: 現行 jsPDF | 261,549,245 | 0 byte（沈黙失敗） | 1 p で 470,736,676 | 761 MiB / — / — | — | — |

- **推奨: B**（owned compressor を安全上の権威かつ既定の経路にする）。
  - 出力もメモリも所有した算術で縛れる。
  - どのブラウザでも同じバイト列になり、gate の再現性が上がる。
  - **同期処理**なので sink を非同期化する必要がなく、engine の `onPair` 契約はそのまま使える。
  - 代償はファイルが 2〜2.8 倍になることだが、150 dpi × 5 p で 1.07 MB、現行比でも 245 分の 1。
- **C は後続の任意最適化**として温存する。ガードによって出力上界は保たれるが、内部メモリが PLATFORM 前提として予算の外に出ることを明示する。採るかどうかは Human 判断。
- **A（CS を主経路、stored を退避先）は採らない**。安全経路のメモリが非公開の実装詳細に依存するため。

### 25.6 改訂した予算モデル（`rf01-model.json`、OWNED + PRODUCTION のみ）

| | 2 members | 3 members | 4 members |
|---|---|---|---|
| 150 dpi × 5 p | 191.3 MiB / 出力上界 41.6 MiB | 249.5 / 83.3 | 307.8 / 124.9 |
| 300 dpi × 5 p | 764.9 / 166.4 | 997.7 / **332.7 (>256)** | 1,230.6 / **499.0 (>256)** |
| 450 dpi × 5 p | 1,721.0 / **374.2 (>256)** | 2,244.9 / 748.5 | 2,768.8 / 1,122.7 |

- 150 dpi は 2〜4 members の 5 ページすべてが **512 MiB** で受理され、出力上界も 256 MiB 以内。
- 300 dpi × 5 p × 2 members は **1 GiB** で受理。3 members 以上では、案 A（上界で事前判定）だと出力上界が 256 MiB を超えるため、ページ数を減らす拒否になる（3 members は 3 p まで 199.6 MiB）。
- 通知ページ（1240 × 1754 RGB）: 上界 6,531,336 bytes/枚、描画・読み戻し・エンコードのピーク 17,399,680 bytes（`rf01-model.json` の `constants`）。

## 26. RF-02 — Production 機能面の網羅（Comparison PDF）

### 26.1 方法

`harness/rf02.mjs` で、**本番の `planComparison` + `runComparison` を無改変で**実行する。Node 用の shim は 2 つだけ（`document.createElement('canvas')` → @napi-rs/canvas、`window` → globalThis とタイマー版 `requestAnimationFrame`）。

- 合成 fixture（`corpus/make-rf02-corpus.mjs`）: A4 縦 / A3 横 / A3 横 / A3 縦 / A4 横。
  - B: p1 変更、p3 を A4 にした寸法不一致、p4 変更。
  - C: p2 変更、p5 欠落。
  - D: p1・p2・p5 変更。
- 各 pair / page イベントを「候補 writer → 本番 jsPDF sink」の順に同じ実行へ分岐する。本番 sink が画素を解放するため、この順番にしている。
- 候補 writer の内容:
  - pair は 4-bit Indexed（パレットはペアごとに本番 `paintPair` から導出）を owned DEFLATE で書く。
  - 通知は本番 `drawNotice` が描いた RGBA を DeviceRGB + Up + owned DEFLATE で書く。配置は `artifacts.ts:219-220` と同じ。

### 26.2 結果（150 dpi、3 構成すべて ok）

| members | 期待順序（fixture 仕様だけから導出） = 候補の出力 | 候補 bytes | 現行 jsPDF bytes |
|---|---|---:|---:|
| 2 | p1/B/CHANGE, p2/B/MATCH, **p3/GEOMETRY_MISMATCH**, p4/B/CHANGE, p5/B/MATCH | 150,022 | 45,700,907 |
| 3 | p1/B/CHANGE, p1/C/MATCH, p2/B/MATCH, p2/C/CHANGE, **p3/GEOMETRY_MISMATCH**, p4/B/CHANGE, p4/C/MATCH, **p5/MISSING_PAGE** | 254,420 | 78,337,510 |
| 4 | p1/B,C,D (CHANGE, MATCH, CHANGE), p2/B,C,D (MATCH, CHANGE, CHANGE), **p3/GEOMETRY_MISMATCH**, p4/B,C,D (CHANGE, MATCH, MATCH), **p5/MISSING_PAGE** | 315,330 | 110,979,550 |

開き直し（pdf.js + pdf-lib）で全ページ次を満たした:

- ページ数が正確に一致。「ソースページ → slot」の順序どおり。通知はソースページの位置どおり。pair の欠落・重複なし。
- 判定行 `pN: rf02-A.pdf vs rf02-X.pdf — VERDICT` が期待と一致。
- ページ寸法が元の用紙と `72/dpi` pt 以内で一致し、向き（縦横）も一致。通知ページは 620 × 877 pt。
- **デコード画素のハッシュが engine の合成画像と一致**。さらに**同じ実行の本番 jsPDF 出力のデコード画素とも一致**（pair も通知も）。寸法・判定行・画像サイズも jsPDF 出力と一致。
- 全画像が owned 上界以内。

→ Comparison PDF の機能面（2/3/4 members、reference-pair 順序、MISSING_PAGE / GEOMETRY_MISMATCH 通知、縦横混在）で、候補 writer は現行 writer と**視覚的に同一の成果物**を出す。

### 26.3 Change Report

**A: 初回 Production から DEFER。** Change Report は既存の jsPDF 経路と既存 budget の jsPDF 項のまま据え置く。Change Report に同等のエビデンスはまだ無いので、同時移行は推奨しない。**jsPDF は削除しない**（Comparator の全成果物経路が移行するまで）。

## 27. RF 後の推奨アーキテクチャ

```
Comparison PDF Output Writer v2（初回 Production の範囲）:
  engine（無変更: plan / kernel / verdict / paintPair / onPair / onPage）
  → sink v2（同期）:
      pair   : 合成 RGBA（または将来はマスク）→ 4-bit 状態行（パレット = paintPair の 9 状態）
               → Up 予測 → owned bounded DEFLATE（固定ハフマン | stored、ブロックごと）
      notice : drawNotice RGBA → DeviceRGB → Up → owned bounded DEFLATE
      → Runtime gate（実バイト + 4 KiB ≤ MAX_OUTPUT_BYTES、超過で abort・Blob なし）
      → append-only チャンク → finish() → new Blob(chunks)
  preflight: 既存 kernel 項 + OWNED 上界（画像ごと）+ OWNED scratch、ΣB ≤ 256 MiB（案 A）
Change Report: 既存 jsPDF 経路のまま（DEFER）
CompressionStream: 使わない（後続の任意最適化 C として、owned ガード付きでのみ検討）
```

初回の実装範囲では engine を変えずに済む。候補 writer は `pair.pixels`（合成 RGBA）から索引化しても画素一致を確認済み（§26）。マスクから直接エンコードして RGBA を省く最適化（§7 の `idx4m`）は後続の選択肢。

改訂後、変更が見込まれる Production ファイル（初回）:

| ファイル | 変更 |
|---|---|
| `src/utils/comparator/pdf-writer.ts`（新規） | append-only チャンク writer、`maxBytes`、`abort` |
| `src/utils/comparator/deflate.ts`（新規） | owned bounded DEFLATE、`ownedDeflateBound`、`ownedDeflateScratchBytes` |
| `src/utils/comparator/state-raster.ts`（新規） | `statePalette`（`paintPair` から導出）、RGBA → 4-bit 行、Up 予測 |
| `src/utils/comparator/artifacts.ts` | `createComparisonPdf` だけを v2 に置換。`createChangeReport` は jsPDF のまま |
| `src/utils/comparator/budget.ts` | Comparison PDF 用の項を OWNED 上界に置換。Change Report 用の jsPDF 項は残す |
| `src/utils/comparator/contract.ts` | `MAX_OUTPUT_BYTES` の説明（事前は上界、実行時は実バイト）。値は据え置き |
| `src/components/PdfComparator.tsx` | Comparison PDF の保存を Blob に、見積り表示、実行時拒否の表示 |
| `scripts/smoke-comparator*.mjs` と各 harness | Comparison PDF 部分の検査を書き換え（Change Report 部分は残す） |

変更しないもの: `engine.ts`、`mask.ts`、`png.ts`（Change Report が引き続き使う）、`package.json`（jsPDF は残す）。

---

### 付録: 本研究のコンテキスト戦略

- Orchestrator が直接読んだもの: `src/utils/comparator/{png,budget,contract,artifacts}.ts`、`engine.ts` の該当範囲、`mask.ts` の関数シグネチャ、`PdfComparator.tsx` の色の既定値、`eslint.config.js`、CI の該当ステップ。
- subagent に委任したもの（読み取り専用）: エクスポートのライフサイクル調査（`PdfComparator.tsx`、`engine.ts`、`artifacts.ts`、`scripts/smoke-comparator*`、README）、Reuse Scan（npm / GitHub / MDN / bundlephobia、`node_modules` 内のソース）。
- Web 検索: Reuse Scan のみ（ユーザー承認済み）。外部サービスへのファイル送信: なし。
- 意図的に読まなかったもの: Annotator / Processor / Split-Merge / Textifier の内部、M6 の履歴、`.codex/review/*` の各 worktree。
