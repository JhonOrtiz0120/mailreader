'use strict';

const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');

const MailConnectorFactory = require('../factory/MailConnectorFactory');
const MailboxRepository = require('../repositories/MailboxRepository');
const ZipBufferService = require('./ZipBufferService');
const { DIAN_SUBJECT_REGEX, parseDianSubject, getTipoDocDescripcion } = require('../utils/dianParser');
const { pLimit } = require('../utils/concurrency');

/**
 * Máximo de buzones procesados en paralelo.
 * Con 80+ clientes activos, un valor de 10 es un buen balance
 * entre velocidad y no saturar las APIs externas.
 */
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_MAILBOXES || '10', 10);

/**
 * InvoiceExtractorService — Orquestador Principal
 *
 * Coordina:
 *  1. Carga de buzones desde el repositorio
 *  2. Creación de conectores via Factory
 *  3. Extracción de correos con filtro DIAN
 *  4. Descarga de adjuntos ZIP en memoria
 *  5. Emisión del evento de extracción (JSON estructurado + webhook opcional)
 *
 * El resultado se almacena en memoria (_lastResult) para consulta
 * posterior via GET /api/invoices sin necesidad de re-extraer.
 */
class InvoiceExtractorService {
  constructor() {
    this._lastResult = null;    // Último resultado de extracción
    this._isRunning = false;    // Mutex para evitar extracciones concurrentes
    this._extractionHistory = []; // Historial liviano (últimas 10 sesiones)
  }

  // ─────────────────────────────────────────────────────────────
  // API pública
  // ─────────────────────────────────────────────────────────────

  /**
   * Ejecuta la extracción completa para todos los buzones activos.
   *
   * @param {Object} [options={}]
   * @param {number} [options.limit=50]       - Correos máx. a examinar por buzón
   * @param {Date}   [options.sinceDate]      - Buscar desde esta fecha
   * @param {string} [options.folder]         - Carpeta IMAP (default: INBOX)
   * @param {string[]} [options.mailboxIds]   - IDs específicos de buzones (si se omite, procesa todos)
   *
   * @returns {Promise<ExtractionResult>}
   * @throws {Error} Si ya hay una extracción en curso (usar GET /api/invoices para ver el resultado)
   */
  async extractAll(options = {}) {
    if (this._isRunning) {
      throw new Error('Extracción en curso. Consulte el estado en GET /api/invoices.');
    }

    this._isRunning = true;
    const startedAt = new Date().toISOString();
    const sessionId = uuidv4();

    console.log(`[InvoiceExtractorService] ═══ Iniciando sesión ${sessionId} ═══`);

    try {
      // 1. Cargar buzones
      let mailboxes = await MailboxRepository.getActive();

      // 2. Filtrar por IDs específicos si se indica
      if (options.mailboxIds && options.mailboxIds.length > 0) {
        mailboxes = mailboxes.filter(mb => options.mailboxIds.includes(mb.id));
      }

      if (mailboxes.length === 0) {
        throw new Error('No hay buzones activos configurados. Revise el archivo .env.');
      }

      console.log(`[InvoiceExtractorService] Procesando ${mailboxes.length} buzón(es) con concurrencia ${MAX_CONCURRENT}`);

      // 3. Procesar buzones en paralelo con límite de concurrencia
      const rawResults = await pLimit(mailboxes, MAX_CONCURRENT, (mailbox) =>
        this._processMailbox(mailbox, options)
      );

      // 4. Normalizar resultados
      const mailboxResults = rawResults.map((r, idx) => {
        if (r.status === 'fulfilled') return r.value;

        // Error: construir resultado parcial con información del buzón
        const mailbox = mailboxes[idx];
        console.error(`[InvoiceExtractorService] ✗ Error en buzón [${mailbox.email}]: ${r.reason?.message}`);

        return {
          mailboxId: mailbox.id,
          label: mailbox.label,
          email: mailbox.email,
          provider: mailbox.provider,
          status: 'error',
          error: r.reason?.message || 'Error desconocido',
          invoicesFound: 0,
          invoices: [],
        };
      });

      // 5. Calcular resumen
      const successCount = mailboxResults.filter(r => r.status === 'success').length;
      const totalInvoices = mailboxResults.reduce((acc, mb) => acc + mb.invoicesFound, 0);

      const extractionResult = {
        sessionId,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        summary: {
          totalMailboxes: mailboxes.length,
          successfulMailboxes: successCount,
          failedMailboxes: mailboxResults.length - successCount,
          totalInvoicesFound: totalInvoices,
          bufferStats: ZipBufferService.getStats(),
        },
        mailboxes: mailboxResults,
      };

      // 6. Guardar resultado en memoria
      this._lastResult = extractionResult;
      this._extractionHistory.unshift({ sessionId, startedAt, totalInvoices, successCount });
      if (this._extractionHistory.length > 10) this._extractionHistory.pop(); // Mantener solo 10

      console.log(`[InvoiceExtractorService] ✓ Sesión ${sessionId} completada — ${totalInvoices} factura(s) encontrada(s)`);

      // 7. Emitir evento para microservicios externos
      await this._emitExtractionEvent(extractionResult);

      return extractionResult;

    } finally {
      this._isRunning = false;
    }
  }

  /** Retorna el último resultado de extracción (sin necesidad de re-extraer). */
  getLastResult() {
    return this._lastResult;
  }

  /** Retorna si hay una extracción en curso. */
  isRunning() {
    return this._isRunning;
  }

  /** Retorna el historial de sesiones recientes (sin datos completos). */
  getHistory() {
    return this._extractionHistory;
  }

  // ─────────────────────────────────────────────────────────────
  // Procesamiento de un buzón individual
  // ─────────────────────────────────────────────────────────────

  async _processMailbox(mailbox, options) {
    const connector = MailConnectorFactory.create({
      provider: mailbox.provider,
      credentials: mailbox.credentials,
    });

    try {
      // Conectar
      await connector.connect();

      // Buscar correos DIAN
      const emails = await connector.fetchInvoiceEmails(DIAN_SUBJECT_REGEX, {
        limit: options.limit || 50,
        sinceDate: options.sinceDate,
        folder: options.folder,
      });

      console.log(`[InvoiceExtractorService] [${mailbox.email}] → ${emails.length} correo(s) DIAN encontrado(s)`);

      // Procesar cada correo
      const invoices = [];

      for (const email of emails) {
        const parsed = parseDianSubject(email.subject);
        if (!parsed) continue;

        // Descargar adjuntos ZIP en memoria
        let attachmentBuffers = [];
        try {
          attachmentBuffers = await connector.getAttachmentBuffer(email.id);
        } catch (attErr) {
          console.warn(`[InvoiceExtractorService] Error descargando adjuntos de ${email.id}: ${attErr.message}`);
        }

        // Almacenar buffers y generar tokens de descarga
        const attachments = attachmentBuffers.map(att => {
          const downloadToken = ZipBufferService.store(att.buffer, att.filename, att.mimeType);
          return {
            id: uuidv4(),
            filename: att.filename,
            size: att.size,
            mimeType: att.mimeType,
            downloadToken, // El buffer real NO sale del servicio
          };
        });

        invoices.push({
          id: uuidv4(),
          emailId: email.id,
          subject: email.subject,
          receivedDate: email.receivedDate,
          from: email.from,
          // Campos parseados del asunto DIAN
          nit: parsed.nit,
          nombre: parsed.nombre,
          factura: parsed.factura,
          tipoDoc: parsed.tipoDoc,
          tipoDocDescripcion: getTipoDocDescripcion(parsed.tipoDoc),
          adquirente: parsed.adquirente,
          attachments,
          processedAt: new Date().toISOString(),
        });
      }

      await connector.disconnect();

      return {
        mailboxId: mailbox.id,
        label: mailbox.label,
        email: mailbox.email,
        provider: mailbox.provider,
        status: 'success',
        error: null,
        invoicesFound: invoices.length,
        invoices,
      };

    } catch (err) {
      // Intentar desconectar limpiamente aunque haya error
      try { await connector.disconnect(); } catch (_) { /* ignorar */ }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Emisión de eventos para microservicios externos
  // ─────────────────────────────────────────────────────────────

  /**
   * Emite el resultado de la extracción como evento JSON estructurado.
   * Los buffers NO se incluyen en el evento (solo tokens de descarga).
   *
   * Canales:
   *  1. stdout con el tag [EXTRACTION_EVENT] — captureable por cualquier servicio
   *  2. HTTP POST a WEBHOOK_URL si está configurado en .env
   */
  async _emitExtractionEvent(result) {
    // Serializar sin buffers (ya están en ZipBufferService, se acceden via token)
    const event = {
      type: 'DIAN_EXTRACTION_COMPLETED',
      ...result,
    };

    // Canal 1: stdout estructurado
    console.log(`[EXTRACTION_EVENT] ${JSON.stringify(event)}`);

    // Canal 2: Webhook HTTP/HTTPS
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
      const body = JSON.stringify(event);
      const parsedUrl = new URL(webhookUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      await new Promise((resolve, reject) => {
        const req = client.request(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-SAFITE-Source': 'dian-extractor',
            'X-SAFITE-Session': result.sessionId,
          },
        }, (res) => {
          console.log(`[InvoiceExtractorService] Webhook respondió: HTTP ${res.statusCode}`);
          resolve();
        });

        req.on('error', (err) => {
          console.error(`[InvoiceExtractorService] Error enviando webhook: ${err.message}`);
          resolve(); // No fallar la extracción por error de webhook
        });

        req.setTimeout(5000, () => {
          req.destroy();
          console.warn('[InvoiceExtractorService] Webhook timeout (5s). Ignorando.');
          resolve();
        });

        req.write(body);
        req.end();
      });

    } catch (e) {
      console.error(`[InvoiceExtractorService] Error webhook:`, e.message);
    }
  }
}

// Singleton: una sola instancia mantiene el estado de la extracción
module.exports = new InvoiceExtractorService();
