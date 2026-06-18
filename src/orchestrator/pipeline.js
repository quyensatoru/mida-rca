import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropic, MODELS } from '../config/anthropic.js';
import { investigate } from './investigate.js';
import { synthesizeRootCause } from './rootcause.js';
import { generateFixPlan } from './fixplan.js';
import { TRIAGE_SYSTEM_PROMPT } from '../helpers/prompt.js';
import { INCIDENT_TRIAGE_SCHEMA } from '../ingest/incident.schema.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIX_PLANS_DIR = resolve(__dirname, '../../docs/fix-plans');

// Cost per 1M tokens (claude-opus-4-8)
const COST_INPUT_PER_M = 5.0;
const COST_OUTPUT_PER_M = 25.0;

let _runsCol = null;

/** Called by mongo.js after the ops DB is connected */
export function setRunsCollection(col) {
    _runsCol = col;
}

/**
 * Run the full 4-stage RCA pipeline on an incident.
 *
 * Stage 1: Triage  (Haiku — classify + enrich incident)
 * Stage 2: Investigate  (Opus — agentic loop with MCP tools)
 * Stage 3: Root Cause  (Opus — synthesize + adversarial verify)
 * Stage 4: Fix Plan  (Opus — generate markdown artifact)
 *
 * @param {import('../ingest/incident.schema.js').Incident} incident
 * @returns {Promise<{caseId: string, rootCause: object, fixPlan: string, usage: object}>}
 */
export async function runPipeline(incident) {
    const caseId = `rca-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const run = { caseId, incidentId: incident.id, startedAt, stages: {} };
    console.log(`[pipeline] START case:${caseId} incident:"${incident.title}"`);

    // ── Stage 1: Triage ────────────────────────────────────────────────────────
    console.log('[pipeline] Stage 1: triage');
    const enriched = await triage(incident);
    run.stages.triage = { completedAt: new Date().toISOString(), result: enriched };
    const fullIncident = { ...incident, ...enriched };

    // ── Stage 2: Investigate ────────────────────────────────────────────────────
    console.log('[pipeline] Stage 2: investigate');
    const { messages, finalText, usage: investigateUsage } = await investigate(fullIncident, caseId);
    run.stages.investigate = { completedAt: new Date().toISOString(), usage: investigateUsage };

    // ── Stage 3: Root Cause ─────────────────────────────────────────────────────
    console.log('[pipeline] Stage 3: root cause synthesis + adversarial verify');
    const { rootCause, adversarial, confidence } = await synthesizeRootCause(messages, finalText);
    run.stages.rootCause = { completedAt: new Date().toISOString(), confidence, adversarial };

    // ── Stage 4: Fix Plan ───────────────────────────────────────────────────────
    console.log('[pipeline] Stage 4: fix plan generation');
    const fixPlan = await generateFixPlan(rootCause, adversarial, fullIncident, caseId);
    run.stages.fixPlan = { completedAt: new Date().toISOString(), chars: fixPlan.length };

    // Persist fix plan to docs/fix-plans/<caseId>.md
    try {
        mkdirSync(FIX_PLANS_DIR, { recursive: true });
        const outPath = resolve(FIX_PLANS_DIR, `${caseId}.md`);
        writeFileSync(outPath, fixPlan, 'utf8');
        console.log(`[pipeline] Fix plan written to ${outPath}`);
    } catch (e) {
        console.error('[pipeline] Failed to write fix plan:', e.message);
    }

    // ── Persist run metrics ─────────────────────────────────────────────────────
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    const inputTokens = investigateUsage?.input_tokens ?? 0;
    const outputTokens = investigateUsage?.output_tokens ?? 0;
    const costUsd = (inputTokens * COST_INPUT_PER_M + outputTokens * COST_OUTPUT_PER_M) / 1_000_000;

    // Count tool calls from conversation messages
    const toolCallCount = messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === 'tool_use').length;

    const runDoc = {
        caseId,
        incidentId: incident.id,
        startedAt,
        completedAt,
        durationMs,
        stages: run.stages,
        toolCallCount,
        inputTokens,
        outputTokens,
        costUsd: Math.round(costUsd * 10000) / 10000,
        confidence,
    };
    console.log(`[pipeline] DONE case:${caseId} confidence:${confidence} toolCalls:${toolCallCount} inputTok:${inputTokens} cost:$${runDoc.costUsd}`);
    if (_runsCol) {
        _runsCol.insertOne(runDoc).catch((e) => console.error('[pipeline] rca_runs write failed:', e.message));
    }

    return { caseId, rootCause, fixPlan, usage: investigateUsage };
}

async function triage(incident) {
    const resp = await anthropic.messages.create({
        model: MODELS.CLASSIFY,
        max_tokens: 1024,
        output_config: {
            format: { type: 'json_schema', json_schema: { name: 'triage', schema: INCIDENT_TRIAGE_SCHEMA } },
        },
        system: [{ type: 'text', text: TRIAGE_SYSTEM_PROMPT }],
        messages: [
            {
                role: 'user',
                content: `Extract structured triage information from this incident report:\n\n${incident.description}\n\nTitle: ${incident.title}`,
            },
        ],
    });
    try {
        return JSON.parse(resp.content.find((b) => b.type === 'text')?.text ?? '{}');
    } catch {
        return {};
    }
}
