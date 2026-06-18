/**
 * Format CanonicalEvent arrays into dense, token-efficient strings for LLM context.
 * Each formatter returns a multi-line string — no JSON blobs, no wasted tokens.
 */

/** Shared: format a single CanonicalEvent as a compact line */
function eventLine(e) {
    const trace = e.traceId ? ` traceId:${e.traceId.slice(0, 12)}` : '';
    const tenant = e.tenant ? ` domain:${e.tenant}` : '';
    const shard = e.shard != null ? ` shard:${e.shard}` : '';
    return `${e.ts ?? '?'} [${e.level ?? e.kind ?? '?'}]${tenant}${shard}${trace} ${e.message}`;
}

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

/** @param {import('./envelope.js').CanonicalEvent[]} events @param {object} params */
export function formatEvents(events, params = {}) {
    if (!events.length) {
        return `[events_query] No events found (service:${params.service} tenant:${params.tenant ?? 'any'} from:${params.from ?? '?'} to:${params.to ?? 'now'})`;
    }

    // Group by traceId when present to show correlated events together
    const withTrace = events.filter((e) => e.traceId);
    const noTrace = events.filter((e) => !e.traceId);

    const lines = [`=== Events — service:${params.service ?? 'all'} tenant:${params.tenant ?? 'any'} (${events.length} total) ===`];

    if (withTrace.length) {
        // Group by traceId
        const byTrace = new Map();
        for (const e of withTrace) {
            if (!byTrace.has(e.traceId)) byTrace.set(e.traceId, []);
            byTrace.get(e.traceId).push(e);
        }
        lines.push(`\n--- Correlated by traceId (${byTrace.size} traces) ---`);
        for (const [traceId, evts] of byTrace) {
            lines.push(`\nTrace ${traceId.slice(0, 16)}... (${evts.length} events, sources: ${[...new Set(evts.map((e) => e.source))].join(',')})`);
            evts.sort((a, b) => (a.ts > b.ts ? 1 : -1)).forEach((e) => lines.push('  ' + eventLine(e)));
        }
    }

    if (noTrace.length) {
        lines.push(`\n--- Events without traceId (${noTrace.length}) ---`);
        noTrace.slice(0, 100).forEach((e) => lines.push(eventLine(e)));
        if (noTrace.length > 100) lines.push(`  ... (${noTrace.length - 100} more)`);
    }

    return lines.join('\n');
}

/** @param {import('./envelope.js').CanonicalEvent[]} events @param {object} params */
export function formatMetrics(events, params = {}) {
    if (!events.length) return `[metrics_query] No metrics (service:${params.service} tenant:${params.tenant ?? 'any'})`;
    const lines = [`=== Metrics — service:${params.service ?? 'all'} (${events.length} data points) ===`];
    events.forEach((e) => {
        const a = e.attrs ?? {};
        const vals = Object.entries(a)
            .filter(([k]) => !['_id'].includes(k))
            .map(([k, v]) => `${k}:${v}`)
            .join('  ');
        lines.push(`${e.ts} ${vals}`);
    });
    return lines.join('\n');
}

/** @param {import('./envelope.js').CanonicalEvent[]} events @param {object} params */
export function formatQueueStatus(events, params = {}) {
    if (!events.length) return `[queue_status] No queues with messages or DLQs found.`;
    const lines = [`=== RabbitMQ Queue Status (${events.length} queues with activity) ===`];
    const alerts = events.filter((e) => e.level === 'warn' || e.level === 'error');
    if (alerts.length) {
        lines.push('\n⚠️  ALERTS:');
        alerts.forEach((e) => {
            const a = e.attrs ?? {};
            lines.push(`  ${a.name}: depth=${a.messages} ready=${a.messages_ready} unacked=${a.messages_unacknowledged} consumers=${a.consumers} state:${a.state}${a.isDlq ? ' [DLQ]' : ''}`);
        });
    }
    const normal = events.filter((e) => e.level !== 'warn' && e.level !== 'error');
    if (normal.length) {
        lines.push('\nActive queues:');
        normal.forEach((e) => {
            const a = e.attrs ?? {};
            lines.push(`  ${a.name}: depth=${a.messages} consumers=${a.consumers}`);
        });
    }
    return lines.join('\n');
}

/** @param {import('./envelope.js').CanonicalEvent[]} events @param {object} params */
export function formatCacheStatus(events, params = {}) {
    if (!events.length) return `[cache_status] No data from Redis.`;
    const lines = [`=== Redis Cache Status ===`];
    for (const e of events) {
        const a = e.attrs ?? {};
        if (e.message.includes('info')) {
            lines.push(
                `Memory: used=${a.used_memory_human} max=${a.maxmemory_human} policy:${a.maxmemory_policy}`,
                `Keys: hits=${a.keyspace_hits} misses=${a.keyspace_misses} evicted=${a.evicted_keys}`,
                `Replication: role=${a.role} slaves=${a.connected_slaves}`,
                `Keyspace: ${JSON.stringify(a.keyspace ?? {})}`
            );
        }
        if (e.message.includes('slowlog') && a.slowlog?.length) {
            lines.push('\n--- Slow Commands ---');
            a.slowlog.forEach((s) => lines.push(`  ${s.durationUs}µs  ${s.cmd}`));
        }
    }
    return lines.join('\n');
}

/** @param {import('./envelope.js').CanonicalEvent[]} events @param {object} params */
export function formatInfraHealth(events, params = {}) {
    if (!events.length) return `[infra_health] No services found.`;
    const alerts = events.filter((e) => e.level === 'error' || e.level === 'warn');
    const ok = events.filter((e) => e.level === 'info');
    const lines = [`=== Swarm Infra Health (${events.length} services) ===`];
    if (alerts.length) {
        lines.push(`\n⚠️  DEGRADED (${alerts.length}):`);
        alerts.forEach((e) => lines.push(`  ${e.message}`));
    }
    lines.push(`\nHealthy (${ok.length}):`);
    ok.forEach((e) => lines.push(`  ${e.message}`));
    return lines.join('\n');
}
