import { createClient } from '@clickhouse/client';
import { toEvent } from '../helpers/envelope.js';
import { resolveEnv } from '../helpers/env.helper.js';

const _clients = new Map();

function getClient(rawConn) {
    const conn = resolveEnv(rawConn);
    if (!_clients.has(conn)) {
        const client = createClient({
            url: conn,
            clickhouse_settings: { readonly: '1' }, // enforce read-only at protocol level
        });
        _clients.set(conn, client);
    }
    return _clients.get(conn);
}

const WRITE_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|OPTIMIZE\s+TABLE|RENAME|ATTACH|DETACH|KILL|GRANT|REVOKE)\b/i;

function assertReadOnly(sql) {
    if (WRITE_PATTERN.test(sql)) throw new Error('clickhouse driver: write operations not allowed (read-only)');
}

async function queryEvents(client, params, sourceCfg) {
    const table = sourceCfg.table ?? 'events';
    const conditions = ['1=1'];
    const values = {};

    if (params.tenant) { conditions.push(`domain = {domain:String}`); values.domain = params.tenant; }
    if (params.traceId) { conditions.push(`traceId = {traceId:String}`); values.traceId = params.traceId; }
    if (params.from) { conditions.push(`createdAt >= {from:DateTime}`); values.from = params.from; }
    if (params.to) { conditions.push(`createdAt <= {to:DateTime}`); values.to = params.to; }

    const limit = Math.min(params.limit ?? 200, 1000);
    const sql = `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit}`;
    assertReadOnly(sql);

    const result = await client.query({ query: sql, query_params: values, format: 'JSONEachRow' });
    const rows = await result.json();

    return rows.map((row) =>
        toEvent({
            ts: row.createdAt ?? row.time ?? new Date().toISOString(),
            source: 'clickhouse',
            service: sourceCfg.id ?? null,
            instance: params.instance ?? null,
            tenant: row.domain ?? params.tenant ?? null,
            shard: params.shard ?? null,
            kind: 'event',
            traceId: row.traceId ?? null,
            message: row.type ?? row.event ?? row.name ?? 'ch_event',
            attrs: Object.fromEntries(Object.entries(row).filter(([k]) => !['createdAt', 'time'].includes(k)).slice(0, 20)),
        })
    );
}

async function queryMetrics(client, params, sourceCfg) {
    const table = params.table ?? sourceCfg.table ?? 'events';
    const conditions = ['1=1'];
    const values = {};

    if (params.tenant) { conditions.push(`domain = {domain:String}`); values.domain = params.tenant; }
    if (params.from) { conditions.push(`createdAt >= {from:DateTime}`); values.from = params.from; }
    if (params.to) { conditions.push(`createdAt <= {to:DateTime}`); values.to = params.to; }

    // Default: count by minute (error rates, throughput)
    const sql = params.sql
        ? params.sql
        : `SELECT toStartOfMinute(createdAt) AS minute, count() AS total, countIf(level='error') AS errors FROM ${table} WHERE ${conditions.join(' AND ')} GROUP BY minute ORDER BY minute DESC LIMIT 60`;
    assertReadOnly(sql);

    const result = await client.query({ query: sql, query_params: values, format: 'JSONEachRow' });
    const rows = await result.json();

    return rows.map((row) =>
        toEvent({
            ts: row.minute ?? row.time ?? new Date().toISOString(),
            source: 'clickhouse',
            service: sourceCfg.id ?? null,
            kind: 'metric',
            message: `metrics:${table}`,
            attrs: row,
        })
    );
}

const clickhouseSource = {
    type: 'clickhouse',
    capabilities: ['events', 'metrics'],

    async query(verb, params, sourceCfg) {
        const client = getClient(sourceCfg.conn);

        if (verb === 'events_query' || verb === 'events.query') return queryEvents(client, params, sourceCfg);
        if (verb === 'metrics_query' || verb === 'metrics.query') return queryMetrics(client, params, sourceCfg);
        throw new Error(`clickhouse driver: unsupported verb ${verb}`);
    },
};

export default clickhouseSource;
