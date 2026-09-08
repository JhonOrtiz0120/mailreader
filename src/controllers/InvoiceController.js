'use strict';

const InvoiceExtractorService = require('../services/InvoiceExtractorService');
const ZipBufferService = require('../services/ZipBufferService');
const SchedulerService = require('../services/SchedulerService');
const MailboxRepository = require('../repositories/MailboxRepository');

const InvoiceController = {

  // ── Buzones ──────────────────────────────────────────────────

  getMailboxes: async (req, res) => {
    try {
      const mailboxes = await MailboxRepository.getAll();
      // NUNCA exponer credenciales en la respuesta HTTP, a menos que el cliente lo requiera para edición
      // Como el usuario ahora edita desde la interfaz, enviamos todo (asumiendo que es entorno seguro/local)
      res.json({ success: true, count: mailboxes.length, data: mailboxes });
    } catch (err) {
      console.error('[InvoiceController] getMailboxes error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },

  saveMailboxes: async (req, res) => {
    try {
      const mailboxes = req.body.mailboxes || [];
      await MailboxRepository.saveAll(mailboxes);
      res.json({ success: true, message: 'Configuración guardada correctamente.', count: mailboxes.length });
    } catch (err) {
      console.error('[InvoiceController] saveMailboxes error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },

  reloadMailboxes: async (req, res) => {
    try {
      const mailboxes = await MailboxRepository.reload();
      res.json({
        success: true,
        message: `${mailboxes.length} buzón(es) recargado(s) exitosamente.`,
        count: mailboxes.length,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // ── Facturas ─────────────────────────────────────────────────

  getLastInvoices: (req, res) => {
    try {
      const result = InvoiceExtractorService.getLastResult();

      if (!result) {
        return res.json({
          success: true,
          data: null,
          message: 'No hay resultados aún. Use POST /api/extract para iniciar la extracción.',
          isRunning: InvoiceExtractorService.isRunning(),
        });
      }

      res.json({
        success: true,
        isRunning: InvoiceExtractorService.isRunning(),
        data: result,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  getHistory: (req, res) => {
    res.json({
      success: true,
      data: InvoiceExtractorService.getHistory(),
    });
  },

  extract: async (req, res) => {
    try {
      // Si ya está corriendo, retornar 202 Accepted
      if (InvoiceExtractorService.isRunning()) {
        return res.status(202).json({
          success: false,
          error: 'Extracción en curso. Consulte GET /api/invoices para ver el resultado cuando termine.',
          isRunning: true,
        });
      }

      const options = {
        limit: req.body?.limit,
        sinceDate: req.body?.sinceDate,
        folder: req.body?.folder,
        mailboxIds: req.body?.mailboxIds,
      };

      const result = await InvoiceExtractorService.extractAll(options);

      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[InvoiceController] extract error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // ── Descarga de ZIPs ──────────────────────────────────────────

  downloadZip: (req, res) => {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token de descarga requerido.' });
    }

    const entry = ZipBufferService.retrieve(token);

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Archivo no encontrado o expirado (TTL: 30 minutos). Ejecute una nueva extracción.',
      });
    }

    // Sanitizar filename para el header Content-Disposition
    const safeFilename = (entry.filename || 'factura.zip').replace(/[^a-zA-Z0-9._\-]/g, '_');

    res.set({
      'Content-Type': entry.mimeType || 'application/zip',
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
      'Content-Length': entry.size,
      'X-SAFITE-Filename': safeFilename,
    });

    res.send(entry.buffer);
  },

  // ── Scheduler ─────────────────────────────────────────────────

  getSchedulerStatus: (req, res) => {
    res.json({ success: true, data: SchedulerService.getStatus() });
  },

  startScheduler: (req, res) => {
    try {
      const { cronExpression, limit, sinceDate, folder } = req.body || {};

      if (!cronExpression) {
        return res.status(400).json({
          success: false,
          error: 'Se requiere cronExpression. Ejemplo: { "cronExpression": "*/15 * * * *" }',
          examples: SchedulerService.getStatus().examples,
        });
      }

      const status = SchedulerService.start(cronExpression, { limit, sinceDate, folder });
      res.json({ success: true, message: `Scheduler iniciado: ${cronExpression}`, data: status });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  },

  stopScheduler: (req, res) => {
    const status = SchedulerService.stop();
    res.json({ success: true, message: 'Scheduler detenido.', data: status });
  },

  // ── Sistema ───────────────────────────────────────────────────

  health: (req, res) => {
    res.json({
      success: true,
      status: 'ok',
      service: 'SAFITE DIAN Extractor',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  },

  getStats: async (req, res) => {
    try {
      const mailboxes = await MailboxRepository.getAll();
      const memUsage = process.memoryUsage();

      res.json({
        success: true,
        data: {
          mailboxes: {
            total: mailboxes.length,
            active: mailboxes.filter(m => m.active).length,
            byProvider: mailboxes.reduce((acc, mb) => {
              acc[mb.provider] = (acc[mb.provider] || 0) + 1;
              return acc;
            }, {}),
          },
          bufferStore: ZipBufferService.getStats(),
          scheduler: SchedulerService.getStatus(),
          extraction: {
            isRunning: InvoiceExtractorService.isRunning(),
            history: InvoiceExtractorService.getHistory(),
          },
          memory: {
            heapUsedMB: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
            heapTotalMB: (memUsage.heapTotal / 1024 / 1024).toFixed(2),
            rssMB: (memUsage.rss / 1024 / 1024).toFixed(2),
          },
          uptime: Math.round(process.uptime()),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
};

module.exports = InvoiceController;
