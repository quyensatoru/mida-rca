import mongoose from 'mongoose';
import { ENV } from './env.js';
import { setMemoryCollection } from '../memory/incident.memory.js';

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

let _conn = null;

export async function connectOpsDb() {
    if (_conn) return _conn;
    _conn = await mongoose.createConnection(ENV.opsMongoUri).asPromise();
    console.log('[mongo] ops DB connected');

    const IncidentModel = _conn.model('rca_incidents', incidentSchema);
    setMemoryCollection(IncidentModel.collection);

    return _conn;
}
