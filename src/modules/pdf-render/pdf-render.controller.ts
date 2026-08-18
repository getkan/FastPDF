import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RenderRequestSchema } from './pdf-render.schema';
import { logUnhandledException } from '../../sentry';

const PdfRenderController = {
  async renderPdf(request: FastifyRequest, reply: FastifyReply) {
    const startTime = Date.now();
    const logger = request.log;

    try {
      const payload = RenderRequestSchema.parse(request.body);
      const pdf = await request.server.pdfRenderService.renderHTML(payload.html, payload.options);
      const renderTime = Date.now() - startTime;

      let { filename = 'document' } = payload;
      if (!filename.endsWith('.pdf')) {
        filename += '.pdf'
      }
      reply.header('Content-Disposition', `attachment; filename=${filename}`)
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Length', pdf.length);

      logger.info({ requestId: request.id, filename, renderTime, pdfSize: pdf.length }, 'PDF rendered successfully')

      return reply.send(pdf);

    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.warn({ requestId: request.id, errors: error.issues }, 'Validation error');
        return reply.status(400).send({
          success: false,
          error: 'Invalid Request',
          details: error.issues
        })
      }

      const errorTime = Date.now() - startTime;
      const renderContext = {
        requestId: request.id,
        errorTime,
        htmlSizeBytes: typeof request.body === 'object' && request.body !== null && 'html' in request.body
          ? Buffer.byteLength(String((request.body as { html?: unknown }).html ?? ''))
          : 0,
      };
      logger.error({ err: error, ...renderContext }, 'Rendering failed');
      logUnhandledException(error, {
        'http.method': request.method,
        'http.target': request.url,
        'request.id': request.id,
        'render.error_time_ms': errorTime,
        'render.html_size_bytes': renderContext.htmlSizeBytes,
      });
      return reply.status(500).send({
        success: false,
        error: 'Failed to render PDF',
      })
    }
  }
}

export default PdfRenderController;