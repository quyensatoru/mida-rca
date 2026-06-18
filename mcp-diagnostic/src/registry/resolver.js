import { getInstances, getSource } from './inventory.js';

/**
 * Resolve a target descriptor to a list of concrete source configs.
 *
 * @param {{ service: string, instance?: string, tenant?: string, capability: string }} target
 * @returns {Array<{ instanceId: string, shard: number|null, sourceCfg: object }>}
 *
 * Phase 1: service + optional instance filtering only.
 * Phase 3+: add tenant -> shard routing via ProxyModel(domain) -> proxy index.
 *
 * The return value IS the allowlist: only what's in inventory.yaml can be resolved.
 * Nothing about mida topology lives in driver code — it all comes from here.
 */
export function resolve({ service, instance, capability }) {
    if (!service) throw new Error('resolve: service is required');
    if (!capability) throw new Error('resolve: capability is required');

    let instances = getInstances(service);

    if (!instances.length) {
        return []; // service not in inventory -> no sources (verb will report "no source")
    }

    if (instance) {
        instances = instances.filter((i) => i.id === instance);
    }

    const out = [];
    for (const inst of instances) {
        const srcId = inst.sources?.[capability];
        if (!srcId) continue; // this instance doesn't serve this capability
        out.push({
            instanceId: inst.id,
            shard: inst.shard ?? null,
            sourceCfg: getSource(srcId),
        });
    }
    return out;
}
