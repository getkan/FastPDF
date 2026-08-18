import * as Sentry from '@sentry/node';

let sentryEnabled = false;

function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    if (typeof error === 'string') {
        return new Error(error);
    }

    return new Error('Unknown error');
}

export function initSentry(sentryDsn?: string): void {
    if (!sentryDsn) {
        return;
    }

    Sentry.init({
        dsn: sentryDsn,
        environment: process.env.NODE_ENV,
        tracesSampleRate: 0,
    });
    sentryEnabled = true;
}

export function logUnhandledException(
    error: unknown,
    attributes: Record<string, string | number | boolean> = {},
): string | undefined {
    const normalized = toError(error);

    console.error('FastPDF unhandled exception', normalized, attributes);

    if (!sentryEnabled) {
        return undefined;
    }

    let eventId: string | undefined;
    Sentry.withScope((scope) => {
        for (const [key, value] of Object.entries(attributes)) {
            scope.setTag(key, String(value));
        }
        eventId = Sentry.captureException(normalized);
    });

    return eventId;
}

export async function shutdownSentry(): Promise<void> {
    if (sentryEnabled) {
        await Sentry.close(2_000);
    }
}
