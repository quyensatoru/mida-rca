import { resolve } from '../registry/resolver.js';
import { dispatch } from '../sources/index.js';
import {
    formatSentryIssues,
    formatSentryIssueDetail,
    formatLogs,
    formatDeploy,
} from '../helpers/format.helper.js';

/**
 * Generic verb handler — pattern identical to sama-mcp tool.handler.js.
 * Each verb: resolve(target) -> dispatch(sourceCfg, verb, params) -> format output.
 * LLM only sees verb names and canonical formatted text — never shard/storage details.
 */

const toolSentryIssues = {
    name: 'sentry_issues',
    description:
        'List unresolved Sentry error issues for a service, sorted by frequency. START HERE for any error/exception incident. Returns issue shortId (use with sentry_issue_detail), title, event count, last seen, culprit, and the release that introduced it.',
    inputSchema: {
        type: 'object',
        properties: {
            service: {
                type: 'string',
                description: 'Logical service name (e.g. "api"). Resolved via inventory registry — not a hardcoded enum.',
            },
            instance: { type: 'string', description: 'Optional: specific instance id (e.g. "api-2").' },
            query: { type: 'string', description: 'Optional Sentry search query, e.g. "level:error transaction:/api/..."' },
            statsPeriod: { type: 'string', enum: ['1h', '6h', '24h', '7d', '14d'], default: '24h' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const sources = resolve({ service: args.service, instance: args.instance, capability: 'errors' });
            if (!sources.length) {
                return { content: [{ type: 'text', text: `[sentry_issues] No 'errors' source configured for service:${args.service} in inventory.` }] };
            }
            const results = await Promise.all(
                sources.map((s) => dispatch(s.sourceCfg, 'sentry_issues', { ...args, project: s.sourceCfg.project }))
            );
            const events = results.flat();
            return { content: [{ type: 'text', text: formatSentryIssues(events, args) }] };
        } catch (e) {
            console.error('sentry_issues error:', e);
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const toolSentryIssueDetail = {
    name: 'sentry_issue_detail',
    description:
        'Full detail of one Sentry issue: stacktrace, breadcrumbs, tags, frequency, first/last seen, affected release. Call after sentry_issues to drill into the most relevant error.',
    inputSchema: {
        type: 'object',
        properties: {
            issueId: { type: 'string', description: 'Sentry issue id or shortId from sentry_issues output.' },
        },
        required: ['issueId'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            // sentry_issue_detail is id-based: no service routing needed; goes directly to Sentry API
            const sources = [{ sourceCfg: { type: 'sentry' } }];
            const event = await dispatch(sources[0].sourceCfg, 'sentry_issue_detail', args);
            return { content: [{ type: 'text', text: formatSentryIssueDetail(event) }] };
        } catch (e) {
            console.error('sentry_issue_detail error:', e);
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
            service: {
                type: 'string',
                description: 'Logical service name — resolved via inventory registry. Not a hardcoded enum.',
            },
            instance: {
                type: 'string',
                description: 'Optional: specific instance id (e.g. "api-2"). Omit to fan-out across all instances.',
            },
            since: { type: 'string', description: 'Docker --since, e.g. "30m", "2h", "2026-06-18T08:00:00".', default: '1h' },
            tail: { type: 'integer', minimum: 10, maximum: 5000, default: 500 },
            level: { type: 'string', enum: ['error', 'warn', 'info', 'debug', 'success'] },
            grep: { type: 'string', description: 'Case-insensitive substring match on log message.' },
            domain: { type: 'string', description: 'Filter logs by shop domain.' },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const sources = resolve({ service: args.service, instance: args.instance, capability: 'logs' });
            if (!sources.length) {
                return { content: [{ type: 'text', text: `[logs_search] No 'logs' source configured for service:${args.service} in inventory.` }] };
            }
            const results = await Promise.all(
                sources.map((s) => dispatch(s.sourceCfg, 'logs_search', args).catch((err) => {
                    console.error(`logs_search error for instance ${s.instanceId}:`, err.message);
                    return [];
                }))
            );
            const events = results.flat().sort((a, b) => (a.ts > b.ts ? 1 : -1));
            return { content: [{ type: 'text', text: formatLogs(events, args) }] };
        } catch (e) {
            console.error('logs_search error:', e);
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const toolDeployRecent = {
    name: 'deploy_recent',
    description:
        'Correlate the incident with recent changes. Returns recent Jenkins builds and git commits for a service near the incident time. THE key RCA question is "what changed?" — call this early.',
    inputSchema: {
        type: 'object',
        properties: {
            service: {
                type: 'string',
                description: 'Logical service name — resolved via inventory registry to jenkins/git sources.',
            },
            since: { type: 'string', description: 'git --since, e.g. "2 days ago".', default: '2 days ago' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['service'],
        additionalProperties: false,
    },
    execute: async ({ args }) => {
        try {
            const sources = resolve({ service: args.service, capability: 'deploy' });
            if (!sources.length) {
                return { content: [{ type: 'text', text: `[deploy_recent] No 'deploy' source configured for service:${args.service} in inventory.` }] };
            }

            const jenkinsResults = [];
            const gitResults = [];

            await Promise.all(
                sources.map(async (s) => {
                    try {
                        const events = await dispatch(s.sourceCfg, 'deploy_recent', args);
                        const arr = Array.isArray(events) ? events : [events];
                        if (s.sourceCfg.type === 'jenkins') jenkinsResults.push(...arr);
                        if (s.sourceCfg.type === 'git') gitResults.push(...arr);
                    } catch (err) {
                        console.error(`deploy_recent error for instance ${s.instanceId}:`, err.message);
                    }
                })
            );

            return {
                content: [{
                    type: 'text',
                    text: formatDeploy({ commits: gitResults, builds: jenkinsResults }, args),
                }],
            };
        } catch (e) {
            console.error('deploy_recent error:', e);
            return { content: [{ type: 'text', text: `error: ${e.message}` }] };
        }
    },
};

const tools = [toolSentryIssues, toolSentryIssueDetail, toolLogsSearch, toolDeployRecent];

const listTool = () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
});

const callTool = async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) return { content: [{ type: 'text', text: `tool not found: ${request.params.name}` }] };
    return await tool.execute({ args: request.params.arguments ?? {} });
};

const ToolHandler = { listTool, callTool };
export default ToolHandler;
