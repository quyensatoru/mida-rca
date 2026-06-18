/**
 * Adapter interface — all ticket source adapters must implement this.
 *
 * @typedef {Object} IncidentAdapter
 * @property {function(payload: any): import('./incident.schema.js').Incident} parse
 *   Parse raw webhook payload into a canonical Incident object.
 * @property {function(ref: string, markdown: string): Promise<void>} postReply
 *   Post a reply (Fix Plan) back to the source channel/thread.
 * @property {function(cb: function(ref: string): void): void} onApproval
 *   Register a callback invoked when a human approves a Fix Plan.
 *   cb receives the sourceRef (post id / ticket id) of the approved case.
 */

/**
 * Validate that an object implements the adapter interface.
 * @param {any} adapter
 */
export function validateAdapter(adapter) {
    const required = ['parse', 'postReply', 'onApproval'];
    const missing = required.filter((m) => typeof adapter[m] !== 'function');
    if (missing.length) throw new Error(`Adapter missing methods: ${missing.join(', ')}`);
}
