import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toEvent } from '../helpers/envelope.js';

const exec = promisify(execFile);
const DOCKER = process.env.DOCKER_BIN || 'docker';

async function listServices() {
    const { stdout } = await exec(DOCKER, ['service', 'ls', '--format', '{{.Name}}|{{.Mode}}|{{.Replicas}}|{{.Image}}']);
    return stdout.trim().split('\n').filter(Boolean).map((l) => {
        const [name, mode, replicas, image] = l.split('|');
        const [running, desired] = (replicas ?? '0/0').split('/').map(Number);
        return { name, mode, running, desired, image, healthy: running >= desired };
    });
}

async function getServiceTasks(service) {
    const { stdout } = await exec(DOCKER, ['service', 'ps', '--no-trunc', '--format', '{{.Name}}|{{.Node}}|{{.CurrentState}}|{{.Error}}', service]);
    return stdout.trim().split('\n').filter(Boolean).map((l) => {
        const [name, node, state, error] = l.split('|');
        return { name, node, state, error: error?.trim() ?? null };
    });
}

const swarmSource = {
    type: 'swarm',
    capabilities: ['infra'],

    async query(verb, params, sourceCfg) {
        if (verb === 'infra_health' || verb === 'infra.health') {
            const services = await listServices();

            // If a specific service requested, also pull task list
            let tasks = [];
            const target = params.service ?? sourceCfg.service;
            if (target) {
                tasks = await getServiceTasks(target).catch(() => []);
            }

            // Services with replicas below desired are alerts
            const alerts = services.filter((s) => !s.healthy);
            const events = services.map((s) =>
                toEvent({
                    source: 'swarm',
                    service: s.name,
                    kind: 'infra',
                    level: s.healthy ? 'info' : 'error',
                    message: `${s.name}: ${s.running}/${s.desired} replicas${s.healthy ? '' : ' ⚠️'}`,
                    attrs: { mode: s.mode, image: s.image, running: s.running, desired: s.desired },
                })
            );

            if (tasks.length) {
                const failing = tasks.filter((t) => t.state && !t.state.toLowerCase().startsWith('running'));
                if (failing.length) {
                    events.push(
                        toEvent({
                            source: 'swarm',
                            service: target,
                            kind: 'infra',
                            level: 'error',
                            message: `${target}: ${failing.length} failing tasks`,
                            attrs: { tasks: failing },
                        })
                    );
                }
            }

            return events;
        }

        throw new Error(`swarm driver: unsupported verb ${verb}`);
    },
};

export default swarmSource;
