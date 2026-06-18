/**
 * Scrub secrets and PII from tool output before it enters the LLM context.
 * Operates on raw text strings (tool result content).
 */

const PATTERNS = [
    // Connection strings / credentials
    [/mongodb(\+srv)?:\/\/[^@\s]+@/gi, 'mongodb://[REDACTED]@'],
    [/redis:\/\/:[^@\s]+@/gi, 'redis://:[REDACTED]@'],
    [/postgresql:\/\/[^@\s]+@/gi, 'postgresql://[REDACTED]@'],
    // Tokens / keys (common patterns)
    [/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g, 'Bearer [REDACTED]'],
    [/(secret|token|key|password|passwd|pwd|auth)\s*[=:]\s*["']?[^\s"',;]+/gi, '$1=[REDACTED]'],
    // JWT (3-part base64)
    [/eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g, '[JWT_REDACTED]'],
    // IP + private ranges (optional — uncomment if needed)
    // [/\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g, '[INTERNAL_IP]'],
    // Email addresses
    [/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]'],
    // Credit card-like sequences
    [/\b(?:\d[ \-]?){13,16}\b/g, '[CARD_REDACTED]'],
];

/** @param {string} text @returns {string} */
export function redact(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    for (const [pattern, replacement] of PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}
