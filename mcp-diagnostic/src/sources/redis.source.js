import { createClient } from 'redis';
import { toEvent } from '../helpers/envelope.js';
import { resolveEnv } from '../helpers/env.helper.js';

const _clients = new Map();

async function getClient(rawUrl) {
    const url = resolveEnv(rawUrl ?? '$REDIS_URL');
    if (!_clients.has(url)) {
        const client = createClient({ url });
        client.on('error', (e) => console.warn('[redis-source] error:', e.message));
        await client.connect();
        _clients.set(url, client);
    }
    return _clients.get(url);
}

async function getInfo(client) {
    const raw = await client.info('all');
    const sections = {};
    let section = 'misc';
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') === false && trimmed.includes(':') === false) {
            if (trimmed.startsWith('#')) section = trimmed.replace(/^#\s*/, '').toLowerCase();
            continue;
        }
        if (trimmed.startsWith('#')) { section = trimmed.replace(/^#\s*/, '').toLowerCase(); continue; }
        const [key, ...rest] = trimmed.split(':');
        if (!sections[section]) sections[section] = {};
        sections[section][key.trim()] = rest.join(':').trim();
    }
    return sections;
}

async function getSlowLog(client, count = 10) {
    const entries = await client.sendCommand(['SLOWLOG', 'GET', String(count)]);
    return (entries ?? []).map((e) => ({
        id: e[0], ts: e[1], durationUs: e[2], cmd: Array.isArray(e[3]) ? e[3].join(' ').slice(0, 120) : String(e[3]),
    }));
}

const redisSource = {
    type: 'redis',
    capabilities: ['cache'],

    async query(verb, params, sourceCfg) {
        const client = await getClient(sourceCfg.url ?? sourceCfg.conn);

        if (verb === 'cache_status' || verb === 'cache.status') {
            const [info, slowlog] = await Promise.all([getInfo(client), getSlowLog(client, params.slowlogCount ?? 10)]);

            const mem = info.memory ?? {};
            const stats = info.stats ?? {};
            const replication = info.replication ?? {};
            const keyspace = info.keyspace ?? {};

            const events = [
                toEvent({
                    source: 'redis',
                    service: sourceCfg.id ?? null,
                    kind: 'metric',
                    message: 'redis:info',
                    attrs: {
                        used_memory_human: mem.used_memory_human,
                        maxmemory_human: mem.maxmemory_human,
                        maxmemory_policy: mem.maxmemory_policy,
                        keyspace_hits: stats.keyspace_hits,
                        keyspace_misses: stats.keyspace_misses,
                        evicted_keys: stats.evicted_keys,
                        rejected_connections: stats.rejected_connections,
                        role: replication.role,
                        connected_slaves: replication.connected_slaves,
                        keyspace,
                    },
                }),
            ];

            if (slowlog.length) {
                events.push(
                    toEvent({
                        source: 'redis',
                        service: sourceCfg.id ?? null,
                        kind: 'metric',
                        level: 'warn',
                        message: `redis:slowlog (${slowlog.length} entries)`,
                        attrs: { slowlog },
                    })
                );
            }

            return events;
        }

        throw new Error(`redis driver: unsupported verb ${verb}`);
    },
};

export default redisSource;
