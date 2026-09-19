/**
 * The exact pako surface M6's Load Boundary depends on, written out rather than
 * taken from `@types/pako`.
 *
 * Two reasons this file exists instead of another dependency:
 *
 * 1. H11-B3-3 binds the boundary's evidence to **pako 2.1.0**. The surface below
 *    is what B3 actually exercised, so a version change that moves any of it
 *    breaks the build rather than the safety argument — which is the direction
 *    the version contract wants the failure to point.
 * 2. `strm.next_in` is **not part of pako's documented API**. It is read to
 *    record how much compressed input was consumed before a bounded decode was
 *    abandoned, which is the evidence that the decode really stopped early.
 *    Declaring it here makes that dependency explicit instead of leaving it to a
 *    community type definition that never promised it.
 *
 * Nothing else from pako is used. Deflate, gzip and the functional API are
 * deliberately absent.
 */
declare module 'pako' {
    interface InflateOptions {
        /**
         * Output chunk size. Not a safety limit: it is what decides how far past
         * a cap a refused decode may materialise, which is cap + one chunk.
         */
        chunkSize?: number;
        raw?: boolean;
        to?: 'string';
        windowBits?: number;
    }

    /** The zlib stream state. Internal to pako; see the note above. */
    interface ZStream {
        /** Compressed bytes consumed so far. */
        next_in: number;
        /** Decoded bytes produced so far. */
        total_out: number;
    }

    export class Inflate {
        constructor(options?: InflateOptions);

        /** Called synchronously from inside `push`, once per output chunk. */
        onData: (chunk: Uint8Array) => void;

        /** True once the compressed stream has ended cleanly. */
        readonly ended: boolean;

        /** Non-zero when pako stopped on an error. */
        readonly err: number;

        /** The error text, when `err` is non-zero. */
        readonly msg: string;

        readonly strm: ZStream;

        /** Decode. `final` marks the last (here, the only) input chunk. */
        push(data: Uint8Array, final?: boolean): boolean;
    }

    export function inflate(data: Uint8Array, options?: InflateOptions): Uint8Array;
}
