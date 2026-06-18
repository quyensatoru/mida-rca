import { anthropic, MODELS } from '../config/anthropic.js';
import { ADVERSARIAL_SYSTEM_PROMPT, buildAdversarialPrompt } from '../helpers/prompt.js';

const ROOT_CAUSE_SCHEMA = {
    type: 'object',
    properties: {
        statement: { type: 'string', description: 'One-sentence root cause.' },
        proximateCause: { type: 'string', description: 'The immediate trigger (what failed).' },
        rootCause: { type: 'string', description: 'The underlying reason it could fail (5 Whys depth).' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence 0–1.' },
        evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Cited evidence (tool name + key finding).',
        },
        affectedFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files likely needing changes.',
        },
        alternativeHypotheses: {
            type: 'array',
            items: { type: 'string' },
            description: 'Remaining plausible alternatives.',
        },
    },
    required: ['statement', 'proximateCause', 'rootCause', 'confidence', 'evidence'],
    additionalProperties: false,
};

const ADVERSARIAL_SCHEMA = {
    type: 'object',
    properties: {
        canRefute: { type: 'boolean', description: 'True if a plausible refutation was found.' },
        refutation: { type: 'string', description: 'The refutation argument if canRefute=true.' },
        confidenceAfterReview: { type: 'number', minimum: 0, maximum: 1 },
        gaps: { type: 'array', items: { type: 'string' }, description: 'Evidence gaps that should be addressed.' },
    },
    required: ['canRefute', 'confidenceAfterReview', 'gaps'],
    additionalProperties: false,
};

/**
 * Stage 3: synthesize root cause from investigation messages, then adversarially verify.
 * @param {Array} messages - full conversation history from investigate()
 * @param {string} investigationSummary
 * @returns {Promise<{rootCause: object, adversarial: object, confidence: number}>}
 */
export async function synthesizeRootCause(messages, investigationSummary) {
    // Step 1: structured synthesis
    const synthesisMessages = [
        ...messages,
        {
            role: 'user',
            content: `Based on all evidence gathered above, provide a structured root cause analysis.
Apply 5 Whys: distinguish the proximate cause (what failed) from the root cause (why it could fail).
List only hypotheses supported by tool evidence — do not speculate.`,
        },
    ];

    const synthesis = await anthropic.messages.create({
        model: MODELS.REASON,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        output_config: {
            effort: 'high',
            format: { type: 'json_schema', json_schema: { name: 'root_cause', schema: ROOT_CAUSE_SCHEMA } },
        },
        system: [],
        messages: synthesisMessages,
    });

    const rootCause = JSON.parse(synthesis.content.find((b) => b.type === 'text')?.text ?? '{}');
    console.log(`[rootcause] synthesized: "${rootCause.statement}" confidence:${rootCause.confidence}`);

    // Step 2: adversarial verify — separate Opus call that tries to REFUTE
    const adversarial = await adversarialVerify(rootCause, investigationSummary);
    console.log(`[rootcause] adversarial: canRefute=${adversarial.canRefute} confidence_after:${adversarial.confidenceAfterReview}`);

    // If refuted with high confidence drop — note for fix plan
    const finalConfidence = adversarial.canRefute
        ? Math.min(rootCause.confidence, adversarial.confidenceAfterReview)
        : rootCause.confidence;

    return { rootCause, adversarial, confidence: finalConfidence };
}

async function adversarialVerify(rootCause, investigationSummary) {
    const resp = await anthropic.messages.create({
        model: MODELS.REASON,
        max_tokens: 2048,
        thinking: { type: 'adaptive' },
        output_config: {
            effort: 'high',
            format: { type: 'json_schema', json_schema: { name: 'adversarial_review', schema: ADVERSARIAL_SCHEMA } },
        },
        system: [{ type: 'text', text: ADVERSARIAL_SYSTEM_PROMPT }],
        messages: [
            { role: 'user', content: `${buildAdversarialPrompt(rootCause)}\n\n## Investigation Summary\n${investigationSummary}` },
        ],
    });
    return JSON.parse(resp.content.find((b) => b.type === 'text')?.text ?? '{"canRefute":false,"confidenceAfterReview":0.5,"gaps":[]}');
}
