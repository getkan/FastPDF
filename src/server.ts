
import dotenv from 'dotenv';
dotenv.config();

import { validateEnv } from './env';
import { initSentry, shutdownSentry } from './sentry';
import { setupApp } from './app';

const env = validateEnv();
initSentry(env.SENTRY_DSN);

async function start() {
    const app = await setupApp(env);

    process.on('SIGTERM', async () => {
        await app.close();
        await shutdownSentry();
    });

    await app.listen({ port: env.PORT, host: env.HOST });
}

start().catch((error) => {
    return shutdownSentry().finally(() => process.exit(1));
});