/**
 * CLI for two modes:
 *
 * 1. Smoke-test a diagnostic MCP tool directly (no LLM):
 *    node src/cli/diagnose.js tool <tool-name> <json-args>
 *    node src/cli/diagnose.js tool sentry_issues '{"service":"api","statsPeriod":"24h"}'
 *
 * 2. Run full RCA pipeline on an incident JSON file:
 *    node src/cli/diagnose.js incident <file.json>
 *    node src/cli/diagnose.js incident docs/sample-incident.json
 */
import { readFileSync } from 'node:fs';
import { connectDiagnostic } from '../mcp-client/diagnostic.client.js';
import { runPipeline } from '../orchestrator/pipeline.js';

const [, , mode, arg1, arg2] = process.argv;

if (mode === 'tool') {
    const toolName = arg1;
    const client = await connectDiagnostic();
    const { tools } = await client.listTools();

    if (!toolName) {
        console.log('Available tools:', tools.map((t) => t.name).join(', '));
        console.log('\nUsage: node src/cli/diagnose.js tool <tool> <json-args>');
        process.exit(0);
    }

    const args = JSON.parse(arg2 || '{}');
    console.log(`\nCalling ${toolName} with:`, JSON.stringify(args, null, 2), '\n---');
    const res = await client.callTool({ name: toolName, arguments: args });
    console.log(res.content?.[0]?.text ?? JSON.stringify(res));
    process.exit(0);
}

if (mode === 'incident') {
    if (!arg1) {
        console.error('Usage: node src/cli/diagnose.js incident <path/to/incident.json>');
        process.exit(1);
    }
    const incident = JSON.parse(readFileSync(arg1, 'utf8'));
    console.log(`Running pipeline on: "${incident.title}"\n`);
    const result = await runPipeline(incident);
    console.log('\n===== FIX PLAN =====\n');
    console.log(result.fixPlan);
    console.log(`\n===== DONE (case: ${result.caseId}) =====`);
    process.exit(0);
}

console.log('Usage:');
console.log('  node src/cli/diagnose.js tool <tool-name> [json-args]   # call MCP tool directly');
console.log('  node src/cli/diagnose.js incident <file.json>            # run full RCA pipeline');
process.exit(1);
