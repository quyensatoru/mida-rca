import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import AuthMiddleware from './middleware/auth.middleware.js';
import ToolRouter from './routers/tool.route.js';
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const createMcpServer = () => {
    const server = new Server(
        { name: 'mida-diagnostic-mcp', version: '0.1.0' },
        { capabilities: { tools: { listChanged: true } } }
    );
    ToolRouter(server);
    return server;
};

app.get('/', (_req, res) => res.json({ name: 'mida-diagnostic-mcp', endpoints: ['/mcp'] }));

app.post('/mcp', AuthMiddleware, async (req, res) => {
    console.log(req.body.method, JSON.stringify(req.body.params));
    try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
            transport.close();
            server.close();
        });
    } catch (error) {
        console.error(error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 7401;
app.listen(PORT, () => console.log(`diagnostic MCP on :${PORT}`));
