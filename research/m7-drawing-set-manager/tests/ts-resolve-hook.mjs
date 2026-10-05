/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * Lets a research test import a Production TypeScript module read-only.
 *
 * Node strips the types by itself. What it will not do is what the bundler
 * does for the app: resolve `./drawing-register-types` to the `.ts` file next
 * door. This hook adds exactly that, for relative imports made from inside
 * `src/`, and nothing else. It changes no file and is loaded only by the test
 * that needs it.
 */

import { registerHooks } from 'node:module';

registerHooks({
    resolve(specifier, context, nextResolve) {
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
