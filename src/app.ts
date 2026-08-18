import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyAuth from '@fastify/auth';
import fastifyRateLimit from '@fastify/rate-limit';
import PdfRenderModule from './modules/pdf-render/pdf-render.module';
import AuthModule from './modules/auth/auth.module';
import { logUnhandledException } from './sentry';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Env } from './env';

export async function setupApp(env: Env) {
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

    const app = Fastify({
        logger: loggerConfig,
        bodyLimit: env.MAX_HTML_SIZE,
        // Echo incoming X-Request-Id header; generate one if absent
        requestIdHeader: 'x-request-id',
        genReqId: () => crypto.randomUUID(),
    })

    // Return request ID in every response
    app.addHook('onSend', async (request, reply) => {
        reply.header('x-request-id', request.id);
    });

    await app.register(fastifyRateLimit, {
        max: env.RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_MS,
        keyGenerator: (req) => req.ip,
        errorResponseBuilder: () => ({
            success: false,
            error: 'Too many requests — please slow down.',
        }),
    });

    await app.register(fastifyJwt, {
        secret: env.JWT_SECRET,
        sign: {
            expiresIn: env.JWT_EXPIRES_IN,
        }
    });

    await app.register(fastifyAuth);
    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            await request.jwtVerify();
        } catch (err) {
            reply.code(401).send({ success: false, error: 'Unauthorized' });
        }
    });

    await app.register(AuthModule);
    await app.register(PdfRenderModule);

    app.get('/health', async () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    }));

    app.setErrorHandler(async (err: any, request: FastifyRequest, reply: FastifyReply) => {
        request.log.error({ err });

        const isRateLimitError =
            err?.statusCode === 429
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
            logUnhandledException(err, {
                'http.method': request.method,
                'http.status_code': statusCode,
                'http.target': request.url,
                'request.id': request.id,
            });
        }

        reply.code(statusCode);
        return "Server Error: " + (err?.message || 'An unexpected error occurred');
    })

    app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
        reply.code(404)
        return "Not Found";
    })

    app.addHook('onClose', async () => {
        app.log.info('Server closing')
    });


    return app;
}