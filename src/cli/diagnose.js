/**
 * CLI smoke test: call a diagnostic MCP tool directly (no LLM).
 * Usage:
 *   node src/cli/diagnose.js                          # list available tools
 *   node src/cli/diagnose.js sentry_issues '{"service":"api","statsPeriod":"24h"}'
 *   node src/cli/diagnose.js logs_search '{"service":"api","level":"error","since":"1h"}'
 *   node src/cli/diagnose.js deploy_recent '{"service":"api"}'
 */
import { connectDiagnostic } from '../mcp-client/diagnostic.client.js';

const [, , toolName, jsonArgs] = process.argv;

const client = await connectDiagnostic();
const { tools } = await client.listTools();

if (!toolName) {
    console.log('Available tools:', tools.map((t) => t.name).join(', '));
    console.log('\nUsage: node src/cli/diagnose.js <tool> <json-args>');
    process.exit(0);
}

const tool = tools.find((t) => t.name === toolName);
if (!tool) {
    console.error(`Unknown tool: ${toolName}\nAvailable: ${tools.map((t) => t.name).join(', ')}`);
    process.exit(1);
}

const args = JSON.parse(jsonArgs || '{}');
console.log(`\nCalling ${toolName} with:`, JSON.stringify(args, null, 2));
console.log('---');

const res = await client.callTool({ name: toolName, arguments: args });
const text = res.content?.[0]?.text ?? JSON.stringify(res);
console.log(text);

process.exit(0);
