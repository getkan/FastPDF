import dotenv from 'dotenv';
import { initSentry, logUnhandledException, shutdownSentry } from '../src/sentry';

dotenv.config();

const dsn = process.env.SENTRY_DSN?.trim();

if (!dsn) {
    throw new Error('SENTRY_DSN is required to run the Sentry smoke test');
}

async function main(): Promise<void> {
    initSentry(dsn);
    const eventId = logUnhandledException(new Error('FastPDF Sentry smoke test failure'), {
        'test.name': 'sentry-smoke',
        'test.source': 'manual',
    });

    await shutdownSentry();
    console.log(`Sentry smoke-test event flushed. Event ID: ${eventId ?? 'not captured'}`);
    console.log('Search Sentry for: FastPDF Sentry smoke test failure');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
