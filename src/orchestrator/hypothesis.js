/**
 * Hypothesis ledger — tracks candidate root causes and their evidence during investigation.
 */

/** @typedef {'open'|'confirmed'|'refuted'} HypothesisStatus */
/** @typedef {{ id: string, statement: string, status: HypothesisStatus, evidence: string[], updatedAt: string }} Hypothesis */

export function createLedger() {
    /** @type {Hypothesis[]} */
    const hypotheses = [];
    let seq = 0;

    return {
        add(statement) {
            const h = { id: `h${++seq}`, statement, status: 'open', evidence: [], updatedAt: new Date().toISOString() };
            hypotheses.push(h);
            return h.id;
        },

        confirm(id, evidence) {
            const h = hypotheses.find((x) => x.id === id);
            if (h) { h.status = 'confirmed'; h.evidence.push(evidence); h.updatedAt = new Date().toISOString(); }
        },

        refute(id, reason) {
            const h = hypotheses.find((x) => x.id === id);
            if (h) { h.status = 'refuted'; h.evidence.push(`REFUTED: ${reason}`); h.updatedAt = new Date().toISOString(); }
        },

        addEvidence(id, evidence) {
            const h = hypotheses.find((x) => x.id === id);
            if (h) { h.evidence.push(evidence); h.updatedAt = new Date().toISOString(); }
        },

        getOpen() { return hypotheses.filter((h) => h.status === 'open'); },
        getConfirmed() { return hypotheses.filter((h) => h.status === 'confirmed'); },
        getAll() { return [...hypotheses]; },

        summarize() {
            const lines = hypotheses.map(
                (h) => `[${h.status.toUpperCase()}] ${h.id}: ${h.statement}\n  evidence: ${h.evidence.join('; ') || 'none'}`
            );
            return lines.join('\n');
        },
    };
}
