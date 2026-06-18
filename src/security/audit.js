/**
 * Audit log — records every tool call and write action.
 * Phase 2: stdout only. Phase 5: persist to rca_runs MongoDB collection.
 */

/** @param {string} caseId @param {string} toolName @param {object} input */
export async function auditToolCall(caseId, toolName, input) {
    const entry = {
        type: 'tool_call',
        caseId,
        tool: toolName,
        inputKeys: Object.keys(input ?? {}),
        ts: new Date().toISOString(),
    };
    console.log('[AUDIT]', JSON.stringify(entry));
}

/** @param {string} caseId @param {string} action @param {object} meta */
export async function auditWriteAction(caseId, action, meta = {}) {
    const entry = {
        type: 'write_action',
        caseId,
        action,
        meta,
        ts: new Date().toISOString(),
    };
    console.log('[AUDIT]', JSON.stringify(entry));
}
