import dotenv from 'dotenv';
dotenv.config();

const required = ['ANTHROPIC_API_KEY', 'MCP_DIAGNOSTIC_URL', 'MCP_OPS_TOKEN', 'OPS_MONGO_URI'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
}

export const ENV = {
    port: Number(process.env.PORT ?? 7400),
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    mcpUrl: process.env.MCP_DIAGNOSTIC_URL,
    mcpToken: process.env.MCP_OPS_TOKEN,
    opsMongoUri: process.env.OPS_MONGO_URI,
    mattermostWebhookSecret: process.env.MATTERMOST_WEBHOOK_SECRET ?? '',
};
