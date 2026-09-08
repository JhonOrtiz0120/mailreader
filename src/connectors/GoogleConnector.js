'use strict';

const { google } = require('googleapis');
const MailConnector = require('./base/MailConnector');

/**
 * Conector para Gmail / Google Workspace via Gmail API v1.
 *
 * Soporta dos modos de autenticación:
 *
 *  1) Service Account (recomendado para Workspace):
 *     - credentials.authType = 'service_account'
 *     - credentials.clientEmail  — email de la service account
 *     - credentials.privateKey   — clave privada PEM (con \n escapados en .env)
 *     - credentials.userEmail    — usuario a impersonar (Domain-Wide Delegation)
 *
 *  2) OAuth2 con Refresh Token (para cuentas personales/Gmail):
 *     - credentials.authType = 'oauth2'
 *     - credentials.clientId
 *     - credentials.clientSecret
 *     - credentials.refreshToken
 *     - credentials.userEmail
 */
class GoogleConnector extends MailConnector {
  constructor(credentials) {
    super(credentials);
    this._gmail = null;
    this._auth = null;
  }

  // ── Conexión ────────────────────────────────────────────────

  async connect() {
    const { authType, userEmail } = this.credentials;

    if (!authType) {
      throw new Error('GoogleConnector: Se requiere credentials.authType ("service_account" | "oauth2").');
    }

    if (authType === 'service_account') {
      const { clientEmail, privateKey } = this.credentials;

      if (!clientEmail || !privateKey) {
        throw new Error('GoogleConnector [service_account]: Se requieren clientEmail y privateKey.');
      }

      this._auth = new google.auth.JWT({
        email: clientEmail,
        key: privateKey.replace(/\\n/g, '\n'), // Normalizar saltos de línea del .env
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        subject: userEmail, // Domain-Wide Delegation: impersonar al usuario
      });

    } else if (authType === 'oauth2') {
      const { clientId, clientSecret, refreshToken } = this.credentials;

      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('GoogleConnector [oauth2]: Se requieren clientId, clientSecret y refreshToken.');
      }

      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      this._auth = oauth2Client;

    } else {
      throw new Error(`GoogleConnector: authType "${authType}" no soportado. Use "service_account" u "oauth2".`);
    }

    // Verificar credenciales obteniendo un access token
    await this._auth.getAccessToken();

    this._gmail = google.gmail({ version: 'v1', auth: this._auth });
    this.connected = true;
    console.log(`[GoogleConnector] ✓ Conectado [${authType}] — buzón: ${userEmail}`);
  }

  // ── Búsqueda de correos DIAN ─────────────────────────────────

  async fetchInvoiceEmails(subjectRegex, options = {}) {
    this._assertConnected();

    const maxResults = options.limit || 50;

    // Gmail query: correos con adjuntos ZIP
    // El filtro por asunto con regex se hace client-side
    const q = 'has:attachment filename:zip';

    const listResp = await this._gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults,
    });

    const messages = listResp.data.messages || [];
    if (messages.length === 0) return [];

    // Obtener metadatos en lotes (con Promise.allSettled para resiliencia)
    const metaResults = await Promise.allSettled(
      messages.map(msg =>
        this._gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'Date', 'From'],
        })
      )
    );

    const matched = [];

    for (const result of metaResults) {
      if (result.status === 'rejected') continue;

      const detail = result.value.data;
      const headers = detail.payload?.headers || [];

      const subject = this._getHeader(headers, 'Subject');
      const date = this._getHeader(headers, 'Date');
      const from = this._getHeader(headers, 'From');

      if (subjectRegex.test(subject)) {
        matched.push({
          id: detail.id,
          subject,
          receivedDate: date,
          from,
        });
      }
    }

    return matched;
  }

  // ── Descarga de adjuntos ZIP en memoria ──────────────────────

  async getAttachmentBuffer(emailId) {
    this._assertConnected();

    // Obtener estructura completa del mensaje para navegar las partes MIME
    const detail = await this._gmail.users.messages.get({
      userId: 'me',
      id: emailId,
      format: 'full',
    });

    // Extraer referencias a partes ZIP recursivamente
    const zipParts = [];
    this._extractZipParts(detail.data.payload, emailId, zipParts);

    // Descargar cada adjunto ZIP como Buffer
    const results = [];

    for (const part of zipParts) {
      try {
        const attResp = await this._gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: emailId,
          id: part.attachmentId,
        });

        // Gmail usa base64url (- en lugar de +, _ en lugar de /)
        const base64 = (attResp.data.data || '')
          .replace(/-/g, '+')
          .replace(/_/g, '/');

        const buffer = Buffer.from(base64, 'base64');

        results.push({
          attachmentId: part.attachmentId,
          filename: part.filename,
          size: buffer.length,
          mimeType: part.mimeType || 'application/zip',
          buffer,
        });
      } catch (err) {
        console.warn(`[GoogleConnector] Error descargando adjunto ${part.filename}: ${err.message}`);
      }
    }

    return results;
  }

  // ── Desconexión ──────────────────────────────────────────────

  async disconnect() {
    this._gmail = null;
    this._auth = null;
    this.connected = false;
    console.log(`[GoogleConnector] Desconectado — buzón: ${this.credentials.userEmail}`);
  }

  // ── Helpers privados ─────────────────────────────────────────

  /**
   * Recorre recursivamente las partes MIME buscando adjuntos .zip
   */
  _extractZipParts(part, emailId, results) {
    if (!part) return;

    const filename = part.filename || '';
    const mimeType = part.mimeType || '';

    if (
      part.body?.attachmentId &&
      (filename.toLowerCase().endsWith('.zip') || mimeType.toLowerCase().includes('zip'))
    ) {
      results.push({
        emailId,
        attachmentId: part.body.attachmentId,
        filename: filename || `attachment_${results.length + 1}.zip`,
        mimeType,
      });
    }

    // Navegar subpartes (multipart/*)
    if (part.parts && Array.isArray(part.parts)) {
      for (const subPart of part.parts) {
        this._extractZipParts(subPart, emailId, results);
      }
    }
  }

  /**
   * Obtiene el valor de un header específico de la lista de headers de Gmail.
   */
  _getHeader(headers, name) {
    return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  }
}

module.exports = GoogleConnector;
