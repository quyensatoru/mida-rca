/**
 * @typedef {Object} CanonicalEvent
 * @property {string} ts            ISO8601
 * @property {string} source        'sentry'|'docker-logs'|'mongo'|'clickhouse'|'rabbitmq'|'jenkins'|'git'
 * @property {string} service       'api'|'recorder'|'heatmap'|...
 * @property {string|null} instance 'api-1'|'api-2'|...
 * @property {string|null} tenant   shop domain
 * @property {number|null} shard
 * @property {string|null} level    'error'|'warn'|'info'|...
 * @property {string} kind          'error'|'log'|'metric'|'event'|'deploy'|'queue'
 * @property {string|null} traceId  join key across services
 * @property {string} message
 * @property {Object} attrs         normalized fields
 * @property {string|null} link     deep-link to source (Sentry issue URL, Jenkins build URL, ...)
 */

/** @param {Partial<CanonicalEvent>} partial @returns {CanonicalEvent} */
export const toEvent = (partial) => ({
    ts: new Date().toISOString(),
    source: null,
    service: null,
    instance: null,
    tenant: null,
    shard: null,
    level: null,
    kind: null,
    traceId: null,
    message: '',
    attrs: {},
    link: null,
    ...partial,
});
