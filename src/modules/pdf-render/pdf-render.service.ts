import puppeteer, { Browser } from 'puppeteer';
import type { RenderOptions } from './pdf-render.types';
import pino from 'pino';
import { existsSync } from 'node:fs';

const logger = pino();

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

class PdfRenderService {
  private browser: Browser | null = null;
  private semaphore: Semaphore;

  constructor(concurrentRenders = 5) {
    this.semaphore = new Semaphore(concurrentRenders);
  }

  private resolveExecutablePath(): string | undefined {
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
      if (existsSync(browserPath)) {
        return browserPath;
      }
    }

    return undefined;
  }

  async initialize(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: this.resolveExecutablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })

    logger.info('Browser initialized within PDFRenderService. Ready to recieve requests')
  };

  async renderHTML(html: string, options: RenderOptions = {}): Promise<Buffer> {
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
          waitUntil: options?.waitUntil as any ?? 'networkidle0',
          timeout: options?.timeout ?? 26260
        });

        const pdfBytes = await page.pdf({
          format: options?.format as any ?? 'letter',
          margin: options?.margin ?? {
            top: 16,
            right: 16,
            bottom: 16,
            left: 16
          }
        });

        return Buffer.from(pdfBytes);
      } finally {
        await page.close();
      }
    } finally {
      this.semaphore.release();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    logger.info('Browser closed');
  }
};

export default new PdfRenderService(
  Number(process.env.CONCURRENT_RENDERS ?? 5)
);
