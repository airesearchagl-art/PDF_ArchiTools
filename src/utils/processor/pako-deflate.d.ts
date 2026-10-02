/**
 * The pako 2.1.0 `Deflate` surface Optimizer v2 depends on, written out rather
 * than taken from `@types/pako`, for the same reason M6 wrote out `Inflate`
 * (split-merge/pako-inflate.d.ts): a version change that moves any of it should
 * break the build, not the memory argument. The two declarations merge.
 *
 * Only the streaming class is declared. The one-shot `deflate()` is deliberately
 * absent: it flattens every output chunk into a second whole copy
 * (lib/deflate.js:291-296, utils/common.js:30-48), which is the copy D-028 adopted
 * streaming to avoid.
 */
declare module 'pako' {
    interface DeflateOptions {
        level?: number;
        windowBits?: number;
        memLevel?: number;
        /** Output chunk size; every full chunk is a fresh buffer (lib/deflate.js:225). */
        chunkSize?: number;
    }

    export class Deflate {
        constructor(options?: DeflateOptions);

        /** Called synchronously from inside `push`, once per output chunk. */
        onData: (chunk: Uint8Array) => void;

        /** Called once when the stream ends; replaced so nothing is flattened. */
        onEnd: (status: number) => void;

        /** Non-zero when pako stopped on an error. */
        readonly err: number;

        readonly msg: string;

        /** `final` (or Z_FINISH) ends the stream. */
        push(data: Uint8Array, final?: boolean): boolean;
    }
}
