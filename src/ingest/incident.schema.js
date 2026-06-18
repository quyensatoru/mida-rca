/**
 * @typedef {Object} Incident
 * @property {string} id               - internal id (uuid)
 * @property {string} source           - 'mattermost' | 'crm' | 'slack' | 'manual'
 * @property {string} sourceRef        - original id (post id / ticket id)
 * @property {string} title
 * @property {string} description      - raw reporter description
 * @property {string[]} symptoms       - extracted symptoms (Stage 1 fills in)
 * @property {string|null} affectedService - suspected service, e.g. 'sama-api'
 * @property {{from:string|null,to:string|null}} timeWindow - ISO; investigation window
 * @property {'low'|'medium'|'high'|'critical'} severity
 * @property {string|null} domain      - shop domain if known (filter logs/sentry)
 * @property {string} createdAt
 */

/** JSON schema for structured-output at Stage 1 (triage). */
export const INCIDENT_TRIAGE_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        symptoms: { type: 'array', items: { type: 'string' } },
        affectedService: { type: ['string', 'null'] },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        domain: { type: ['string', 'null'] },
        isDuplicate: { type: 'boolean' },
    },
    required: ['title', 'symptoms', 'severity'],
    additionalProperties: false,
};
