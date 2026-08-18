"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const pdf_render_schema_1 = require("./pdf-render.schema");
const sentry_1 = require("../../sentry");
const PdfRenderController = {
    async renderPdf(request, reply) {
        const startTime = Date.now();
        const logger = request.log;
        try {
            const payload = pdf_render_schema_1.RenderRequestSchema.parse(request.body);
            const pdf = await request.server.pdfRenderService.renderHTML(payload.html, payload.options);
            const renderTime = Date.now() - startTime;
            let { filename = 'document' } = payload;
            if (!filename.endsWith('.pdf')) {
                filename += '.pdf';
            }
            reply.header('Content-Disposition', `attachment; filename=${filename}`);
            reply.header('Content-Type', 'application/pdf');
            reply.header('Content-Length', pdf.length);
            logger.info({ requestId: request.id, filename, renderTime, pdfSize: pdf.length }, 'PDF rendered successfully');
            return reply.send(pdf);
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                logger.warn({ requestId: request.id, errors: error.issues }, 'Validation error');
                return reply.status(400).send({
                    success: false,
                    error: 'Invalid Request',
                    details: error.issues
                });
            }
            const errorTime = Date.now() - startTime;
            const renderContext = {
                requestId: request.id,
                errorTime,
                htmlSizeBytes: typeof request.body === 'object' && request.body !== null && 'html' in request.body
                    ? Buffer.byteLength(String(request.body.html ?? ''))
                    : 0,
            };
            logger.error({ err: error, ...renderContext }, 'Rendering failed');
            (0, sentry_1.logUnhandledException)(error, {
                'http.method': request.method,
                'http.target': request.url,
                'request.id': request.id,
                'render.error_time_ms': errorTime,
                'render.html_size_bytes': renderContext.htmlSizeBytes,
            });
            return reply.status(500).send({
                success: false,
                error: 'Failed to render PDF',
            });
        }
    }
};
exports.default = PdfRenderController;
//# sourceMappingURL=pdf-render.controller.js.map