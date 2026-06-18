/**
 * Incident Memory — store and recall past incidents for recurrence detection.
 * Phase 3: keyword/tag/service match via MongoDB.
 * Phase 5: upgrade to vector embeddings similarity search.
 */

/** @typedef {{ symptoms: string[], tags: string[], affectedService: string|null, rootCause: object, fix: string, prUrl: string|null, outcome: string, resolvedAt: string }} IncidentMemoryDoc */

let _collection = null;

/** Set the MongoDB collection to use (called from config/mongo.js) */
export function setMemoryCollection(collection) {
    _collection = collection;
}

/**
 * Recall past incidents similar to the current one.
 * Returns top matches by affectedService + symptom keyword overlap.
 * @param {import('../ingest/incident.schema.js').Incident} incident
 * @returns {Promise<IncidentMemoryDoc[]>}
 */
export async function recall(incident) {
    if (!_collection) return [];
    try {
        const query = {};
        if (incident.affectedService) query.affectedService = incident.affectedService;

        const candidates = await _collection.find(query).sort({ resolvedAt: -1 }).limit(20).toArray();
        if (!candidates.length) return [];

        // Score by symptom keyword overlap
        const incidentText = [incident.title, incident.description, ...(incident.symptoms ?? [])].join(' ').toLowerCase();
        const scored = candidates.map((c) => {
            const pastText = [c.rootCause?.statement ?? '', ...(c.symptoms ?? [])].join(' ').toLowerCase();
            const overlap = pastText.split(/\s+/).filter((w) => w.length > 4 && incidentText.includes(w)).length;
            return { doc: c, score: overlap };
        });

        return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.doc);
    } catch (e) {
        console.error('[memory] recall error:', e.message);
        return [];
    }
}

/**
 * Check if this incident is a recurrence of a known issue.
 * Returns the past incident if recurrence detected (high confidence), null otherwise.
 * @param {import('../ingest/incident.schema.js').Incident} incident
 * @returns {Promise<IncidentMemoryDoc|null>}
 */
export async function detectRecurrence(incident) {
    const matches = await recall(incident);
    if (!matches.length) return null;
    const top = matches[0];
    // Simple recurrence heuristic: same service + same root cause keywords within 30 days
    const ageMs = Date.now() - new Date(top.resolvedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 30) return top;
    return null;
}

/**
 * Store a resolved incident in memory.
 * @param {object} memDoc
 */
export async function remember(memDoc) {
    if (!_collection) return;
    try {
        await _collection.insertOne({ ...memDoc, createdAt: new Date().toISOString() });
        console.log('[memory] remembered incident', memDoc.caseId);
    } catch (e) {
        console.error('[memory] remember error:', e.message);
    }
}
