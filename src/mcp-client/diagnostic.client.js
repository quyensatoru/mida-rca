import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ENV } from '../config/env.js';

export async function connectDiagnostic() {
    const transport = new StreamableHTTPClientTransport(new URL(ENV.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${ENV.mcpToken}` } },
    });
    const client = new Client({ name: 'sama-orchestration', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    return client;
}

/** Convert MCP tool definitions -> Anthropic tool definitions (inputSchema -> input_schema) */
export function toAnthropicTools(mcpTools) {
    return mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
    }));
}
