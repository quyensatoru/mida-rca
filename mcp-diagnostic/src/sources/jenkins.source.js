import { toEvent } from '../helpers/envelope.js';

const { JENKINS_URL, JENKINS_USER, JENKINS_TOKEN } = process.env;

function authHeader() {
    return 'Basic ' + Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString('base64');
}

async function recentBuilds({ job, limit = 10 }) {
    const url = `${JENKINS_URL}/job/${encodeURIComponent(job)}/api/json?tree=builds[number,result,timestamp,duration,url]{0,${limit}}`;
    const r = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!r.ok) throw new Error(`jenkins ${r.status}`);
    const data = await r.json();
    return data.builds ?? [];
}

function buildToEvent(build, sourceCfg) {
    const ts = build.timestamp ? new Date(build.timestamp).toISOString() : new Date().toISOString();
    return toEvent({
        ts,
        source: 'jenkins',
        service: sourceCfg.job ?? null,
        kind: 'deploy',
        level: build.result === 'SUCCESS' ? 'info' : 'error',
        message: `Build #${build.number} ${build.result ?? 'IN_PROGRESS'}`,
        attrs: {
            number: build.number,
            result: build.result,
            duration: build.duration,
        },
        link: build.url ?? null,
    });
}

const jenkinsSource = {
    type: 'jenkins',
    capabilities: ['deploy'],

    async query(verb, params, sourceCfg) {
        if (verb === 'deploy.recent' || verb === 'deploy_recent') {
            const job = params.job ?? sourceCfg.job;
            if (!job) throw new Error('jenkins driver: job is required (from params or sourceCfg)');
            const builds = await recentBuilds({ job, limit: params.limit ?? 10 });
            return builds.map((b) => buildToEvent(b, sourceCfg));
        }

        throw new Error(`jenkins driver: unsupported verb ${verb}`);
    },
};

export default jenkinsSource;
