"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSentry = initSentry;
exports.logUnhandledException = logUnhandledException;
exports.shutdownSentry = shutdownSentry;
const Sentry = __importStar(require("@sentry/node"));
let sentryEnabled = false;
function toError(error) {
    if (error instanceof Error) {
        return error;
    }
    if (typeof error === 'string') {
        return new Error(error);
    }
    return new Error('Unknown error');
}
function initSentry(sentryDsn) {
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
function logUnhandledException(error, attributes = {}) {
    const normalized = toError(error);
    console.error('FastPDF unhandled exception', normalized, attributes);
    if (!sentryEnabled) {
        return;
    }
    Sentry.withScope((scope) => {
        for (const [key, value] of Object.entries(attributes)) {
            scope.setTag(key, String(value));
        }
        Sentry.captureException(normalized);
    });
}
async function shutdownSentry() {
    if (sentryEnabled) {
        await Sentry.close(2000);
    }
}
//# sourceMappingURL=sentry.js.map