/**
 * Eval suite CLI — runs the RCA pipeline against known fixtures and scores output.
 *
 * Usage:
 *   node src/cli/eval.js [--fixtures docs/eval]
 *
 * Scoring: root cause text is checked for expected keyword presence.
 * Exit code 0 = all pass, 1 = any fail.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectOpsDb } from '../config/mongo.js';
import { connectDiagnostic } from '../mcp-client/diagnostic.client.js';
import { runPipeline } from '../orchestrator/pipeline.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--fixtures' && argv[i + 1]) args.fixtures = argv[++i];
    }
    return args;
}

function scoreRootCause(rootCause, keywords) {
    const text = JSON.stringify(rootCause ?? '').toLowerCase();
    const hits = keywords.filter((k) => text.includes(k.toLowerCase()));
    return { hits, total: keywords.length, score: hits.length / Math.max(keywords.length, 1) };
}

async function runEval(fixturePath) {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const { incident, expectedRootCauseKeywords = [], expectedTriageFields = {} } = raw;

    console.log(`\n── Fixture: ${fixturePath} ──`);
    console.log(`Incident: "${incident.title}"`);

    const result = await runPipeline(incident);
    const { rootCause, caseId } = result;

    // Score root cause
    const rc = scoreRootCause(rootCause, expectedRootCauseKeywords);
    const rcPass = rc.score >= 0.6;
    console.log(`Root cause keywords: ${rc.hits.join(', ')} (${rc.hits.length}/${rc.total}) → ${rcPass ? 'PASS' : 'FAIL'}`);

    // Score triage fields
    const triageHits = [];
    const triageMisses = [];
    for (const [field, expected] of Object.entries(expectedTriageFields)) {
        const actual = (rootCause?.[field] ?? result.rootCause?.[field] ?? '').toString().toLowerCase();
        const exp = expected.toString().toLowerCase();
        if (actual.includes(exp)) triageHits.push(field);
        else triageMisses.push(`${field}:expected=${exp},got=${actual}`);
    }
    const triagePass = triageMisses.length === 0;
    if (triageHits.length) console.log(`Triage fields matched: ${triageHits.join(', ')}`);
    if (triageMisses.length) console.log(`Triage fields MISSING: ${triageMisses.join(' | ')}`);

    const pass = rcPass && triagePass;
    console.log(`Result: ${pass ? '✓ PASS' : '✗ FAIL'} (caseId: ${caseId})`);
    return { fixturePath, pass, rcScore: rc.score };
}

async function main() {
    const args = parseArgs(process.argv);
    const fixturesDir = resolve(__dirname, '../../', args.fixtures ?? 'docs/eval');

    // Init DB + MCP connections
    await connectOpsDb().catch((e) => console.warn('[eval] DB unavailable:', e.message));
    await connectDiagnostic().catch((e) => {
        console.error('[eval] MCP diagnostic not available:', e.message);
        process.exit(1);
    });

    const files = readdirSync(fixturesDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => resolve(fixturesDir, f));

    if (!files.length) {
        console.error(`No fixture files found in ${fixturesDir}`);
        process.exit(1);
    }

    console.log(`Running ${files.length} eval fixture(s)…\n`);
    const results = [];
    for (const f of files) {
        try {
            results.push(await runEval(f));
        } catch (e) {
            console.error(`  ERROR in ${f}: ${e.message}`);
            results.push({ fixturePath: f, pass: false, error: e.message });
        }
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    console.log(`\n══ Eval Summary: ${passed}/${results.length} passed, ${failed} failed ══`);
    results.forEach((r) => {
        const label = r.pass ? '✓' : '✗';
        const score = r.rcScore != null ? ` (rc:${(r.rcScore * 100).toFixed(0)}%)` : '';
        console.log(`  ${label} ${r.fixturePath}${score}${r.error ? ` ERR:${r.error}` : ''}`);
    });

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('[eval] fatal:', e);
    process.exit(1);
});
