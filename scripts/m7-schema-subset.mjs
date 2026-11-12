// ---------------------------------------------------------------------------
// A small draft-07 subset interpreter, for the M7 tests only. It refuses to run
// against a schema that uses a keyword it does not implement, so it cannot
// pass something by not understanding it. Moved unchanged out of
// scripts/smoke-m7-p1.mjs so the M7-P3 gate (smoke-m7-p3-qa.mjs) checks with
// the same code.
// ---------------------------------------------------------------------------
export const SUPPORTED = new Set([
    '$schema', '$id', 'title', 'description', 'x-limit', '$defs', '$ref', 'type', 'const', 'enum', 'anyOf',
    'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
    'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

export function unsupportedKeywords(schema) {
    const found = new Set();
    const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            if (!SUPPORTED.has(key)) found.add(key);
            if (key === 'properties' || key === '$defs') Object.values(value).forEach(walk);
            else walk(value);
        }
    };
    walk(schema);
    return [...found];
}

export function validate(root, value) {
    const errors = [];
    const typeOk = (type, v) => ({
        object: v !== null && typeof v === 'object' && !Array.isArray(v),
        array: Array.isArray(v),
        string: typeof v === 'string',
        integer: Number.isInteger(v),
        number: typeof v === 'number' && Number.isFinite(v),
        null: v === null,
        boolean: typeof v === 'boolean',
    })[type] ?? false;
    const walk = (schema, v, at) => {
        if (schema.$ref) return walk(root.$defs[schema.$ref.replace('#/$defs/', '')], v, at);
        if (schema.anyOf) {
            const passes = schema.anyOf.some((sub) => {
                const mark = errors.length;
                walk(sub, v, at);
                const ok = errors.length === mark;
                errors.length = mark;
                return ok;
            });
            if (!passes) errors.push(`${at}: matches no anyOf branch`);
            return;
        }
        if (schema.type && !typeOk(schema.type, v)) return void errors.push(`${at}: not ${schema.type}`);
        if ('const' in schema && v !== schema.const) errors.push(`${at}: not const ${schema.const}`);
        if (schema.enum && !schema.enum.includes(v)) errors.push(`${at}: not in enum`);
        if (typeof v === 'string') {
            const length = [...v].length;
            if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
            if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
            if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) errors.push(`${at}: pattern`);
        }
        if (typeof v === 'number') {
            if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${at}: < ${schema.minimum}`);
            if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${at}: > ${schema.maximum}`);
        }
        if (Array.isArray(v)) {
            if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
            if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
            if (schema.items) v.forEach((item, i) => walk(schema.items, item, `${at}/${i}`));
        }
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            for (const key of schema.required ?? []) if (!(key in v)) errors.push(`${at}: missing ${key}`);
            for (const [key, item] of Object.entries(v)) {
                if (schema.properties?.[key]) walk(schema.properties[key], item, `${at}/${key}`);
                else if (schema.additionalProperties === false) errors.push(`${at}: unknown property ${key}`);
            }
        }
    };
    walk(root, value, '#');
    return errors;
}
