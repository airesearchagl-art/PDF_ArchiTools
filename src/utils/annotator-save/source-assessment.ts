/**
 * Whether a source document may be saved at all.
 *
 * Preserving the source is the non-negotiable half of this feature, and there
 * are files that cannot be honoured. A signature is the sharp case: saving
 * re-serialises the document, which invalidates any signature over it. Writing
 * that file and reporting success is the worst kind of preservation failure —
 * the document still looks signed and is not.
 *
 * These are refused before anything is written, by name.
 */
import { PDFDocument } from 'pdf-lib';
import type { SaveProblem } from './types';

const SIGNATURE_UNCHECKABLE = 'このPDFのフォーム情報を読み取れなかったため、'
    + '電子署名の有無を確認できませんでした。確認できない状態では保存しません。';

export interface SourceVerdict {
    supported: boolean;
    problems: SaveProblem[];
    signatureFields: string[];
    doc: PDFDocument | null;
}

/**
 * A PDFName for a key, built through the document's own context.
 *
 * pdf-lib's `PDFName` is not imported here on purpose: going through the
 * context means this works against whatever build the caller already loaded.
 */
function nameFor(doc: PDFDocument, key: string): unknown {
    return (doc.context.obj({ [key]: 0 }) as unknown as { keys(): unknown[] }).keys()[0];
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

    // A signature lives in the AcroForm as a field whose /FT is /Sig.
    //
    // Being unable to read the form is **not** evidence that there is no
    // signature — it is evidence that the question could not be asked. Catching
    // that and carrying on would turn "we could not check" into "there is
    // nothing to check", so it refuses instead. The field types and the raw
    // dictionaries are both inspected, because a constructor name is a property
    // of the library build rather than of the document.
    const signatureFields: string[] = [];
    try {
        const form = doc.getForm();
        for (const field of form.getFields()) {
            const name = field.getName();
            if (/Signature/i.test(field.constructor.name)) {
                signatureFields.push(name);
                continue;
            }
            const dict = (field as unknown as {
                acroField?: { dict?: { get?: (k: unknown) => unknown } };
            }).acroField?.dict;
            const ft = dict?.get?.(nameFor(doc, 'FT'));
            const ftName = (ft as { asString?: () => string })?.asString
                ? (ft as { asString: () => string }).asString()
                : String(ft ?? '');
            if (ftName === '/Sig') signatureFields.push(name);
        }
        const acro = (form as unknown as {
            acroForm?: { dict?: { get?: (k: unknown) => unknown } };
        }).acroForm?.dict;
        const sigFlags = acro?.get?.(nameFor(doc, 'SigFlags'));
        if (sigFlags !== undefined && signatureFields.length === 0) {
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
