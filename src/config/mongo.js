import mongoose from 'mongoose';
import { ENV } from './env.js';
import { setMemoryCollection } from '../memory/incident.memory.js';
import { setAuditCollection } from '../security/audit.js';
import { setRunsCollection } from '../orchestrator/pipeline.js';

const incidentSchema = new mongoose.Schema(
    {
        caseId: String,
        incidentId: String,
        source: String,
        symptoms: [String],
        affectedService: String,
        domain: String,
        rootCause: mongoose.Schema.Types.Mixed,
        fix: String,
        prUrl: String,
        outcome: String,
        resolvedAt: String,
    },
    { timestamps: true }
);

const rcaRunSchema = new mongoose.Schema(
    {
        caseId: { type: String, index: true },
        incidentId: String,
        startedAt: String,
        completedAt: String,
        durationMs: Number,
        stages: mongoose.Schema.Types.Mixed,
        toolCallCount: Number,
        inputTokens: Number,
        outputTokens: Number,
        costUsd: Number,
        confidence: String,
    },
    { timestamps: true }
);

const rcaAuditSchema = new mongoose.Schema(
    {
        type: String,          // 'tool_call' | 'write_action'
        caseId: { type: String, index: true },
        tool: String,
        action: String,
        inputKeys: [String],
        meta: mongoose.Schema.Types.Mixed,
        ts: String,
    },
    { timestamps: false }
);

let _conn = null;

export async function connectOpsDb() {
    if (_conn) return _conn;
    _conn = await mongoose.createConnection(ENV.opsMongoUri).asPromise();
    console.log('[mongo] ops DB connected');

    const IncidentModel = _conn.model('rca_incidents', incidentSchema);
    setMemoryCollection(IncidentModel.collection);

    const AuditModel = _conn.model('rca_audit', rcaAuditSchema);
    setAuditCollection(AuditModel.collection);

    const RunsModel = _conn.model('rca_runs', rcaRunSchema);
    setRunsCollection(RunsModel.collection);

    return _conn;
}
