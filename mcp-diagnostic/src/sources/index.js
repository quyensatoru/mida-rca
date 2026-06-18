import sentry from './sentry.source.js';
import dockerLogs from './docker-logs.source.js';
import jenkins from './jenkins.source.js';
import git from './git.source.js';
import mongo from './mongo.source.js';
import clickhouse from './clickhouse.source.js';
import rabbitmq from './rabbitmq.source.js';
import redis from './redis.source.js';
import swarm from './swarm.source.js';

/** @type {Record<string, {type:string, capabilities:string[], query:Function}>} */
export const DRIVERS = Object.fromEntries(
    [sentry, dockerLogs, jenkins, git, mongo, clickhouse, rabbitmq, redis, swarm].map((d) => [d.type, d])
);

/**
 * Dispatch a verb to the correct driver.
 * sourceCfg always comes from inventory (via resolver) — never raw LLM args.
 */
export function dispatch(sourceCfg, verb, params) {
    const driver = DRIVERS[sourceCfg.type];
    if (!driver) throw new Error(`no driver registered for source type: ${sourceCfg.type}`);
    return driver.query(verb, params, sourceCfg);
}
