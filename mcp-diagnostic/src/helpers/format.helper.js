/**
 * Format CanonicalEvent arrays into dense, token-efficient strings for LLM context.
 * Each formatter returns a multi-line string — no JSON blobs, no wasted tokens.
 */

/** @param {import('./envelope.js').CanonicalEvent[]} events @param {object} params */
export function formatSentryIssues(events, params = {}) {
    if (!events.length) return `[sentry_issues] No issues found (project: ${params.project}, period: ${params.statsPeriod ?? '24h'})`;
    const header = `Sentry issues — project:${params.project} period:${params.statsPeriod ?? '24h'} (${events.length} issues, sorted by freq)\n`;
    const rows = events.map((e, i) => {
        const a = e.attrs;
        return `${String(i + 1).padStart(3)}. [${a.shortId ?? '?'}] ${e.message}\n     count:${a.count ?? '?'} firstSeen:${a.firstSeen ?? '?'} lastSeen:${a.lastSeen ?? '?'} culprit:${a.culprit ?? '?'} release:${a.release ?? 'unknown'}\n     link:${e.link ?? 'n/a'}`;
    });
    return header + rows.join('\n');
}

/** @param {import('./envelope.js').CanonicalEvent} event */
export function formatSentryIssueDetail(event) {
    const a = event.attrs ?? {};
    const lines = [
        `=== Sentry Issue Detail ===`,
        `title: ${event.message}`,
        `level: ${event.level} | culprit: ${a.culprit ?? 'n/a'} | release: ${a.release ?? 'unknown'}`,
        `count: ${a.count ?? '?'} | firstSeen: ${a.firstSeen ?? '?'} | lastSeen: ${a.lastSeen ?? '?'}`,
        `link: ${event.link ?? 'n/a'}`,
    ];

    if (a.stacktrace) {
        const frames = a.stacktrace?.values?.[0]?.stacktrace?.frames ?? [];
        const relevant = frames.filter((f) => !f.inApp === false || f.inApp);
        lines.push('\n--- Stacktrace (top frames) ---');
        relevant.slice(-10).forEach((f) => lines.push(`  ${f.filename}:${f.lineno} in ${f.function ?? '?'}`));
    }

    if (a.breadcrumbs?.length) {
        lines.push('\n--- Breadcrumbs (last 10) ---');
        a.breadcrumbs.slice(-10).forEach((b) => {
            lines.push(`  ${b.timestamp ?? '?'} [${b.level ?? b.type}] ${b.message ?? b.data?.url ?? ''}`);
        });
    }

    if (a.tags?.length) {
        lines.push('\n--- Tags ---');
        a.tags.forEach((t) => lines.push(`  ${t.key}=${t.value}`));
    }

    return lines.join('\n');
}

/** @param {import('./envelope.js').CanonicalEvent[]} events @param {object} params */
export function formatLogs(events, params = {}) {
    if (!events.length) return `[logs_search] No logs found (service:${params.service} level:${params.level ?? 'any'} since:${params.since ?? '1h'})`;
    const header = `Logs — service:${params.service}${params.instance ? ` instance:${params.instance}` : ''} level:${params.level ?? 'any'} since:${params.since ?? '1h'} (${events.length} lines)\n`;
    const rows = events.map((e) => {
        const a = e.attrs ?? {};
        const tenant = e.tenant ? ` domain:${e.tenant}` : '';
        return `${e.ts} [${e.level ?? '?'}]${tenant} ${e.message}  (${a.filename ?? ''}:${a.caller ?? ''})`;
    });
    return header + rows.join('\n');
}

/** @param {{ commits: Array, builds: Array|null }} data @param {object} params */
export function formatDeploy(data, params = {}) {
    const lines = [`=== Recent Changes — service:${params.service} ===`];

    if (data.builds?.length) {
        lines.push('\n--- Jenkins Builds ---');
        data.builds.forEach((e) => {
            const a = e.attrs ?? {};
            lines.push(`  ${e.ts} Build#${a.number} [${a.result ?? 'IN_PROGRESS'}] duration:${Math.round((a.duration ?? 0) / 1000)}s  ${e.link ?? ''}`);
        });
    }

    if (data.commits?.length) {
        lines.push('\n--- Git Commits ---');
        data.commits.forEach((e) => {
            const a = e.attrs ?? {};
            lines.push(`  ${e.ts} ${a.hash ?? '?'} ${a.author ?? '?'}: ${e.message}`);
        });
    }

    if (!data.builds?.length && !data.commits?.length) {
        lines.push('No recent deployments or commits found in the given window.');
    }

    return lines.join('\n');
}
