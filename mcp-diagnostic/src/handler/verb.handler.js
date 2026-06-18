import { resolve } from '../registry/resolver.js';
import { dispatch } from '../sources/index.js';
import { getOrSetJson } from '../helpers/cache.helper.js';
import {
    formatSentryIssues,
    formatSentryIssueDetail,
    formatLogs,
    formatDeploy,
    formatEvents,
    formatMetrics,
    formatQueueStatus,
    formatCacheStatus,
    formatInfraHealth,
} from '../helpers/format.helper.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fanOut(args, capability, verb) {
    const sources = await resolve({ service: args.service, instance: args.instance, tenant: args.tenant, capability });
    if (!sources.length) return { sources: [], events: [], noSource: true };
    const results = await Promise.all(
        sources.map((s) =>
            dispatch({ ...s.sourceCfg, _instanceId: s.instanceId, _shard: s.shard }, verb, {
                ...args,
                instance: s.instanceId,
                shard: s.shard,
            }).catch((err) => {
                console.error(`[verb] ${verb} error for ${s.instanceId}:`, err.message);
                return [];
            })
        )
    );
    return { sources, events: results.flat() };
}

function noSourceMsg(service, capability) {
    return `No '${capability}' source configured for service:${service} in inventory.yaml.\nAdd a '${capability}' entry to services[].instances[].sources.`;
}

// ── Phase 1 tools ──────────────────────────────────────────────────────────────

const toolSentryIssues = {
    name: 'sentry_issues',
    description:
        'List unresolved Sentry error issues for a service, sorted by frequency. START HERE for any error/exception incident. Returns issue shortId (use with sentry_issue_detail), title, event count, last seen, culprit, and the release that introduced it.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name (e.g. "api"). Resolved via inventory.' },
            instance: { type: 'string', description: 'Optional: specific instance id.' },
            query: { type: 'string', description: 'Optional Sentry search, e.g. "level:error transaction:/api/..."' },
            statsPeriod: { type: 'string', enum: ['1h', '6h', '24h', '7d', '14d'], default: '24h' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'errors', 'sentry_issues');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'errors') }] };
        return { content: [{ type: 'text', text: formatSentryIssues(events, args) }] };
    },
};

const toolSentryIssueDetail = {
    name: 'sentry_issue_detail',
    description:
        'Full detail of one Sentry issue: stacktrace, breadcrumbs, tags, frequency, first/last seen, affected release. Call after sentry_issues to drill into the most relevant error.',
    inputSchema: {
        type: 'object',
        properties: {
            issueId: { type: 'string', description: 'Sentry issue id or shortId from sentry_issues.' },
        },
        required: ['issueId'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const event = await dispatch({ type: 'sentry' }, 'sentry_issue_detail', args);
            return { content: [{ type: 'text', text: formatSentryIssueDetail(event) }] };
        } catch (e) {
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const toolLogsSearch = {
    name: 'logs_search',
    description:
        'Search structured JSON logs of a service from Docker Swarm. Filter by level (error/warn/info), text grep, shop domain, and time window. Use to confirm a Sentry hypothesis or find errors not captured by Sentry.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name. Resolved via inventory.' },
            instance: { type: 'string', description: 'Optional: specific instance id.' },
            tenant: { type: 'string', description: 'Optional: shop domain → routes to correct shard.' },
            since: { type: 'string', description: 'Docker --since, e.g. "30m", "2h", "2026-06-18T08:00:00".', default: '1h' },
            tail: { type: 'integer', minimum: 10, maximum: 5000, default: 500 },
            level: { type: 'string', enum: ['error', 'warn', 'info', 'debug', 'success'] },
            grep: { type: 'string', description: 'Case-insensitive substring on message.' },
            domain: { type: 'string', description: 'Filter logs by shop domain (same as tenant).' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'logs', 'logs_search');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'logs') }] };
        const sorted = events.sort((a, b) => (a.ts > b.ts ? 1 : -1));
        return { content: [{ type: 'text', text: formatLogs(sorted, args) }] };
    },
};

const toolDeployRecent = {
    name: 'deploy_recent',
    description:
        'Correlate the incident with recent changes. Returns Jenkins builds and git commits for a service. THE key RCA question is "what changed?" — call this early.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name. Resolved via inventory to jenkins/git sources.' },
            since: { type: 'string', description: 'git --since, e.g. "2 days ago".', default: '2 days ago' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'deploy', 'deploy_recent');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'deploy') }] };
        const commits = events.filter((e) => e.source === 'git');
        const builds = events.filter((e) => e.source === 'jenkins');
        return { content: [{ type: 'text', text: formatDeploy({ commits, builds }, args) }] };
    },
};

// ── Phase 5 tools ──────────────────────────────────────────────────────────────

const toolEventsQuery = {
    name: 'events_query',
    description:
        'Query session/user events for a service. Automatically routes to the correct storage backend (MongoDB or ClickHouse) based on shard topology — same verb works for both. Supports traceId correlation to join events across services. If tenant (domain) provided, routes to the correct shard via ProxyModel lookup.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name (e.g. "api").' },
            instance: { type: 'string', description: 'Optional: specific instance.' },
            tenant: { type: 'string', description: 'Shop domain — auto-routes to correct shard via ProxyModel.' },
            traceId: { type: 'string', description: 'Filter by traceId to correlate events across services.' },
            from: { type: 'string', description: 'ISO8601 start of time window.' },
            to: { type: 'string', description: 'ISO8601 end of time window.' },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'events', 'events_query');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'events') }] };
        const sorted = events.sort((a, b) => (a.ts > b.ts ? 1 : -1));
        return { content: [{ type: 'text', text: formatEvents(sorted, args) }] };
    },
};

const toolDbQuery = {
    name: 'db_query',
    description:
        'Query MongoDB health for a service: server status, connection counts, slow ops, collection stats. Use when suspecting DB performance issues (connection exhaustion, slow queries, replication lag).',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name.' },
            instance: { type: 'string', description: 'Optional: specific instance.' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'db', 'db_query');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'db') }] };
        return { content: [{ type: 'text', text: formatMetrics(events, { ...args, label: 'db' }) }] };
    },
};

const toolMetricsQuery = {
    name: 'metrics_query',
    description:
        'Query ClickHouse for time-series metrics: event rates, error rates, latency per minute. Use to find when a metric changed (spike or drop) relative to the incident time.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name.' },
            tenant: { type: 'string', description: 'Shop domain — auto-routes to correct shard.' },
            from: { type: 'string', description: 'ISO8601 start.' },
            to: { type: 'string', description: 'ISO8601 end.' },
            sql: { type: 'string', description: 'Optional custom SELECT query (read-only enforced). Default: count by minute with error rate.' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'metrics', 'metrics_query');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'metrics') }] };
        return { content: [{ type: 'text', text: formatMetrics(events, args) }] };
    },
};

const toolQueueStatus = {
    name: 'queue_status',
    description:
        'Check RabbitMQ queue depths, DLQs, and consumer counts. USE EARLY — a stalled queue (depth > 1000 or consumers = 0) is a classic mida incident pattern. Highlights DLQs automatically.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name.' },
            queue: { type: 'string', description: 'Optional: specific queue name.' },
            vhost: { type: 'string', description: 'RabbitMQ vhost (default: /).', default: '/' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'queue', 'queue_status');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'queue') }] };
        return { content: [{ type: 'text', text: formatQueueStatus(events, args) }] };
    },
};

const toolCacheStatus = {
    name: 'cache_status',
    description:
        'Check Redis health: memory usage, hit/miss ratio, evictions, slow commands. Use when suspecting cache pressure, eviction storms, or slow Redis commands impacting API latency.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name.' },
            slowlogCount: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        const { sources, events, noSource } = await fanOut(args, 'cache', 'cache_status');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'cache') }] };
        return { content: [{ type: 'text', text: formatCacheStatus(events, args) }] };
    },
};

const toolInfraHealth = {
    name: 'infra_health',
    description:
        'Check Docker Swarm service health: replica counts, failing tasks, restart loops. Use when suspecting container crashes, OOM kills, or under-replicated services.',
    inputSchema: {
        type: 'object',
        properties: {
            service: { type: 'string', description: 'Logical service name. Pass "all" to list every Swarm service.' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        // infra_health special case: "all" = list all services without inventory routing
        if (args.service === 'all') {
            try {
                const events = await dispatch({ type: 'swarm' }, 'infra_health', args);
                return { content: [{ type: 'text', text: formatInfraHealth(Array.isArray(events) ? events : [events], args) }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `error: ${e.message}` }] };
            }
        }
        const { sources, events, noSource } = await fanOut(args, 'infra', 'infra_health');
        if (noSource) return { content: [{ type: 'text', text: noSourceMsg(args.service, 'infra') }] };
        return { content: [{ type: 'text', text: formatInfraHealth(events, args) }] };
    },
};

// ── Registry ───────────────────────────────────────────────────────────────────

const tools = [
    toolSentryIssues,
    toolSentryIssueDetail,
    toolLogsSearch,
    toolDeployRecent,
    // Phase 5
    toolEventsQuery,
    toolDbQuery,
    toolMetricsQuery,
    toolQueueStatus,
    toolCacheStatus,
    toolInfraHealth,
];

const listTool = () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
});

const callTool = async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) return { content: [{ type: 'text', text: `tool not found: ${request.params.name}` }] };
    const args = request.params.arguments ?? {};

    // Cache all tool responses: short TTL covers a single investigation run
    return getOrSetJson(tool.name, args, 60, () => tool.execute({ args }));
};

const ToolHandler = { listTool, callTool };
export default ToolHandler;
