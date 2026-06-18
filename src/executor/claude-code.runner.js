import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { auditWriteAction } from '../security/audit.js';

const exec = promisify(execFile);

const REPOS_ROOT = process.env.EXECUTOR_REPOS_ROOT ?? '/srv/repos';
const BITBUCKET_API = process.env.BITBUCKET_API_URL ?? '';
const BITBUCKET_TOKEN = process.env.BITBUCKET_ACCESS_TOKEN ?? '';
const BITBUCKET_PROJECT = process.env.BITBUCKET_PROJECT ?? '';
const TARGET_BRANCH = process.env.EXECUTOR_TARGET_BRANCH ?? 'develop';

// Services executor is allowed to open PRs on (v1 scope)
const ALLOWED_REPOS = new Set((process.env.EXECUTOR_ALLOWED_REPOS ?? 'sama-api').split(',').map((r) => r.trim()));

/**
 * Execute a Fix Plan in a git worktree then open a PR.
 * ONLY runs after explicit human approval.
 *
 * @param {string} caseId
 * @param {string} fixPlanMd - Fix Plan markdown content
 * @param {import('../ingest/incident.schema.js').Incident} incident
 * @returns {Promise<{prUrl: string|null, success: boolean, output: string}>}
 */
export async function executeFixPlan(caseId, fixPlanMd, incident) {
    const service = incident.affectedService;
    if (!service || !ALLOWED_REPOS.has(service)) {
        const msg = `[executor] service "${service}" not in EXECUTOR_ALLOWED_REPOS — refusing execution`;
        console.error(msg);
        await auditWriteAction(caseId, 'REFUSED', { reason: 'service not in allowlist', service });
        return { prUrl: null, success: false, output: msg };
    }

    const repoPath = resolve(REPOS_ROOT, service);
    if (!existsSync(repoPath)) {
        return { prUrl: null, success: false, output: `[executor] repo not found: ${repoPath}` };
    }

    const branchName = `rca/${caseId}`;
    const worktreePath = join(REPOS_ROOT, '.worktrees', caseId);

    await auditWriteAction(caseId, 'EXECUTE_START', { service, branch: branchName });

    try {
        // Step 1: create git worktree on a new branch
        mkdirSync(join(REPOS_ROOT, '.worktrees'), { recursive: true });
        await exec('git', ['worktree', 'add', '-b', branchName, worktreePath, `origin/${TARGET_BRANCH}`], { cwd: repoPath });
        console.log(`[executor] worktree created: ${worktreePath} on branch ${branchName}`);
        await auditWriteAction(caseId, 'WORKTREE_CREATED', { path: worktreePath, branch: branchName });

        // Step 2: call Claude Code headless in the worktree
        const claudeOutput = await runClaudeCode(worktreePath, fixPlanMd, caseId);
        console.log(`[executor] Claude Code output (${claudeOutput.length} chars)`);

        // Step 3: run lint + tests in worktree
        const testResult = await runTests(worktreePath, service);
        if (!testResult.success) {
            await auditWriteAction(caseId, 'TESTS_FAILED', { output: testResult.output.slice(0, 500) });
            await cleanupWorktree(repoPath, worktreePath, branchName);
            return { prUrl: null, success: false, output: `Tests failed:\n${testResult.output}` };
        }

        // Step 4: push branch and open PR
        await exec('git', ['push', 'origin', branchName], { cwd: worktreePath });
        await auditWriteAction(caseId, 'BRANCH_PUSHED', { branch: branchName });

        const prUrl = await openPR(service, branchName, caseId, incident, fixPlanMd);
        await auditWriteAction(caseId, 'PR_OPENED', { prUrl });

        return { prUrl, success: true, output: claudeOutput };
    } catch (e) {
        console.error('[executor] error:', e.message);
        await auditWriteAction(caseId, 'EXECUTE_ERROR', { error: e.message });
        await cleanupWorktree(repoPath, worktreePath, branchName).catch(() => {});
        return { prUrl: null, success: false, output: e.message };
    }
}

async function runClaudeCode(worktreePath, fixPlanMd, caseId) {
    // Confirm exact flags with `claude --help` — these reflect Claude Code CLI v1.x
    // --print: headless/non-interactive mode
    // --add-dir: restrict file access to worktree
    // --permission-mode acceptEdits: allow file edits, no arbitrary commands
    const args = [
        '--print',
        `--add-dir=${worktreePath}`,
        '--permission-mode', 'acceptEdits',
        '--output-format', 'text',
        fixPlanMd.slice(0, 8000), // prompt = Fix Plan markdown (trim if too long)
    ];

    // ⚠️ Verify flag names with `claude --help` before deploy — may vary by CLI version
    const { stdout, stderr } = await exec('claude', args, {
        cwd: worktreePath,
        timeout: 10 * 60 * 1000, // 10 min max
        maxBuffer: 16 * 1024 * 1024,
    }).catch((e) => ({ stdout: '', stderr: e.message }));

    console.log('[executor] claude-code stderr:', stderr?.slice(0, 200));
    return stdout;
}

async function runTests(worktreePath, service) {
    try {
        const { stdout } = await exec('npm', ['test', '--if-present'], {
            cwd: worktreePath,
            timeout: 5 * 60 * 1000,
        });
        return { success: true, output: stdout };
    } catch (e) {
        return { success: false, output: e.stdout ?? e.message };
    }
}

async function openPR(service, branchName, caseId, incident, fixPlanMd) {
    if (!BITBUCKET_API || !BITBUCKET_TOKEN) {
        console.warn('[executor] No Bitbucket config — skipping PR creation');
        return null;
    }

    const title = `[RCA ${caseId}] ${incident.title.slice(0, 70)}`;
    const description = [
        `## Root Cause Analysis — ${caseId}`,
        `**Incident:** ${incident.title}`,
        `**Severity:** ${incident.severity}`,
        `**Affected service:** ${service}`,
        '',
        '## Fix Plan',
        fixPlanMd.slice(0, 3000),
        '',
        '*Generated by sama-orchestration RCA platform. Review carefully before merging.*',
    ].join('\n');

    const body = {
        title,
        description,
        source: { branch: { name: branchName } },
        destination: { branch: { name: TARGET_BRANCH } },
        reviewers: [],
        close_source_branch: true,
    };

    const url = `${BITBUCKET_API}/rest/api/1.0/projects/${BITBUCKET_PROJECT}/repos/${service}/pull-requests`;
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${BITBUCKET_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!r.ok) {
        console.error('[executor] PR creation failed', r.status, await r.text());
        return null;
    }
    const data = await r.json();
    return data.links?.self?.[0]?.href ?? null;
}

async function cleanupWorktree(repoPath, worktreePath, branchName) {
    try {
        await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath });
        await exec('git', ['branch', '-D', branchName], { cwd: repoPath });
        console.log('[executor] worktree cleaned up');
    } catch (e) {
        console.warn('[executor] cleanup failed:', e.message);
    }
}
