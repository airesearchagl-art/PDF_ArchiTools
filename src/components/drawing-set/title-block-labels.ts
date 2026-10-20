/**
 * The words the 図面管理 screen uses for title blocks (M7-P2-B2).
 *
 * Kept apart from the Source's binding (SHA-256一致 and the rest), which is
 * about bytes only: none of these says the drawing is right, and none uses
 * 確認済み, 正しい, 承認 or 検証済み.
 */
import type { RecordCurrency } from '../../utils/drawing-set/currency';
import { currencyLabel } from '../../utils/drawing-set/currency';
import type { FieldName, FieldSource, TransferModel } from '../../utils/drawing-set/model';

export const FIELD_LABEL: Record<FieldName, string> = {
    drawingNumber: '図面番号',
    drawingTitle: '図面名称',
    revision: '版',
    issueDate: '日付',
};

export const TRANSFER_LABEL: Record<TransferModel, { text: string; title: string }> = {
    normalised: { text: '用紙の大きさに比例', title: '用紙の大きさが違うページでは、範囲を用紙に合わせて拡大・縮小します。' },
    'corner-anchored': { text: '右下の角から実寸で固定', title: '用紙の大きさが違うページでも、範囲の大きさと右下の角からの距離を変えません（大きさが決まった表題欄向け）。' },
};

/** How the machine got a field: from the observation only, never "typed". */
export const METHOD_LABEL: Record<FieldSource, { text: string; title: string }> = {
    native: { text: 'PDFの文字', title: 'PDFに含まれている文字情報から読み取りました。' },
    ocr: { text: 'OCR', title: 'ページの画像から文字認識（OCR）で読み取りました。' },
    none: { text: '読み取れず', title: 'この範囲からは文字を読み取れませんでした。' },
};

export type Tone = 'none' | 'current' | 'unverified' | 'stale';
export type CurrencyText = { text: string; title: string; tone: Tone };

const OBSERVATION: Record<ReturnType<typeof currencyLabel>, CurrencyText> = {
    NONE: { text: '未読み取り', title: 'このページの表題欄はまだ読み取っていません。', tone: 'none' },
    CURRENT: { text: '読み取り値あり', title: '機械が読み取った値です。人が確定するまで、確定値ではありません。', tone: 'current' },
    UNVERIFIED: { text: '読み取り値あり（ファイル未照合）', title: '読み取ったときのファイルと同じ内容か、この画面でまだ確かめられていません。', tone: 'unverified' },
    STALE_PROFILE: { text: '読み直しが必要（プロファイル変更）', title: '読み取った後でプロファイルの範囲や割り当てが変わりました。読み取りをやり直してください。', tone: 'stale' },
    STALE_SOURCE: { text: '読み直しが必要（ファイル変更）', title: '読み取った後でファイルの内容が変わりました。', tone: 'stale' },
    STALE_SOURCE_AND_PROFILE: { text: '読み直しが必要', title: '読み取った後でファイルとプロファイルが変わりました。', tone: 'stale' },
};

const CONFIRMATION: Record<ReturnType<typeof currencyLabel>, CurrencyText> = {
    NONE: { text: '未確定', title: 'このページの値はまだ人が確定していません。', tone: 'none' },
    CURRENT: { text: '確定', title: '人が原図と照らして確定した値です（図面の内容を保証するものではありません）。', tone: 'current' },
    UNVERIFIED: { text: '確定（ファイル未照合）', title: '確定したときのファイルと同じ内容か、この画面でまだ確かめられていません。', tone: 'unverified' },
    STALE_PROFILE: { text: '以前の確定（再確定が必要）', title: '確定した後でプロファイルが変わりました。以前の確定として残っています。', tone: 'stale' },
    STALE_SOURCE: { text: '以前の確定（再確定が必要）', title: '確定した後でファイルの内容が変わりました。以前の確定として残っています。', tone: 'stale' },
    STALE_SOURCE_AND_PROFILE: { text: '以前の確定（再確定が必要）', title: '確定した後でファイルとプロファイルが変わりました。以前の確定として残っています。', tone: 'stale' },
};

export const observationText = (currency: RecordCurrency): CurrencyText => OBSERVATION[currencyLabel(currency)];
export const confirmationText = (currency: RecordCurrency): CurrencyText => CONFIRMATION[currencyLabel(currency)];
