/**
 * Resolve $ENV_VAR references in inventory sourceCfg values.
 * inventory.yaml stores refs like conn: $API_URI_1 — resolved at runtime.
 */
export function resolveEnv(val) {
    if (typeof val === 'string' && val.startsWith('$')) {
        const key = val.slice(1);
        const resolved = process.env[key];
        if (!resolved) throw new Error(`env var ${key} not set (required by inventory: ${val})`);
        return resolved;
    }
    return val;
}

/** Resolve all string values in a sourceCfg object that start with $ */
export function resolveCfg(cfg) {
    const out = {};
    for (const [k, v] of Object.entries(cfg ?? {})) {
        out[k] = typeof v === 'string' && v.startsWith('$') ? resolveEnv(v) : v;
    }
    return out;
}
