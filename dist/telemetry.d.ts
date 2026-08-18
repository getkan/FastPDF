export declare function initTelemetry(sentryDsn?: string): void;
export declare function logServerStarted(host: string, port: number): void;
export declare function logUnhandledException(error: unknown, attributes?: Record<string, string | number | boolean>): void;
export declare function shutdownTelemetry(): Promise<void>;
//# sourceMappingURL=telemetry.d.ts.map