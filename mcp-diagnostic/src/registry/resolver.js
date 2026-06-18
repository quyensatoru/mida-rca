import { getInstances, getSource } from './inventory.js';
import { resolveTenantShard } from './tenant.resolver.js';

/**
 * Resolve a target descriptor to a list of concrete source configs.
 * Now ASYNC to support tenant→shard routing via ProxyModel lookup.
 *
 * @param {{ service: string, instance?: string, tenant?: string, capability: string }} target
 * @returns {Promise<Array<{ instanceId: string, shard: number|null, sourceCfg: object }>>}
 *
 * Routing priority:
 *   1. instance (explicit) — filter to that instance only
 *   2. tenant (domain) → ProxyModel lookup → shard → filter instances by shard  ← Phase 5
 *   3. none — fan-out to all instances of the service
 *
 * Return value IS the allowlist: only what's in inventory.yaml can be resolved.
 * Nothing about mida topology lives in driver code — it all comes from here.
 */
export async function resolve({ service, instance, tenant, capability }) {
    if (!service) throw new Error('resolve: service is required');
    if (!capability) throw new Error('resolve: capability is required');

    let instances = getInstances(service);
    if (!instances.length) return []; // service not in inventory → verb reports "no source"

    // Explicit instance filter (highest priority)
    if (instance) {
        instances = instances.filter((i) => i.id === instance);
    }
    // Tenant→shard routing: resolve domain → proxy index → filter by shard
    else if (tenant) {
        const shard = await resolveTenantShard(tenant);
        if (shard !== null) {
            const shardInstances = instances.filter((i) => i.shard === shard);
            // Only narrow to shard if we found instances for it (graceful fallback: fan-out)
            if (shardInstances.length) instances = shardInstances;
        }
    }

    const out = [];
    for (const inst of instances) {
        const srcId = inst.sources?.[capability];
        if (!srcId) continue; // instance doesn't serve this capability
        out.push({
            instanceId: inst.id,
            shard: inst.shard ?? null,
            sourceCfg: { ...getSource(srcId), _instanceId: inst.id, _shard: inst.shard ?? null },
        });
    }
    return out;
}
