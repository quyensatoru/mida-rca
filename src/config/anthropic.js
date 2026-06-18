import Anthropic from '@anthropic-ai/sdk';
import { ENV } from './env.js';

export const anthropic = new Anthropic({ apiKey: ENV.anthropicKey });

export const MODELS = {
    REASON: 'claude-opus-4-8',    // root cause, fix plan
    TRIAGE: 'claude-sonnet-4-6',  // log reading, summarize
    CLASSIFY: 'claude-haiku-4-5', // ticket classify/dedup
};
