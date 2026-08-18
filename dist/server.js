"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const env_1 = require("./env");
const sentry_1 = require("./sentry");
const app_1 = require("./app");
const env = (0, env_1.validateEnv)();
(0, sentry_1.initSentry)(env.SENTRY_DSN);
async function start() {
    const app = await (0, app_1.setupApp)(env);
    process.on('SIGTERM', async () => {
        await app.close();
        await (0, sentry_1.shutdownSentry)();
    });
    await app.listen({ port: env.PORT, host: env.HOST });
}
start().catch((error) => {
    return (0, sentry_1.shutdownSentry)().finally(() => process.exit(1));
});
//# sourceMappingURL=server.js.map