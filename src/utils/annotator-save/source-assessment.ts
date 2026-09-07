/**
 * Whether a source document may be saved at all.
 *
 * Preserving the source is the non-negotiable half of this feature, and there
 * are files that cannot be honoured. A signature is the sharp case: saving
 * re-serialises the document, which invalidates any signature over it. Writing
 * that file and reporting success is the worst kind of preservation failure —
 * the document still looks signed and is not.
 *
 * **This inspection must not itself modify the document.** That is not a
 * theoretical worry: in pdf-lib 1.17.1 `getForm()` is not read-only. It routes
 * through `getOrCreateForm()`, so a document with no AcroForm *gains an empty
 * one* merely by being looked at, and it calls `deleteXFA()` on anything
 * carrying XFA form data — destroying it before a single byte is written. Both
 * were measured against the exact pinned version.
 *
 * So the catalog is read at the dictionary level first, and `getForm()` is only
 * reached once an ordinary, non-XFA AcroForm is known to be there already.
 */
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import type { SaveProblem } from './types';

const SIGNATURE_UNCHECKABLE = 'このPDFのフォーム情報を読み取れなかったため、'
    + '電子署名の有無を確認できませんでした。確認できない状態では保存しません。';

const XFA_UNSUPPORTED = 'このPDFには現在安全に保持できないXFAフォームが含まれているため、'
    + '注釈付きPDFとして保存できません。元のフォーム情報を保護するため処理を中止しました。';

export interface SourceVerdict {
    supported: boolean;
    problems: SaveProblem[];
    signatureFields: string[];
    doc: PDFDocument | null;
}

export async function assessSource(bytes: Uint8Array): Promise<SourceVerdict> {
    const problems: SaveProblem[] = [];
    let doc: PDFDocument;

    try {
        doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        problems.push(/encrypt/i.test(message)
            ? { code: 'encrypted', message: 'パスワード保護されたPDFは、現在この方式では保存できません。' }
            : { code: 'unreadable', message: 'このPDFを読み取れませんでした。', detail: message });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    if (doc.isEncrypted) {
        problems.push({
            code: 'encrypted',
            message: 'パスワード保護されたPDFは、現在この方式では保存できません。',
        });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    // Loading is not the same as being usable. A file whose cross-reference
    // region is damaged can parse far enough for `load` to return and then fail
    // in the middle of a save — the worst place to find out, with half the
    // pages written and an error naming an internal property. So every page is
    // opened and measured here, before anything is produced.
    try {
        const pages = doc.getPages();
        if (pages.length === 0) throw new Error('この文書にはページがありません。');
        for (const page of pages) {
            const media = page.getMediaBox();
            page.getCropBox();
            page.getRotation();
            if (!(media.width > 0 && media.height > 0)) {
                throw new Error('ページサイズを読み取れませんでした。');
            }
        }
    } catch (error) {
        problems.push({
            code: 'unreadable',
            message: 'このPDFの内容を読み取れませんでした。',
            detail: String((error as Error)?.message ?? error),
        });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    // ---- the form, read rather than created --------------------------------
    let acroForm: PDFDict | undefined;
    try {
        const raw = doc.catalog.get(PDFName.of('AcroForm'));
        if (raw !== undefined) {
            const resolved = doc.catalog.lookup(PDFName.of('AcroForm'));
            if (!(resolved instanceof PDFDict)) {
                throw new Error('AcroForm is not a dictionary');
            }
            acroForm = resolved;
        }
    } catch (error) {
        problems.push({
            code: 'form-unreadable',
            message: SIGNATURE_UNCHECKABLE,
            detail: String((error as Error)?.message ?? error),
        });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    // No AcroForm at all. There is nothing to inspect and nothing to sign, and
    // — importantly — nothing is created by having looked.
    if (!acroForm) {
        return { supported: true, problems, signatureFields: [], doc };
    }

    // XFA is form data pdf-lib cannot read or write, and its own `getForm()`
    // deletes it rather than failing. Losing a document's forms to a save that
    // reports success is exactly the preservation failure this boundary exists
    // to prevent, so it refuses instead.
    if (acroForm.get(PDFName.of('XFA')) !== undefined) {
        problems.push({ code: 'xfa-unsupported', message: XFA_UNSUPPORTED });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    // An ordinary AcroForm that already exists and has no XFA: `getForm()` has
    // nothing left to create or delete, so it is safe to traverse the fields
    // with it.
    const signatureFields: string[] = [];
    try {
        const form = doc.getForm();
        for (const field of form.getFields()) {
            const name = field.getName();
            if (/Signature/i.test(field.constructor.name)) {
                signatureFields.push(name);
                continue;
            }
            // A constructor name is a property of the library build, not of the
            // document, so the dictionary is checked too.
            const dict = (field as unknown as {
                acroField?: { dict?: { get?: (k: PDFName) => unknown } };
            }).acroField?.dict;
            const ft = dict?.get?.(PDFName.of('FT'));
            const ftName = (ft as { asString?: () => string })?.asString
                ? (ft as { asString: () => string }).asString()
                : String(ft ?? '');
            if (ftName === '/Sig') signatureFields.push(name);
        }
        if (acroForm.get(PDFName.of('SigFlags')) !== undefined && signatureFields.length === 0) {
            signatureFields.push('(SigFlags set)');
        }
    } catch (error) {
        problems.push({
            code: 'form-unreadable',
            message: SIGNATURE_UNCHECKABLE,
            detail: String((error as Error)?.message ?? error),
        });
        return { supported: false, problems, signatureFields: [], doc: null };
    }

    if (signatureFields.length > 0) {
        problems.push({
            code: 'signed',
            message: '電子署名付きPDFは、保存すると署名が無効になるため、現在は処理できません。',
        });
    }

    return { supported: problems.length === 0, problems, signatureFields, doc };
}
