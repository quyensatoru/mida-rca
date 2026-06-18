import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toEvent } from '../helpers/envelope.js';

const exec = promisify(execFile);
const DOCKER = process.env.DOCKER_BIN || 'docker';

/**
 * Docker Swarm logs source driver.
 * sourceCfg.service comes from inventory — driver never receives raw service name from LLM.
 */

async function search({ service, since = '1h', tail = 500, level = null, grep = null, domain = null }) {
    const { stdout } = await exec(
        DOCKER,
        ['service', 'logs', '--no-task-ids', '--since', since, '--tail', String(Math.min(tail, 5000)), service],
        { maxBuffer: 32 * 1024 * 1024 }
    );

    const lines = stdout.split('\n').filter(Boolean);
    const out = [];
    for (const raw of lines) {
        // docker log prefix: "service.1.xxxx@node    | {json}"
        const jsonStart = raw.indexOf('{');
        let log;
        try {
            log = JSON.parse(raw.slice(jsonStart));
        } catch {
            log = { level: 'raw', message: raw.trim() };
        }

        if (level && log.level !== level) continue;
        if (domain && log.domain !== domain) continue;
        if (grep && !(log.message || '').toLowerCase().includes(grep.toLowerCase())) continue;

        out.push(log);
    }
    return out.slice(-tail);
}

function logToEvent(log, sourceCfg, instanceId) {
    return toEvent({
        ts: log.time ?? new Date().toISOString(),
        source: 'docker-logs',
        service: sourceCfg.service ?? null,
        instance: instanceId ?? null,
        tenant: log.domain ?? null,
        level: log.level ?? 'info',
        kind: 'log',
        traceId: log.traceId ?? null,
        message: log.message ?? '',
        attrs: {
            filename: log.filename ?? null,
            caller: log.caller ?? null,
            domain: log.domain ?? null,
        },
    });
}

const dockerLogsSource = {
    type: 'docker-logs',
    capabilities: ['logs'],

    async query(verb, params, sourceCfg) {
        if (verb === 'logs.search' || verb === 'logs_search') {
            const logs = await search({ ...params, service: sourceCfg.service });
            return logs.map((l) => logToEvent(l, sourceCfg, params.instance ?? null));
        }

        if (verb === 'infra.services' || verb === 'infra_services') {
            const { stdout } = await exec(DOCKER, ['service', 'ls', '--format', '{{.Name}}|{{.Replicas}}|{{.Image}}']);
            return stdout
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((l) => {
                    const [name, replicas, image] = l.split('|');
                    return toEvent({ source: 'docker-logs', kind: 'infra', message: name, attrs: { replicas, image } });
                });
        }

        throw new Error(`docker-logs driver: unsupported verb ${verb}`);
    },
};

export default dockerLogsSource;
