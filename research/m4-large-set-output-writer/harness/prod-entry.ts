// Production comparator modules, bundled unmodified for the Node harness.
export * from '../../../src/utils/comparator/mask';
export * from '../../../src/utils/comparator/png';
export * from '../../../src/utils/comparator/budget';
export * from '../../../src/utils/comparator/contract';
export {
    paintPair, verdictFor, changeBounds, planComparison, runComparison, renderCanonicalFrame,
} from '../../../src/utils/comparator/engine';
export {
    createComparisonPdf, containerVersion, drawNotice, noticeLines,
} from '../../../src/utils/comparator/artifacts';
