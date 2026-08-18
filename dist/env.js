"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
const zod_1 = require("zod");
const OptionalBlankString = zod_1.z.preprocess((value) => {
    if (typeof value !== 'string') {
        return value;
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}, zod_1.z.string().optional());
const OptionalSentryDsn = zod_1.z.preprocess((value) => {
    if (typeof value !== 'string') {
        return value;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'undefined') {
        return undefined;
    }
    // Ignore doc-style placeholders like https://<key>@o<org>.ingest.sentry.io/<project>
    if (trimmed.includes('<') || trimmed.includes('>')) {
        return undefined;
    }
    return trimmed;
}, zod_1.z.string().url().optional());
function normalizeEnv(rawEnv) {
    const result = {};
    for (const [key, value] of Object.entries(rawEnv)) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        const withoutInlineComment = trimmed.replace(/\s+#.*$/, '');
        result[key] = withoutInlineComment === '' ? undefined : withoutInlineComment;
    }
    return result;
}
const EnvSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    PORT: zod_1.z.coerce.number().int().positive().default(2626),
    HOST: zod_1.z.string().default('0.0.0.0'),
    LOG_LEVEL: zod_1.z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    AUTH_PASSWORD: zod_1.z.string().min(16, 'AUTH_PASSWORD must be at least 16 characters'),
    JWT_SECRET: zod_1.z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: zod_1.z.string().default('1d'),
    MAX_HTML_SIZE: zod_1.z.coerce.number().int().positive().default(5 * 1024 * 1024),
    PUPPETEER_EXECUTABLE_PATH: OptionalBlankString,
    SENTRY_DSN: OptionalSentryDsn,
    RATE_LIMIT_MAX: zod_1.z.coerce.number().int().positive().default(60),
    RATE_LIMIT_WINDOW_MS: zod_1.z.coerce.number().int().positive().default(60000),
    CONCURRENT_RENDERS: zod_1.z.coerce.number().int().min(1).max(50).default(5),
});
function validateEnv() {
    const normalizedEnv = normalizeEnv(process.env);
    const result = EnvSchema.safeParse(normalizedEnv);
    if (!result.success) {
        console.error('Invalid environment configuration — server will not start:');
        for (const issue of result.error.issues) {
            console.error(`  ${issue.path.join('.')}: ${issue.message}`);
        }
        process.exit(1);
    }
    return result.data;
}
//# sourceMappingURL=env.js.map