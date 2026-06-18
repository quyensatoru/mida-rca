/**
 * Tenant→shard resolver.
 * Reuses mida's ProxyModel logic: query the proxy MongoDB collection
 * (collection: shops, key: domain, value: proxy) to resolve domain → shard index.
 *
 * Config comes from inventory.yaml tenancy.resolver — no mida hardcode in this file.
 */
import { MongoClient } from 'mongodb';
import { getTenancyResolver } from './inventory.js';
import { resolveEnv } from '../helpers/env.helper.js';

let _client = null;
let _cfg = null;

async function getProxyClient() {
    if (_client) return _client;
    _cfg = getTenancyResolver();
    if (!_cfg || _cfg.type !== 'mongo') return null;
    try {
        const conn = resolveEnv(_cfg.conn);
        _client = new MongoClient(conn, { serverSelectionTimeoutMS: 3000 });
        await _client.connect();
        return _client;
    } catch (e) {
        console.warn('[tenant-resolver] proxy DB unavailable:', e.message);
        return null;
    }
}

/**
 * Resolve a shop domain → shard index (proxy number).
 * Returns null if tenant resolver is not configured or domain not found.
 * @param {string} domain - shop domain, e.g. "shop.myshopify.com"
 * @returns {Promise<number|null>}
 */
export async function resolveTenantShard(domain) {
    if (!domain) return null;
    const client = await getProxyClient();
    if (!client || !_cfg) return null;
    try {
        const db = client.db();
        const doc = await db.collection(_cfg.collection).findOne({ [_cfg.key]: domain });
        return doc ? doc[_cfg.value] : null;
    } catch (e) {
        console.warn('[tenant-resolver] lookup failed:', e.message);
        return null;
    }
}
