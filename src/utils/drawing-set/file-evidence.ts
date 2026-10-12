/**
 * Evidence that a File's bytes were read here and what they hash to.
 *
 * A runtime binding of MATCHED says that the File this session holds for a
 * Source has exactly the Source's fingerprinted bytes (semantic contract §B:
 * SHA-256 equality is the only path to MATCHED). Saying so must cost a read of
 * those bytes. So the only thing the ledger takes as proof is a FileDigest,
 * and the only way to get one is to have this module read a File and hash it:
 *
 *  - readFileDigest() reads the File in bounded chunks through the
 *    fingerprint Worker (fingerprint-client.ts), and only once the Worker has
 *    confirmed the digest of exactly `file.size` bytes does it issue a
 *    FileDigest -- a frozen object recorded, with the File it was read from,
 *    in a registry no other module can write to.
 *  - The fields on the object are for reading. What a digest attests is what
 *    the registry recorded when it was issued: an object built by hand, or one
 *    copied, cast or frozen to look like a digest, is not in the registry and
 *    attests nothing. There is deliberately no function that issues a digest
 *    for a SHA-256 someone states, for a File that was not read, or "for a
 *    test".
 *  - Each digest records which session it was read for (its scope), the File
 *    object it was read from, and when the read began on one clock shared
 *    with the ledger (evidenceTick), so the ledger can refuse one that is
 *    about another session, another File, or a File presented again since.
 *  - A digest is spent the first time it is offered to a ledger, whatever the
 *    answer, so one read cannot vouch twice.
 *
 * Nothing here is stored or sent anywhere, and nothing about a File's content
 * is kept beyond its SHA-256 and length. The registry holds the File object
 * only as long as the digest itself is held.
 *
 * What this does not defend against is code that already controls the page --
 * replacing Worker, Blob or PDF.js itself -- nor a Blob that serves other
 * bytes the next time it is read: a digest is of the bytes as read then, and
 * every later use of the File (the preview, extraction) reads and checks them
 * again. That is outside what any module of the page can enforce. It does make
 * sure that no path through the app's own modules turns a claim into evidence.
 */
import type { FingerprintIntoBufferOptions } from './fingerprint-client';
import { fingerprintBlob } from './fingerprint-client';
import type { Sha256Hex, Uuid } from './model';

declare const fileDigestBrand: unique symbol;

/**
 * What one read of one File found. Opaque: its fields can be read, but only
 * the registry says whether it is real.
 */
export interface FileDigest {
    readonly [fileDigestBrand]: 'FileDigest';
    readonly sha256: Sha256Hex;
    readonly byteLength: number;
}

/** What the registry recorded for a digest when it was issued. */
export interface DigestRecord {
    /** The File (or Blob) whose bytes were read. */
    readonly file: Blob;
    readonly sha256: Sha256Hex;
    readonly byteLength: number;
    /** The session the read was made for (its Drawing Set id); null for none. */
    readonly scope: Uuid | null;
    /** evidenceTick() at the moment the read began. */
    readonly readStartedAt: number;
}

interface Issued extends DigestRecord {
    spent: boolean;
}

const issued = new WeakMap<object, Issued>();

let clock = 0;

/**
 * One step of the clock that orders reads, presentations and checks. Every
 * call returns a larger number than every call before it. It issues nothing.
 */
export const evidenceTick = (): number => {
    clock += 1;
    return clock;
};

export interface ReadFileDigestOptions extends FingerprintIntoBufferOptions {
    /** The session (Drawing Set id) this read is made for. */
    scope: Uuid | null;
}

/**
 * Read `file` -- into `target` when the caller is going to use the bytes,
 * otherwise only through the Worker -- and issue the digest of exactly those
 * bytes. Throws as fingerprintIntoBuffer does; a read that fails or is
 * cancelled issues nothing.
 */
export async function readFileDigest(file: Blob, target: Uint8Array | null, options: ReadFileDigestOptions): Promise<FileDigest> {
    const readStartedAt = evidenceTick();
    // The byte count the Worker confirmed, not the File's size asked again.
    const { sha256, byteLength } = await fingerprintBlob(file, target, options);
    const digest = Object.freeze({ sha256, byteLength }) as unknown as FileDigest;
    issued.set(digest, { file, sha256, byteLength, scope: options.scope, readStartedAt, spent: false });
    return digest;
}

/** What a digest attests, if this module issued it. Does not spend it. */
export function inspectFileDigest(digest: unknown): DigestRecord | null {
    if (digest === null || typeof digest !== 'object') return null;
    const record = issued.get(digest);
    if (!record) return null;
    const { file, sha256, byteLength, scope, readStartedAt } = record;
    return { file, sha256, byteLength, scope, readStartedAt };
}

/**
 * Spend a digest: what it attests, and whether it had been spent before this
 * call. Null when this module never issued it. After this call it is spent.
 */
export function spendFileDigest(digest: unknown): { record: DigestRecord; alreadySpent: boolean } | null {
    if (digest === null || typeof digest !== 'object') return null;
    const record = issued.get(digest);
    if (!record) return null;
    const alreadySpent = record.spent;
    record.spent = true;
    const { file, sha256, byteLength, scope, readStartedAt } = record;
    return { record: { file, sha256, byteLength, scope, readStartedAt }, alreadySpent };
}
