import sentry from './sentry.source.js';
import dockerLogs from './docker-logs.source.js';
import jenkins from './jenkins.source.js';
import git from './git.source.js';

/** @type {Record<string, {type:string, capabilities:string[], query:Function}>} */
export const DRIVERS = Object.fromEntries(
    [sentry, dockerLogs, jenkins, git].map((d) => [d.type, d])
);

/**
 * Dispatch a verb to the appropriate driver.
 * sourceCfg comes from inventory (via resolver) — driver never sees raw LLM args.
 */
export function dispatch(sourceCfg, verb, params) {
    const driver = DRIVERS[sourceCfg.type];
    if (!driver) throw new Error(`no driver registered for source type: ${sourceCfg.type}`);
    return driver.query(verb, params, sourceCfg);
}
