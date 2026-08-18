"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const puppeteer_1 = __importDefault(require("puppeteer"));
const pino_1 = __importDefault(require("pino"));
const node_fs_1 = require("node:fs");
const logger = (0, pino_1.default)();
class Semaphore {
    constructor(permits) {
        this.queue = [];
        this.permits = permits;
    }
    async acquire() {
        if (this.permits > 0) {
            this.permits--;
            return;
        }
        return new Promise(resolve => this.queue.push(resolve));
    }
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        }
        else {
            this.permits++;
        }
    }
}
class PdfRenderService {
    constructor(concurrentRenders = 5) {
        this.browser = null;
        this.semaphore = new Semaphore(concurrentRenders);
    }
    resolveExecutablePath() {
        const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
        if (configuredPath) {
            return configuredPath;
        }
        const knownSystemBrowsers = [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
        ];
        for (const browserPath of knownSystemBrowsers) {
            if ((0, node_fs_1.existsSync)(browserPath)) {
                return browserPath;
            }
        }
        return undefined;
    }
    async initialize() {
        this.browser = await puppeteer_1.default.launch({
            headless: true,
            executablePath: this.resolveExecutablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        logger.info('Browser initialized within PDFRenderService. Ready to recieve requests');
    }
    ;
    async renderHTML(html, options = {}) {
        await this.semaphore.acquire();
        try {
            if (!this.browser) {
                throw new Error('Browser not available');
            }
            const page = await this.browser.newPage();
            try {
                await page.setViewport({
                    width: options?.width ?? 1920,
                    height: options?.height ?? 1080
                });
                await page.setContent(html, {
                    waitUntil: options?.waitUntil ?? 'networkidle0',
                    timeout: options?.timeout ?? 26260
                });
                const pdfBytes = await page.pdf({
                    format: options?.format ?? 'letter',
                    margin: options?.margin ?? {
                        top: 16,
                        right: 16,
                        bottom: 16,
                        left: 16
                    }
                });
                return Buffer.from(pdfBytes);
            }
            finally {
                await page.close();
            }
        }
        finally {
            this.semaphore.release();
        }
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
        logger.info('Browser closed');
    }
}
;
exports.default = new PdfRenderService(Number(process.env.CONCURRENT_RENDERS ?? 5));
//# sourceMappingURL=pdf-render.service.js.map