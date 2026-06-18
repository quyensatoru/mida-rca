/**
 * Audit log — records every tool call and write action.
 * Phase 2: stdout only.
 * Phase 5: also persists to rca_audit MongoDB collection (set via setAuditCollection).
 */

let _auditCol = null;

/** Called by mongo.js after the ops DB is connected */
export function setAuditCollection(col) {
    _auditCol = col;
}

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
    if (_auditCol) {
        _auditCol.insertOne(entry).catch((e) => console.error('[audit] write failed:', e.message));
    }
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
    if (_auditCol) {
        _auditCol.insertOne(entry).catch((e) => console.error('[audit] write failed:', e.message));
    }
}
