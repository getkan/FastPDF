import type { RenderOptions } from './pdf-render.types';
declare class PdfRenderService {
    private browser;
    private semaphore;
    constructor(concurrentRenders?: number);
    private resolveExecutablePath;
    initialize(): Promise<void>;
    renderHTML(html: string, options?: RenderOptions): Promise<Buffer>;
    close(): Promise<void>;
}
declare const _default: PdfRenderService;
export default _default;
//# sourceMappingURL=pdf-render.service.d.ts.map