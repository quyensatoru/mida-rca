import { toEvent } from '../helpers/envelope.js';

const MGMT_URL = () => process.env.RABBITMQ_MGMT_URL ?? 'http://localhost:15672';
const MGMT_AUTH = () => 'Basic ' + Buffer.from(`${process.env.RABBITMQ_USER ?? 'guest'}:${process.env.RABBITMQ_PASS ?? 'guest'}`).toString('base64');

async function mgmtGet(path) {
    const r = await fetch(`${MGMT_URL()}/api${path}`, {
        headers: { Authorization: MGMT_AUTH() },
    });
    if (!r.ok) throw new Error(`rabbitmq management API ${r.status}: ${path}`);
    return r.json();
}

async function getQueues(vhost = '%2F') {
    return mgmtGet(`/queues/${vhost}`);
}

async function getQueue(vhost = '%2F', name) {
    return mgmtGet(`/queues/${vhost}/${encodeURIComponent(name)}`);
}

function queueToEvent(q, sourceCfg) {
    const isDlq = q.name.toLowerCase().includes('dead') || q.name.toLowerCase().includes('dlq') || q.name.toLowerCase().includes('dlx');
    const isAlert = q.messages > 1000 || q.consumers === 0 || isDlq;

    return toEvent({
        source: 'rabbitmq',
        service: sourceCfg.id ?? null,
        kind: 'queue',
        level: isAlert ? 'warn' : 'info',
        message: `${q.name}: depth=${q.messages} consumers=${q.consumers}${isDlq ? ' [DLQ]' : ''}`,
        attrs: {
            name: q.name,
            vhost: q.vhost,
            messages: q.messages,
            messages_ready: q.messages_ready,
            messages_unacknowledged: q.messages_unacknowledged,
            consumers: q.consumers,
            memory: q.memory,
            state: q.state,
            isDlq,
        },
    });
}

const rabbitmqSource = {
    type: 'rabbitmq',
    capabilities: ['queue'],

    async query(verb, params, sourceCfg) {
        if (verb === 'queue_status' || verb === 'queue.status') {
            const vhost = params.vhost ?? sourceCfg.vhost ?? '%2F';
            if (params.queue) {
                const q = await getQueue(vhost, params.queue);
                return [queueToEvent(q, sourceCfg)];
            }
            const queues = await getQueues(vhost);
            // Focus on non-empty queues + DLQs
            const relevant = queues.filter((q) => q.messages > 0 || q.name.toLowerCase().includes('dead') || q.name.toLowerCase().includes('dlq'));
            return relevant.map((q) => queueToEvent(q, sourceCfg));
        }
        throw new Error(`rabbitmq driver: unsupported verb ${verb}`);
    },
};

export default rabbitmqSource;
