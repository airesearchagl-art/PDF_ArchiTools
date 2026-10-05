/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Lets a research test import a Production TypeScript module read-only.
 *
 * Node strips the types by itself. What it will not do is what the bundler
 * does for the app: resolve `./drawing-register-types` to the `.ts` file next
 * door. This hook adds exactly that, for relative imports made from inside
 * `src/`. It also points `pdfjs-dist`, when a Production module asks for it, at
 * PDF.js's own `legacy` build -- the build PDF.js ships for Node, which loads
 * without a DOM. The table engine's pure functions sit in a module graph that
 * imports PDF.js, and this is what lets them be called on plain data here. It
 * changes no file and is loaded only by the tests that need it.
 */

import { registerHooks } from 'node:module';

registerHooks({
    resolve(specifier, context, nextResolve) {
        const fromProduction = typeof context.parentURL === 'string' && context.parentURL.includes('/src/');
        if (fromProduction && specifier === 'pdfjs-dist') return nextResolve('pdfjs-dist/legacy/build/pdf.mjs', context);
        try {
            return nextResolve(specifier, context);
        } catch (error) {
            const relative = specifier.startsWith('./') || specifier.startsWith('../');
            const fromSrc = typeof context.parentURL === 'string' && context.parentURL.includes('/src/');
            if (relative && fromSrc && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
            throw error;
        }
    },
});
