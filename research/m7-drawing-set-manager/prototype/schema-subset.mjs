/**
 * RESEARCH ONLY / NOT PRODUCTION / NOT CANONICAL
 *
 * A small interpreter for the part of JSON Schema the proposed Portable Project
 * schema uses -- and a refusal to run anything else.
 *
 * The point of driving validation from the schema *file* is that there is then
 * one statement of the structure, and the validator, the tests and the document
 * a person reads cannot drift apart. The point of owning the interpreter is the
 * same one the repository has made before (its own SHA-256, DEFLATE, PDF
 * writer): no new dependency, no `new Function`, and every behaviour it has is
 * one this file had to state.
 *
 * It fails closed in the direction that matters. A general-purpose validator
 * ignores a keyword it does not know, which turns a typo in a constraint into
 * no constraint. `compileSchema` throws instead, so a schema that asks for
 * something this cannot enforce never gets as far as validating anything.
 *
 * Three rules go beyond "is it a valid schema", because a schema for
 * *untrusted* input has to be bounded by construction:
 *
 *   - every object states `additionalProperties: false`
 *   - every array states `maxItems`
 *   - every string states `maxLength`, `enum` or `const`
 *
 * so there is no place in an accepted document where an unbounded or unexpected
 * thing could be.
 */

export class SchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchemaError';
    }
}

export const SCHEMA_PROBLEM = Object.freeze({
    TYPE: 'SCHEMA_TYPE',
    REQUIRED: 'SCHEMA_REQUIRED',
    UNKNOWN_FIELD: 'SCHEMA_UNKNOWN_FIELD',
    ENUM: 'SCHEMA_ENUM',
    CONST: 'SCHEMA_CONST',
    PATTERN: 'SCHEMA_PATTERN',
    STRING_LENGTH: 'SCHEMA_STRING_LENGTH',
    STRING_NOT_WELL_FORMED: 'SCHEMA_STRING_NOT_WELL_FORMED',
    NUMBER_NOT_FINITE: 'SCHEMA_NUMBER_NOT_FINITE',
    NUMBER_NOT_INTEGER: 'SCHEMA_NUMBER_NOT_INTEGER',
    NUMBER_RANGE: 'SCHEMA_NUMBER_RANGE',
    ARRAY_LENGTH: 'SCHEMA_ARRAY_LENGTH',
});

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description']);
const KNOWN = new Set([
    '$ref', 'type', 'anyOf', 'enum', 'const',
    'minLength', 'maxLength', 'pattern',
    'minimum', 'maximum',
    'items', 'minItems', 'maxItems',
    'properties', 'required', 'additionalProperties',
]);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

const typeOf = (value) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
};

const pointerEscape = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');

class Run {
    constructor(maxProblems) {
        this.maxProblems = maxProblems;
        this.problems = [];
        this.path = [];
        this.full = false;
    }

    report(code, message) {
        if (this.full) return;
        this.problems.push({
            code,
            path: `/${this.path.map(pointerEscape).join('/')}`.replace(/^\/$/, ''),
            message,
        });
        if (this.problems.length >= this.maxProblems) this.full = true;
    }
}

/**
 * Compile a schema into a validator and a projector.
 *
 * `limits` supplies the value of any bound the schema marks with `x-limit`.
 * The number written in the schema file is the candidate default; `x-limit`
 * names it, so a test can inject a small one and so a check can prove the file
 * and the limits object agree.
 */
export function compileSchema(root, limits = {}) {
    if (typeOf(root) !== 'object') throw new SchemaError('schema must be an object');
    const defs = root.$defs ?? {};
    const compiled = new Map();
    const compiling = new Set();
    const limitBindings = [];

    const bound = (node, keyword, where) => {
        const literal = node[keyword];
        const name = node['x-limit'];
        if (name === undefined) return literal;
        // `x-limit` on a node names the limit behind its one size bound.
        const sizeKeywords = ['maxItems', 'maxLength', 'maximum'].filter((k) => node[k] !== undefined);
        if (sizeKeywords.length !== 1) throw new SchemaError(`${where}: x-limit needs exactly one of maxItems/maxLength/maximum`);
        if (keyword !== sizeKeywords[0]) return literal;
        limitBindings.push({ where, limit: name, keyword, literal });
        if (!Object.hasOwn(limits, name)) return literal;
        return limits[name];
    };

    const compileNode = (node, where) => {
        if (typeOf(node) !== 'object') throw new SchemaError(`${where}: schema node must be an object`);
        for (const keyword of Object.keys(node)) {
            if (ANNOTATIONS.has(keyword) || KNOWN.has(keyword) || keyword === 'x-limit') continue;
            throw new SchemaError(`${where}: unsupported keyword "${keyword}"`);
        }

        if (node.$ref !== undefined) {
            if (Object.keys(node).some((k) => k !== '$ref' && !ANNOTATIONS.has(k))) {
                throw new SchemaError(`${where}: $ref must stand alone`);
            }
            const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(node.$ref);
            if (!match) throw new SchemaError(`${where}: unsupported $ref "${node.$ref}"`);
            const name = match[1];
            if (!Object.hasOwn(defs, name)) throw new SchemaError(`${where}: unknown $ref "${node.$ref}"`);
            if (compiling.has(name)) throw new SchemaError(`${where}: recursive $ref "${node.$ref}"`);
            if (!compiled.has(name)) {
                compiling.add(name);
                compiled.set(name, compileNode(defs[name], `#/$defs/${name}`));
                compiling.delete(name);
            }
            return compiled.get(name);
        }

        if (node.anyOf !== undefined) {
            // Only one use is allowed: "this, or null".
            const branches = node.anyOf;
            if (Object.keys(node).some((k) => k !== 'anyOf' && !ANNOTATIONS.has(k))) {
                throw new SchemaError(`${where}: anyOf must stand alone`);
            }
            if (!Array.isArray(branches) || branches.length !== 2) throw new SchemaError(`${where}: anyOf must have two branches`);
            const nullIndex = branches.findIndex((b) => typeOf(b) === 'object' && b.type === 'null' && Object.keys(b).length === 1);
            if (nullIndex === -1) throw new SchemaError(`${where}: anyOf is only supported as "X or null"`);
            const inner = compileNode(branches[1 - nullIndex], `${where}/anyOf/${1 - nullIndex}`);
            return {
                kind: 'nullable',
                validate(value, run) { if (value !== null) inner.validate(value, run); },
                project(value) { return value === null ? null : inner.project(value); },
            };
        }

        const type = node.type;
        if (typeof type !== 'string' || !TYPES.has(type)) throw new SchemaError(`${where}: "type" must be one type name`);

        const hasEnum = node.enum !== undefined;
        const hasConst = node.const !== undefined;
        if (hasEnum && (!Array.isArray(node.enum) || node.enum.length === 0)) throw new SchemaError(`${where}: empty enum`);
        const enumSet = hasEnum ? new Set(node.enum) : null;

        const checkChoice = (value, run) => {
            if (hasConst && value !== node.const) { run.report(SCHEMA_PROBLEM.CONST, `must be ${JSON.stringify(node.const)}`); return false; }
            if (enumSet && !enumSet.has(value)) { run.report(SCHEMA_PROBLEM.ENUM, 'not an allowed value'); return false; }
            return true;
        };

        if (type === 'null' || type === 'boolean') {
            return {
                kind: type,
                validate(value, run) {
                    if (typeOf(value) !== type) { run.report(SCHEMA_PROBLEM.TYPE, `expected ${type}`); return; }
                    checkChoice(value, run);
                },
                project: (value) => value,
            };
        }

        if (type === 'string') {
            const maxLength = bound(node, 'maxLength', where);
            const minLength = node.minLength ?? 0;
            if (maxLength === undefined && !hasEnum && !hasConst) throw new SchemaError(`${where}: a string needs maxLength, enum or const`);
            let pattern = null;
            if (node.pattern !== undefined) {
                try { pattern = new RegExp(node.pattern, 'u'); } catch { throw new SchemaError(`${where}: bad pattern`); }
            }
            return {
                kind: 'string',
                validate(value, run) {
                    if (typeof value !== 'string') { run.report(SCHEMA_PROBLEM.TYPE, 'expected string'); return; }
                    // Length first: nothing below is allowed to look at an over-long string.
                    if (maxLength !== undefined && value.length > maxLength) { run.report(SCHEMA_PROBLEM.STRING_LENGTH, `longer than ${maxLength}`); return; }
                    if (value.length < minLength) { run.report(SCHEMA_PROBLEM.STRING_LENGTH, `shorter than ${minLength}`); return; }
                    if (!value.isWellFormed()) { run.report(SCHEMA_PROBLEM.STRING_NOT_WELL_FORMED, 'lone surrogate'); return; }
                    if (!checkChoice(value, run)) return;
                    if (pattern && !pattern.test(value)) run.report(SCHEMA_PROBLEM.PATTERN, 'does not match the required form');
                },
                project: (value) => value,
            };
        }

        if (type === 'integer' || type === 'number') {
            const maximum = bound(node, 'maximum', where);
            const minimum = node.minimum;
            if (maximum === undefined || minimum === undefined) throw new SchemaError(`${where}: a number needs minimum and maximum`);
            return {
                kind: type,
                validate(value, run) {
                    if (typeof value !== 'number') { run.report(SCHEMA_PROBLEM.TYPE, `expected ${type}`); return; }
                    // JSON.parse turns 1e400 into Infinity without complaint.
                    if (!Number.isFinite(value)) { run.report(SCHEMA_PROBLEM.NUMBER_NOT_FINITE, 'not a finite number'); return; }
                    if (type === 'integer' && !Number.isSafeInteger(value)) { run.report(SCHEMA_PROBLEM.NUMBER_NOT_INTEGER, 'not a safe integer'); return; }
                    if (value < minimum || value > maximum) { run.report(SCHEMA_PROBLEM.NUMBER_RANGE, `outside ${minimum}..${maximum}`); return; }
                    checkChoice(value, run);
                },
                project: (value) => value,
            };
        }

        if (type === 'array') {
            const maxItems = bound(node, 'maxItems', where);
            const minItems = node.minItems ?? 0;
            if (maxItems === undefined) throw new SchemaError(`${where}: an array needs maxItems`);
            if (node.items === undefined) throw new SchemaError(`${where}: an array needs items`);
            const items = compileNode(node.items, `${where}/items`);
            return {
                kind: 'array',
                validate(value, run) {
                    if (!Array.isArray(value)) { run.report(SCHEMA_PROBLEM.TYPE, 'expected array'); return; }
                    // Refuse the length before walking: an over-long array is never iterated.
                    if (value.length > maxItems) { run.report(SCHEMA_PROBLEM.ARRAY_LENGTH, `more than ${maxItems} items`); return; }
                    if (value.length < minItems) { run.report(SCHEMA_PROBLEM.ARRAY_LENGTH, `fewer than ${minItems} items`); return; }
                    for (let i = 0; i < value.length && !run.full; i += 1) {
                        run.path.push(i);
                        items.validate(value[i], run);
                        run.path.pop();
                    }
                },
                project: (value) => (Array.isArray(value) ? value.map((item) => items.project(item)) : value),
            };
        }

        // object
        if (node.additionalProperties !== false) throw new SchemaError(`${where}: an object needs additionalProperties: false`);
        const propertyNodes = node.properties ?? {};
        const names = Object.keys(propertyNodes);
        const properties = new Map(names.map((name) => [name, compileNode(propertyNodes[name], `${where}/properties/${name}`)]));
        const required = node.required ?? [];
        for (const name of required) {
            if (!properties.has(name)) throw new SchemaError(`${where}: required "${name}" is not a declared property`);
        }
        return {
            kind: 'object',
            validate(value, run) {
                if (typeOf(value) !== 'object') { run.report(SCHEMA_PROBLEM.TYPE, 'expected object'); return; }
                for (const name of required) {
                    if (!Object.hasOwn(value, name)) {
                        run.path.push(name);
                        run.report(SCHEMA_PROBLEM.REQUIRED, 'required field is missing');
                        run.path.pop();
                    }
                }
                // Own keys only, and looked up in a Map: "__proto__" and
                // "constructor" are just two more names that are not declared.
                for (const name of Object.keys(value)) {
                    if (run.full) return;
                    const property = properties.get(name);
                    run.path.push(name);
                    if (!property) run.report(SCHEMA_PROBLEM.UNKNOWN_FIELD, 'field is not part of this schema version');
                    else property.validate(value[name], run);
                    run.path.pop();
                }
            },
            project(value) {
                // Declared properties, in declared order, and nothing else: this
                // is what makes the writer an allow-list.
                if (typeOf(value) !== 'object') return value;
                const out = {};
                for (const name of names) {
                    if (Object.hasOwn(value, name) && value[name] !== undefined) out[name] = properties.get(name).project(value[name]);
                }
                return out;
            },
        };
    };

    const top = compileNode(root, '#');
    return {
        /** Every problem found, up to `maxProblems`. Empty means the value conforms. */
        validate(value, maxProblems = 20) {
            const run = new Run(maxProblems);
            top.validate(value, run);
            return run.problems;
        },
        /** A fresh copy holding only what the schema declares, in schema order. */
        project: (value) => top.project(value),
        /** Which schema bounds are tied to which named limit, for the binding test. */
        limitBindings,
    };
}
