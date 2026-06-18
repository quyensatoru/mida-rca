import { anthropic, MODELS } from '../config/anthropic.js';

const FIX_PLAN_SYSTEM_PROMPT = `You are a senior engineer writing a Fix Plan document.
The format must follow the team's plan convention exactly — structured markdown with checkboxes.
Be specific: file paths, function names, line references where known.
Do not speculate — every proposed change must be grounded in the root cause evidence.`;

/**
 * Stage 4: generate Fix Plan markdown artifact.
 * @param {object} rootCause - from synthesizeRootCause()
 * @param {object} adversarial - adversarial review result
 * @param {import('../ingest/incident.schema.js').Incident} incident
 * @param {string} caseId
 * @returns {Promise<string>} Fix Plan markdown
 */
export async function generateFixPlan(rootCause, adversarial, incident, caseId) {
    const prompt = buildFixPlanPrompt(rootCause, adversarial, incident, caseId);

    const resp = await anthropic.messages.create({
        model: MODELS.REASON,
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        system: [{ type: 'text', text: FIX_PLAN_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: prompt }],
    });

    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    console.log(`[fixplan] generated ${text.length} chars for case ${caseId}`);
    return text;
}

function buildFixPlanPrompt(rootCause, adversarial, incident, caseId) {
    const gapWarning = adversarial.gaps?.length
        ? `\n> ⚠️ Evidence gaps flagged by adversarial review:\n${adversarial.gaps.map((g) => `> - ${g}`).join('\n')}\n`
        : '';

    const refutationNote = adversarial.canRefute
        ? `\n> ⚠️ Adversarial reviewer found a plausible alternative: ${adversarial.refutation}\n> Confidence adjusted to ${(adversarial.confidenceAfterReview * 100).toFixed(0)}%. Consider verifying before applying fix.\n`
        : '';

    return `Generate a Fix Plan for the following root cause analysis.

## Incident
- **Case ID:** ${caseId}
- **Title:** ${incident.title}
- **Severity:** ${incident.severity}
- **Affected service:** ${incident.affectedService ?? 'unknown'}

## Root Cause Analysis
- **Statement:** ${rootCause.statement}
- **Proximate cause:** ${rootCause.proximateCause}
- **Root cause (5 Whys):** ${rootCause.rootCause}
- **Confidence:** ${(rootCause.confidence * 100).toFixed(0)}%
- **Affected files:** ${(rootCause.affectedFiles ?? []).join(', ') || 'to be determined'}

## Evidence
${(rootCause.evidence ?? []).map((e) => `- ${e}`).join('\n') || '- (see investigation log)'}
${gapWarning}${refutationNote}

---
Write a Fix Plan markdown following this structure:

# Fix Plan — [incident title] (${caseId})

> **Root cause:** [one sentence]
> **Confidence:** [X%] | **Risk:** [low/medium/high] | **Estimated effort:** [X hours]

## Goal
[What the fix achieves and how it addresses the root cause]

## Architecture / Context
[Brief context of what changed and why the bug exists]

## File Map
| Action | Path | Change |
|--------|------|--------|

## Tasks

### Task 1: [name]
- [ ] **Step 1:** [specific action — file, function, change]
- [ ] **Step 2:** ...

## Verification
[How to confirm the fix works — specific test / check / metric to observe]

## Rollback
[How to revert if the fix causes issues]

## Risk
[Potential side effects or failure modes]`;
}
