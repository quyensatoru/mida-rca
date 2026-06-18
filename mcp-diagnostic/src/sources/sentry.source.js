import dotenv from 'dotenv';
import { toEvent } from '../helpers/envelope.js';
dotenv.config();

const { SENTRY_API_TOKEN, SENTRY_ORG, SENTRY_BASE_URL = 'https://sentry.io/api/0' } = process.env;
const headers = () => ({ Authorization: `Bearer ${SENTRY_API_TOKEN}` });

async function listIssues({ project, query = '', statsPeriod = '24h', limit = 25 }) {
    const url = new URL(`${SENTRY_BASE_URL}/projects/${SENTRY_ORG}/${project}/issues/`);
    url.searchParams.set('query', `is:unresolved ${query}`.trim());
    url.searchParams.set('statsPeriod', statsPeriod);
    url.searchParams.set('limit', String(Math.min(limit, 100)));
    url.searchParams.set('sort', 'freq');
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`sentry ${r.status} ${await r.text()}`);
    return r.json();
}

async function getIssue({ issueId }) {
    const r = await fetch(`${SENTRY_BASE_URL}/issues/${issueId}/`, { headers: headers() });
    if (!r.ok) throw new Error(`sentry ${r.status}`);
    return r.json();
}

async function latestEvent({ issueId }) {
    const r = await fetch(`${SENTRY_BASE_URL}/issues/${issueId}/events/latest/`, { headers: headers() });
    if (!r.ok) throw new Error(`sentry ${r.status}`);
    return r.json();
}

/** Map a Sentry issue to CanonicalEvent */
function issueToEvent(issue, sourceCfg) {
    return toEvent({
        ts: issue.lastSeen ?? issue.firstSeen,
        source: 'sentry',
        service: sourceCfg.id ?? null,
        instance: null,
        level: issue.level ?? 'error',
        kind: 'error',
        traceId: null,
        message: issue.title ?? issue.culprit ?? '',
        attrs: {
            shortId: issue.shortId,
            culprit: issue.culprit,
            count: issue.count,
            firstSeen: issue.firstSeen,
            lastSeen: issue.lastSeen,
            release: issue.firstRelease?.version ?? null,
            platform: issue.platform,
        },
        link: issue.permalink ?? null,
    });
}

const sentrySource = {
    type: 'sentry',
    capabilities: ['errors'],

    async query(verb, params, sourceCfg) {
        const project = params.project ?? sourceCfg.project;

        if (verb === 'errors.search' || verb === 'sentry_issues') {
            const issues = await listIssues({ ...params, project });
            return issues.map((i) => issueToEvent(i, sourceCfg));
        }

        if (verb === 'errors.detail' || verb === 'sentry_issue_detail') {
            const [issue, event] = await Promise.all([getIssue(params), latestEvent(params)]);
            const base = issueToEvent(issue, sourceCfg);
            return {
                ...base,
                attrs: {
                    ...base.attrs,
                    stacktrace: event.entries?.find((e) => e.type === 'exception')?.data ?? null,
                    breadcrumbs: event.entries?.find((e) => e.type === 'breadcrumbs')?.data?.values ?? [],
                    tags: event.tags ?? [],
                },
            };
        }

        throw new Error(`sentry driver: unsupported verb ${verb}`);
    },
};

export default sentrySource;
