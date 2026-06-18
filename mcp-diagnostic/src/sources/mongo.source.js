import { MongoClient } from 'mongodb';
import { toEvent } from '../helpers/envelope.js';
import { resolveEnv } from '../helpers/env.helper.js';

const _clients = new Map();

async function getClient(rawConn) {
    const conn = resolveEnv(rawConn);
    if (!_clients.has(conn)) {
        const client = new MongoClient(conn, {
            serverSelectionTimeoutMS: 5000,
            readPreference: 'secondaryPreferred',
        });
        await client.connect();
        _clients.set(conn, client);
    }
    return _clients.get(conn);
}

/** Enforce read-only: block any aggregation pipeline stage that writes */
function assertReadOnly(pipeline) {
    const writingStages = ['$out', '$merge'];
    for (const stage of pipeline ?? []) {
        const key = Object.keys(stage)[0];
        if (writingStages.includes(key)) throw new Error(`mongo driver: ${key} is not allowed (read-only)`);
    }
}

async function queryEvents(db, params, sourceCfg) {
    const collection = db.collection(sourceCfg.collection ?? 'events');
    const filter = {};
    if (params.tenant) filter.domain = params.tenant;
    if (params.traceId) filter.traceId = params.traceId;
    if (params.from || params.to) {
        filter.createdAt = {};
        if (params.from) filter.createdAt.$gte = new Date(params.from);
        if (params.to) filter.createdAt.$lte = new Date(params.to);
    }
    const limit = Math.min(params.limit ?? 200, 1000);
    const docs = await collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    return docs.map((d) =>
        toEvent({
            ts: (d.createdAt ?? d.time ?? new Date()).toISOString?.() ?? String(d.createdAt),
            source: 'mongo',
            service: sourceCfg.id ?? null,
            instance: params.instance ?? null,
            tenant: d.domain ?? params.tenant ?? null,
            shard: params.shard ?? null,
            kind: 'event',
            traceId: d.traceId ?? null,
            message: d.type ?? d.event ?? d.name ?? 'mongo_event',
            attrs: { _id: String(d._id), ...Object.fromEntries(Object.entries(d).filter(([k]) => !['_id', 'createdAt', 'time'].includes(k)).slice(0, 20)) },
        })
    );
}

async function queryDb(db, params, sourceCfg) {
    const results = [];

    // Server status
    try {
        const status = await db.command({ serverStatus: 1, repl: 0, tcmalloc: 0 });
        results.push(
            toEvent({
                source: 'mongo',
                service: sourceCfg.id ?? null,
                kind: 'metric',
                message: 'serverStatus',
                attrs: {
                    connections: status.connections,
                    opcounters: status.opcounters,
                    mem: status.mem,
                    uptime: status.uptime,
                },
            })
        );
    } catch {}

    // Collection stats for target collection
    if (sourceCfg.collection) {
        try {
            const stats = await db.command({ collStats: sourceCfg.collection });
            results.push(
                toEvent({
                    source: 'mongo',
                    service: sourceCfg.id ?? null,
                    kind: 'metric',
                    message: `collStats:${sourceCfg.collection}`,
                    attrs: { count: stats.count, size: stats.size, avgObjSize: stats.avgObjSize, storageSize: stats.storageSize, nindexes: stats.nindexes },
                })
            );
        } catch {}
    }

    return results;
}

const mongoSource = {
    type: 'mongo',
    capabilities: ['events', 'db'],

    async query(verb, params, sourceCfg) {
        const client = await getClient(sourceCfg.conn);
        const db = client.db();

        if (verb === 'events_query' || verb === 'events.query') return queryEvents(db, params, sourceCfg);
        if (verb === 'db_query' || verb === 'db.query') return queryDb(db, params, sourceCfg);
        throw new Error(`mongo driver: unsupported verb ${verb}`);
    },
};

export default mongoSource;
