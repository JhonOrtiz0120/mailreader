'use strict';

/**
 * @abstract
 * Clase base abstracta para todos los conectores de correo del sistema SAFITE DIAN.
 *
 * Define el contrato (interfaz) que deben cumplir:
 *  - MicrosoftConnector  (Microsoft Graph API)
 *  - GoogleConnector     (Gmail API)
 *  - ImapConnector       (IMAP-SSL genérico)
 *
 * Ninguna subclase debe llamar métodos de otra sin pasar por esta interfaz.
 */
class MailConnector {
  /**
   * @param {Object} credentials - Credenciales específicas del proveedor
   */
  constructor(credentials) {
    if (new.target === MailConnector) {
      throw new Error(
        'MailConnector es una clase abstracta y no puede instanciarse directamente. ' +
        'Use MailConnectorFactory.create() para obtener el conector adecuado.'
      );
    }
    this.credentials = credentials;
    this.connected = false;
    this.provider = this.constructor.name;
  }

  // ────────────────────────────────────────────────────────────
  // Métodos abstractos — deben ser implementados por subclases
  // ────────────────────────────────────────────────────────────

  /**
   * Establece la conexión / autenticación con el proveedor de correo.
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error(`${this.provider}: connect() no implementado.`);
  }

  /**
   * Busca correos cuyo asunto coincida con el regex DIAN estándar.
   *
   * @param {RegExp} subjectRegex - Expresión regular para filtrar asuntos DIAN
   * @param {Object} [options={}]
   * @param {number} [options.limit=50]   - Máximo de correos a examinar
   * @param {Date}   [options.sinceDate]  - Buscar solo desde esta fecha
   * @param {string} [options.folder]     - Carpeta a buscar (default: INBOX)
   *
   * @returns {Promise<Array<{id: string, subject: string, receivedDate: string, from: string}>>}
   */
  async fetchInvoiceEmails(subjectRegex, options = {}) {
    throw new Error(`${this.provider}: fetchInvoiceEmails() no implementado.`);
  }

  /**
   * Descarga los archivos .zip adjuntos de un correo específico en memoria.
   * NO escribe nada en disco.
   *
   * @param {string} emailId - Identificador del correo (provider-specific)
   * @returns {Promise<Array<{
   *   attachmentId: string,
   *   filename: string,
   *   size: number,
   *   mimeType: string,
   *   buffer: Buffer
   * }>>}
   */
  async getAttachmentBuffer(emailId) {
    throw new Error(`${this.provider}: getAttachmentBuffer() no implementado.`);
  }

  /**
   * Cierra la conexión / libera recursos del proveedor.
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error(`${this.provider}: disconnect() no implementado.`);
  }

  // ────────────────────────────────────────────────────────────
  // Helpers protegidos
  // ────────────────────────────────────────────────────────────

  /**
   * Verifica que el conector esté conectado antes de operar.
   * @throws {Error} si no está conectado
   */
  _assertConnected() {
    if (!this.connected) {
      throw new Error(
        `${this.provider}: No hay conexión activa. Llame a connect() antes de operar.`
      );
    }
  }

  /**
   * Filtra una lista de adjuntos retornando solo los archivos .zip
   * @param {Array<{name?: string, filename?: string, contentType?: string, mimeType?: string}>} attachments
   * @returns {Array}
   */
  _filterZipAttachments(attachments) {
    return attachments.filter(att => {
      const name = (att.name || att.filename || '').toLowerCase();
      const type = (att.contentType || att.mimeType || '').toLowerCase();
      return name.endsWith('.zip') || type.includes('zip');
    });
  }
}

module.exports = MailConnector;
