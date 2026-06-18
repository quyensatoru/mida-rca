import express from 'express';
import cors from 'cors';
import { ENV } from './config/env.js';

const app = express();
app.use(express.json());
app.use(cors());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'sama-orchestration', version: '0.1.0' }));

// Phase 3 implementation
app.post('/webhook/mattermost', (req, res) => {
    console.log('mattermost event', JSON.stringify(req.body).slice(0, 200));
    res.json({ status: 'accepted' });
});

app.listen(ENV.port, () => console.log(`orchestrator on :${ENV.port}`));
