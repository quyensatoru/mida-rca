import { anthropic, MODELS } from '../config/anthropic.js';
import { connectDiagnostic, toAnthropicTools } from '../mcp-client/diagnostic.client.js';
import { RCA_SYSTEM_PROMPT, buildOpeningPrompt, buildBudgetWarningPrompt } from '../helpers/prompt.js';
import { redact } from '../security/redact.js';
import { auditToolCall } from '../security/audit.js';

const MAX_ITERS = 12;
const MAX_INPUT_TOKENS = 400_000;

/**
 * Agentic investigation loop.
 * @param {import('../ingest/incident.schema.js').Incident} incident
 * @param {string} caseId
 * @returns {Promise<{messages: Array, finalText: string, usage: object}>}
 */
export async function investigate(incident, caseId) {
    const mcp = await connectDiagnostic();
    const { tools: mcpTools } = await mcp.listTools();
    const tools = toAnthropicTools(mcpTools);

    const messages = [{ role: 'user', content: buildOpeningPrompt(incident) }];
    const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read: 0 };
    let spentInputTokens = 0;

    for (let i = 0; i < MAX_ITERS; i++) {
        console.log(`[investigate] iteration ${i + 1}/${MAX_ITERS} — messages:${messages.length} spent:${spentInputTokens}tok`);

        const resp = await anthropic.messages.create({
            model: MODELS.REASON,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high' },
            system: [{ type: 'text', text: RCA_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            tools,
            messages,
        });

        usageTotals.input_tokens += resp.usage.input_tokens ?? 0;
        usageTotals.output_tokens += resp.usage.output_tokens ?? 0;
        usageTotals.cache_read += resp.usage.cache_read_input_tokens ?? 0;
        spentInputTokens += resp.usage.input_tokens ?? 0;

        if (resp.stop_reason === 'end_turn') {
            messages.push({ role: 'assistant', content: resp.content });
            const finalText = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            return { messages, finalText, usage: usageTotals };
        }

        if (resp.stop_reason !== 'tool_use') {
            console.warn('[investigate] unexpected stop_reason:', resp.stop_reason);
            break;
        }

        messages.push({ role: 'assistant', content: resp.content });

        if (spentInputTokens > MAX_INPUT_TOKENS) {
            console.warn('[investigate] budget exhausted, requesting synthesis');
            messages.push({ role: 'user', content: buildBudgetWarningPrompt() });
            continue;
        }

        const toolResults = [];
        for (const block of resp.content) {
            if (block.type !== 'tool_use') continue;
            await auditToolCall(caseId, block.name, block.input);
            const out = await mcp.callTool({ name: block.name, arguments: block.input });
            const raw = out.content?.[0]?.text ?? JSON.stringify(out.content);
            const text = redact(raw);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text });
        }
        messages.push({ role: 'user', content: toolResults });
    }

    // Exhausted iterations — extract best findings from conversation
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const finalText = lastAssistant
        ? (Array.isArray(lastAssistant.content)
            ? lastAssistant.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
            : lastAssistant.content)
        : 'Investigation incomplete — max iterations reached.';
    return { messages, finalText, usage: usageTotals };
}
