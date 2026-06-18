import express from 'express';
import cors from 'cors';
import { ENV } from './config/env.js';
import { connectOpsDb } from './config/mongo.js';
import { verifyWebhookSignature, parse as parseMattermost, postReply } from './ingest/mattermost.adapter.js';
import { runPipeline } from './orchestrator/pipeline.js';
import { detectRecurrence } from './memory/incident.memory.js';

const app = express();
app.use(express.json());
app.use(cors());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'sama-orchestration', version: '0.1.0' }));

app.post('/webhook/mattermost', async (req, res) => {
    if (!verifyWebhookSignature(req)) {
        return res.status(401).json({ error: 'invalid signature' });
    }

    // Acknowledge immediately — Mattermost expects < 3s response
    res.json({ status: 'accepted', message: '🔍 RCA started — fix plan incoming...' });

    const incident = parseMattermost(req.body);
    console.log(`[webhook] incident received: "${incident.title}" from ${incident.source}`);

    // Check for recurrence before full investigation
    const prior = await detectRecurrence(incident).catch(() => null);
    if (prior) {
        const recurrenceMsg = buildRecurrenceMessage(prior, incident);
        await postReply(incident.channelId, recurrenceMsg).catch((e) => console.error('[webhook] postReply error:', e.message));
        return;
    }

    // Full pipeline (async — don't await in request handler)
    runPipeline(incident)
        .then(async ({ caseId, fixPlan }) => {
            const msg = buildFixPlanMessage(caseId, fixPlan, incident);
            await postReply(incident.channelId, msg).catch((e) => console.error('[webhook] postReply error:', e.message));
        })
        .catch((e) => console.error('[webhook] pipeline error:', e));
});

// Manual trigger for testing without Mattermost
app.post('/rca/trigger', async (req, res) => {
    const incident = req.body;
    if (!incident?.title || !incident?.description) {
        return res.status(400).json({ error: 'incident.title and incident.description required' });
    }
    res.json({ status: 'accepted', message: 'Pipeline started. Check logs for progress.' });
    runPipeline({ id: `manual-${Date.now()}`, source: 'manual', sourceRef: 'manual', ...incident })
        .then(({ caseId, fixPlan }) => console.log(`[trigger] Done caseId:${caseId}\n`, fixPlan.slice(0, 500)))
        .catch((e) => console.error('[trigger] pipeline error:', e));
});

function buildFixPlanMessage(caseId, fixPlan, incident) {
    return [
        `### 🔍 RCA Complete — ${incident.title}`,
        `**Case:** \`${caseId}\``,
        '',
        fixPlan.slice(0, 4000), // Mattermost message limit
        '',
        `To approve and execute: reply with \`/rca-approve ${caseId}\``,
        `To reject: reply with \`/rca-reject ${caseId}\``,
    ].join('\n');
}

function buildRecurrenceMessage(prior, incident) {
    return [
        `### ⚠️ Recurrence Detected — ${incident.title}`,
        `This looks like a repeat of a known issue resolved on **${prior.resolvedAt?.slice(0, 10) ?? 'unknown date'}**.`,
        '',
        `**Previous root cause:** ${prior.rootCause?.statement ?? 'see prior case'}`,
        `**Previous fix:** ${prior.fix?.slice(0, 500) ?? 'see prior fix plan'}`,
        `**Prior PR:** ${prior.prUrl ?? 'n/a'}`,
        '',
        'If the prior fix was not effective, trigger a fresh investigation with `/rca-investigate`.',
    ].join('\n');
}

// Connect DB then start server
connectOpsDb()
    .catch((e) => {
        console.warn('[startup] ops DB not available — memory features disabled:', e.message);
    })
    .finally(() => {
        app.listen(ENV.port, () => console.log(`orchestrator on :${ENV.port}`));
    });
