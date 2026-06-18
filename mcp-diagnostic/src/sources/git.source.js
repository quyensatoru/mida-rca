import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { toEvent } from '../helpers/envelope.js';

const exec = promisify(execFile);
const REPOS_ROOT = process.env.REPOS_ROOT || '/srv/repos';

async function recentCommits({ repo, since = '2 days ago', limit = 20 }) {
    const cwd = path.join(REPOS_ROOT, repo);
    const { stdout } = await exec(
        'git',
        ['log', `--since=${since}`, `-n${limit}`, '--pretty=format:%h|%an|%ad|%s', '--date=iso'],
        { cwd }
    );
    return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            const [hash, author, date, ...rest] = l.split('|');
            return { hash, author, date, subject: rest.join('|') };
        });
}

function commitToEvent(commit, repo) {
    return toEvent({
        ts: commit.date,
        source: 'git',
        service: repo,
        kind: 'deploy',
        level: 'info',
        message: commit.subject,
        attrs: {
            hash: commit.hash,
            author: commit.author,
        },
    });
}

const gitSource = {
    type: 'git',
    capabilities: ['deploy'],

    async query(verb, params, sourceCfg) {
        if (verb === 'deploy.recent' || verb === 'deploy_recent') {
            // repo name comes from sourceCfg (inventory) or params.repo
            const repo = sourceCfg.repo ?? params.repo;
            if (!repo) throw new Error('git driver: repo is required (set in inventory sourceCfg or params.repo)');
            const commits = await recentCommits({ repo, since: params.since, limit: params.limit });
            return commits.map((c) => commitToEvent(c, repo));
        }

        throw new Error(`git driver: unsupported verb ${verb}`);
    },
};

export default gitSource;
