/**
 * Tool-result cache — Redis-backed, content-addressed, short TTL.
 * Prevents the same Sentry/Jenkins/Docker call from hitting the network
 * twice within a single RCA investigation run (~60s window).
 *
 * Cache key: rca:<tool>:<md5(JSON.stringify(args))>
 * Falls back silently to no-cache if Redis unavailable.
 */
import { createClient } from 'redis';
import { createHash } from 'node:crypto';

const DEFAULT_TTL = 60; // seconds — covers one investigation run
let _client = null;
let _connecting = false;

async function getClient() {
    if (_client?.isReady) return _client;
    if (_connecting) return null;
    const url = process.env.CACHE_REDIS_URL || process.env.REDIS_URL;
    if (!url) return null;
    try {
        _connecting = true;
        _client = createClient({ url });
        _client.on('error', (e) => console.warn('[cache] redis:', e.message));
        await _client.connect();
        return _client;
    } catch (e) {
        console.warn('[cache] unavailable — running without cache:', e.message);
        return null;
    } finally {
        _connecting = false;
    }
}

/**
 * Get cached value or compute + cache it.
 * @param {string} tool - tool name (for key namespace)
 * @param {object} args - tool arguments (hashed for key)
 * @param {number} ttl - TTL in seconds
 * @param {() => Promise<any>} fetchFn - async function to compute value
 */
export async function getOrSetJson(tool, args, ttl, fetchFn) {
    const client = await getClient();
    if (!client) return fetchFn();

    const hash = createHash('md5').update(JSON.stringify(args ?? {})).digest('hex');
    const key = `rca:${tool}:${hash}`;

    try {
        const cached = await client.get(key);
        if (cached) {
            console.log(`[cache] HIT ${tool}`);
            return JSON.parse(cached);
        }
        const value = await fetchFn();
        await client.set(key, JSON.stringify(value), { EX: ttl ?? DEFAULT_TTL });
        return value;
    } catch (e) {
        console.warn(`[cache] error for ${tool}:`, e.message);
        return fetchFn();
    }
}
