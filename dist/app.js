"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupApp = setupApp;
const fastify_1 = __importDefault(require("fastify"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const auth_1 = __importDefault(require("@fastify/auth"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const pdf_render_module_1 = __importDefault(require("./modules/pdf-render/pdf-render.module"));
const auth_module_1 = __importDefault(require("./modules/auth/auth.module"));
const sentry_1 = require("./sentry");
async function setupApp(env) {
    const isProduction = env.NODE_ENV === 'production';
    const loggerConfig = isProduction
        ? {
            level: env.LOG_LEVEL
        }
        : {
            level: env.LOG_LEVEL,
            transport: {
                target: 'pino-pretty',
                options: {
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname'
                }
            }
        };
    const app = (0, fastify_1.default)({
        logger: loggerConfig,
        bodyLimit: env.MAX_HTML_SIZE,
        // Echo incoming X-Request-Id header; generate one if absent
        requestIdHeader: 'x-request-id',
        genReqId: () => crypto.randomUUID(),
    });
    // Return request ID in every response
    app.addHook('onSend', async (request, reply) => {
        reply.header('x-request-id', request.id);
    });
    await app.register(rate_limit_1.default, {
        max: env.RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_MS,
        keyGenerator: (req) => req.ip,
        errorResponseBuilder: () => ({
            success: false,
            error: 'Too many requests — please slow down.',
        }),
    });
    await app.register(jwt_1.default, {
        secret: env.JWT_SECRET,
        sign: {
            expiresIn: env.JWT_EXPIRES_IN,
        }
    });
    await app.register(auth_1.default);
    app.decorate('authenticate', async (request, reply) => {
        try {
            await request.jwtVerify();
        }
        catch (err) {
            reply.code(401).send({ success: false, error: 'Unauthorized' });
        }
    });
    await app.register(auth_module_1.default);
    await app.register(pdf_render_module_1.default);
    app.get('/health', async () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    }));
    app.setErrorHandler(async (err, request, reply) => {
        request.log.error({ err });
        const isRateLimitError = err?.statusCode === 429
            || err?.code === 'FST_ERR_RATE_LIMIT'
            || err?.message === 'Too many requests — please slow down.'
            || err?.error === 'Too many requests — please slow down.';
        if (isRateLimitError) {
            return reply.code(429).send({
                success: false,
                error: 'Too many requests — please slow down.',
            });
        }
        const statusCode = err?.statusCode || 500;
        if (statusCode >= 500) {
            (0, sentry_1.logUnhandledException)(err, {
                'http.method': request.method,
                'http.status_code': statusCode,
                'http.target': request.url,
                'request.id': request.id,
            });
        }
        reply.code(statusCode);
        return "Server Error: " + (err?.message || 'An unexpected error occurred');
    });
    app.setNotFoundHandler(async (request, reply) => {
        reply.code(404);
        return "Not Found";
    });
    app.addHook('onClose', async () => {
        app.log.info('Server closing');
    });
    return app;
}
//# sourceMappingURL=app.js.map