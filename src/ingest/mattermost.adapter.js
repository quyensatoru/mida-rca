import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';

const WEBHOOK_SECRET = process.env.MATTERMOST_WEBHOOK_SECRET ?? '';
const MATTERMOST_URL = process.env.MATTERMOST_URL ?? '';
const MATTERMOST_TOKEN = process.env.MATTERMOST_BOT_TOKEN ?? '';

/** Verify Mattermost webhook signature (if secret configured) */
export function verifyWebhookSignature(req) {
    if (!WEBHOOK_SECRET) return true; // skip if not configured
    const sig = req.headers['x-mattermost-signature'] ?? '';
    const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest('hex');
    return sig === expected;
}

/**
 * Parse a Mattermost slash command or webhook post into a canonical Incident.
 * Supports:
 *   - Outgoing webhook: req.body.text + post_id
 *   - Slash command: req.body.text + trigger_id
 * @param {object} body - raw request body
 * @returns {import('./incident.schema.js').Incident}
 */
export function parse(body) {
    const text = body.text ?? body.message ?? '';
    const sourceRef = body.post_id ?? body.trigger_id ?? randomUUID();
    const channelName = body.channel_name ?? body.channel_id ?? 'unknown';

    return {
        id: randomUUID(),
        source: 'mattermost',
        sourceRef,
        channelId: body.channel_id ?? null,
        title: extractTitle(text),
        description: text,
        symptoms: [],
        affectedService: extractService(text),
        timeWindow: { from: null, to: null },
        severity: 'medium', // Stage 1 triage will refine this
        domain: extractDomain(text),
        createdAt: new Date().toISOString(),
        _raw: { channelName, userId: body.user_id },
    };
}

/** Post a reply to a Mattermost channel (incoming webhook or API) */
export async function postReply(channelId, markdown) {
    if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
        console.warn('[mattermost] No URL/token configured — skipping post');
        return;
    }
    const url = `${MATTERMOST_URL}/api/v4/posts`;
    const r = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${MATTERMOST_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel_id: channelId, message: markdown }),
    });
    if (!r.ok) console.error('[mattermost] postReply failed', r.status, await r.text());
}

/** Register approval callback — Phase 3: poll via reaction API or webhook */
export function onApproval(cb) {
    // Phase 3: implement polling for 👍 reaction or /rca-approve slash command
    // For now: expose as a no-op placeholder
    console.log('[mattermost] onApproval registered (implementation: Phase 3 approval UX)');
    void cb; // cb(sourceRef) when approved
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractTitle(text) {
    // First line or first sentence as title
    const first = text.split(/\n|\./).filter(Boolean)[0] ?? text;
    return first.slice(0, 120).trim();
}

function extractService(text) {
    const match = text.match(/\b(sama-api|sama-recorder|sama-hm|sama-search|sama-mcp|sama-cms)\b/i);
    return match ? match[1].toLowerCase() : null;
}

function extractDomain(text) {
    const match = text.match(/\b([a-z0-9-]+\.myshopify\.com|[a-z0-9-]+\.[a-z]{2,})\b/i);
    return match ? match[1].toLowerCase() : null;
}

export default { parse, postReply, onApproval };
