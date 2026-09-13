/**
 * The Processor's orchestration layer.
 *
 * One facts step, one planner, one budget and one ownership token for every
 * operation — including the two hardened lanes, which keep their own
 * implementations and only gain the preflight. H11 adopted this shape for a
 * plain reason: the five legacy operations had five different ideas about what
 * "it worked" meant, and each one had to be fixed separately because nothing
 * was shared.
 */
export * from './contracts';
export * from './source-facts';
export * from './planner';
export * from './ownership';
export * from './metadata';
export * from './batch';
export {
    MAX_RASTER_PIXELS,
    MAX_OUTPUT_BYTES,
    MEMORY_PRESETS,
    DEFAULT_MEMORY_BUDGET,
    PAKO,
    PAKO_STATE_BYTES,
    deflateUpperBound,
    deflateWorkingBytes,
    pageCost,
    fileCost,
    preservingFileCost,
    PRESERVING_SLACK_BYTES,
    EMBEDDED_FONT_ALLOWANCE_BYTES,
    batchCost,
    checkCeilings,
    checkActualOutput,
    defaultCeilings,
    ceilingsFromSearch,
    worstCaseEntryOverhead,
    entryNameBytes,
    needsUnicodePath,
    unicodePathExtraBytes,
    zipEntryOverhead,
    ZIP_LOCAL_HEADER_BYTES,
    ZIP_CENTRAL_RECORD_BYTES,
    ZIP_END_OF_DIRECTORY_BYTES,
    MANIFEST_NAME,
    MAX_ENTRY_NAME_BYTES,
    pagePixels,
    COMPONENTS,
} from './budget';
export type { Ceilings, ColourSpace, StreamFilter, PageCost, BatchEntry, MemoryPreset } from './budget';
export {
    drawFullPageImage,
    probeCanvasAllocation,
    releaseCanvas,
    rgbaToGray,
    rgbaToRgb,
    samplesFromCanvas,
} from './raster-xobject';
export { marginInPlace } from './margin-transform';
export type { MarginOptions } from './margin-transform';
export {
    runFlatten,
    runLayer,
    runOptimizeLossless,
    runMargin,
    runBoth,
    readbackMetadata,
    pageCountOf,
    rotationsOf,
} from './runners';
export type { FlattenSettings, LayerSettings } from './runners';
