/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Identities and timestamps, in the one form the proposed schema accepts.
 *
 * `crypto.randomUUID()` is the obvious way to mint a UUID and it is not usable
 * here: like `crypto.subtle`, it exists only in a secure context, and this app
 * is also served over plain HTTP on a LAN (the reason
 * `src/utils/split-merge/digest.ts` carries its own SHA-256). `getRandomValues`
 * has no such restriction, so the UUID is built from that. The browser
 * benchmark records which of these a given context actually exposes.
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Format 16 random bytes as a version-4 UUID. */
export function uuidFromBytes(bytes) {
    const b = Uint8Array.from(bytes);
    if (b.length !== 16) throw new RangeError('a UUID is 16 bytes');
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let out = '';
    for (let i = 0; i < 16; i += 1) {
        out += HEX[b[i]];
        if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
    }
    return out;
}

/** A random UUID that does not need a secure context. */
export function randomUuid() {
    return uuidFromBytes(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * A seeded UUID source, for fixtures and benchmarks that must be reproducible.
 * Not random and never for anything a person keeps.
 */
export function seededUuidSource(seed) {
    let state = (seed >>> 0) || 1;
    const next = () => {
        // xorshift32
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5; state >>>= 0;
        return state;
    };
    return () => {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i += 4) {
            const word = next();
            bytes[i] = word >>> 24;
            bytes[i + 1] = (word >>> 16) & 0xff;
            bytes[i + 2] = (word >>> 8) & 0xff;
            bytes[i + 3] = word & 0xff;
        }
        return uuidFromBytes(bytes);
    };
}

/** Epoch milliseconds -> the schema's Timestamp. */
export const toTimestamp = (epochMs) => new Date(epochMs).toISOString();
