import { z } from 'zod';

const OptionalBlankString = z.preprocess((value) => {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}, z.string().optional());

const OptionalSentryDsn = z.preprocess((value) => {
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
}, z.string().url().optional());

function normalizeEnv(rawEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};

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

const EnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(2626),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    AUTH_PASSWORD: z.string().min(16, 'AUTH_PASSWORD must be at least 16 characters'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('1d'),
    MAX_HTML_SIZE: z.coerce.number().int().positive().default(5 * 1024 * 1024),
    PUPPETEER_EXECUTABLE_PATH: OptionalBlankString,
    SENTRY_DSN: OptionalSentryDsn,
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    CONCURRENT_RENDERS: z.coerce.number().int().min(1).max(50).default(5),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(): Env {
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
