import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import ToolHandler from '../handler/verb.handler.js';

const ToolRouter = (server) => {
    server.setRequestHandler(ListToolsRequestSchema, ToolHandler.listTool);
    server.setRequestHandler(CallToolRequestSchema, async (request) => await ToolHandler.callTool(request));
};

export default ToolRouter;
