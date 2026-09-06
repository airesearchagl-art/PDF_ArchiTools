/**
 * Types for native table reconstruction.
 *
 * Everything here works in *upright page space*: origin top-left of the page as
 * it would be without its /Rotate, y downwards, PDF points at scale 1. Tokens,
 * ruling lines and the user's selection are all converted into that one space
 * before anything is reconstructed, because a grid found in one space and a
 * rectangle drawn in another do not describe the same table.
 */

/** One run of text from the page, with where it actually sits. */
export interface TableToken {
    text: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    /** Glyph width and height along the text's own directions, in points. */
    width: number;
    height: number;
    /** Unit vector the run reads along, in upright space. */
    direction: { x: number; y: number };
}

/** One axis-aligned ruling line recovered from the page's vector content. */
export interface RulingSegment {
    orientation: 'h' | 'v';
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    length: number;
}

export interface SelectionRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Everything one page offers a table reconstructor. */
export interface PageGeometry {
    pageNumber: number;
    /** The page's own /Rotate, kept so a caller can map back for display. */
    rotate: number;
    /** Size of the page as displayed, i.e. after rotation. */
    displayWidth: number;
    displayHeight: number;
    /** Size of the page upright, which is the space below. */
    uprightWidth: number;
    uprightHeight: number;
    tokens: TableToken[];
    segments: RulingSegment[];
    /**
     * True when the pipeline's own classifier calls this page scanned.
     *
     * Not "no text was found". A scanned sheet often keeps a page number or a
     * drawing-number stamp as vector text in the margin, and that must not make
     * the raster drawing a native page. When this is true, `tokens` is empty by
     * construction, so nothing can be reconstructed from marginal text.
     */
    scanned: boolean;
    /** Characters found anywhere on the page, margin included. */
    allChars: number;
    /** Characters found inside the content region, which is what decides. */
    interiorChars: number;
}

/**
 * How a reconstruction turned out.
 *
 * Every one of these names describes *structure*, and none of them describes
 * meaning. A title block, a legend and two columns of notes all produce sound
 * grids, because structurally they are grids -- so a high structural score is
 * never a statement that the selection was a table, and never a reason to skip
 * the user's confirmation.
 */
export type TableStatus =
    /** A closed grid, consistently filled. Still needs confirming. */
    | 'GRID_CONFIDENT'
    /** Structure found, but boundaries or fill are uneven. */
    | 'GRID_NEEDS_REVIEW'
    /** Nothing table-shaped in the selection. */
    | 'NO_GRID'
    /** Too few rows or columns to be a grid at all. */
    | 'UNSUPPORTED_LAYOUT'
    /** The selection covers more than one plausible grid. */
    | 'AMBIGUOUS_SELECTION'
    /** More tokens in the selection than the bounded search will look at. */
    | 'TOO_DENSE';

/** Which signal produced a grid. */
export type TableSource = 'ruling' | 'geometry';

/** A reconstructed grid, before anyone has looked at it. */
export interface TableCandidate {
    status: TableStatus;
    source: TableSource | null;
    rows: number;
    cols: number;
    /** Row-major cell text. An empty string is a cell that is genuinely empty. */
    grid: string[][];
    /** Where the grid sits in upright space. */
    bbox: SelectionRect;
    /**
     * Structural score, 0-100. How well the grid holds together -- nothing
     * about whether its contents are a schedule.
     */
    structureScore: number;
    /** Set when the status carries something the user needs to be told. */
    message?: string;
    /** How much work the reconstruction did, for the gates to assert on. */
    stats: {
        tokensInSelection: number;
        segmentsConsidered: number;
        yields: number;
        ms: number;
    };
}

/** A candidate the user has looked at, edited and accepted. */
export interface ConfirmedTable {
    id: string;
    pageNumber: number;
    sheetName: string;
    rows: number;
    cols: number;
    grid: string[][];
    source: TableSource | null;
    status: TableStatus;
    structureScore: number;
}

export interface TableReconstructOptions {
    /**
     * Upper bound on the tokens the geometry fallback will consider.
     *
     * The research spike measured the unbounded geometry route at about two
     * seconds for twenty thousand tokens, on the main thread. A dense selection
     * is refused rather than truncated: half a table silently reconstructed is
     * worse than a message saying the selection is too dense.
     */
    maxGeometryTokens?: number;
    /** Polled at every yield boundary; true abandons the run. */
    shouldCancel?: () => boolean;
}
