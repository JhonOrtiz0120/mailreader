'use strict';

const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const MailConnector = require('./base/MailConnector');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Conector para Microsoft 365 / Exchange Online via Microsoft Graph API.
 *
 * Autenticación: OAuth 2.0 — Client Credentials Flow (app-only).
 * Requiere permisos de aplicación en Azure AD:
 *   - Mail.Read (Microsoft Graph)
 *
 * Credenciales requeridas:
 * @param {string} credentials.tenantId     - ID del tenant de Azure AD
 * @param {string} credentials.clientId     - Application (client) ID
 * @param {string} credentials.clientSecret - Client secret value
 * @param {string} credentials.userEmail    - Email del buzón a leer (UPN)
 */
class MicrosoftConnector extends MailConnector {
  constructor(credentials) {
    super(credentials);
    this._accessToken = null;
    this._msalApp = null;
  }

  // ── Conexión ────────────────────────────────────────────────

  async connect() {
    const { tenantId, clientId, clientSecret } = this.credentials;

    if (!tenantId || !clientId || !clientSecret) {
      throw new Error('MicrosoftConnector: faltan credenciales (tenantId, clientId, clientSecret).');
    }

    this._msalApp = new ConfidentialClientApplication({
      auth: {
        clientId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    });

    const tokenResponse = await this._msalApp.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default'],
    });

    this._accessToken = tokenResponse.accessToken;
    this.connected = true;
    console.log(`[MicrosoftConnector] ✓ Conectado — buzón: ${this.credentials.userEmail}`);
  }

  // ── Búsqueda de correos DIAN ─────────────────────────────────

  async fetchInvoiceEmails(subjectRegex, options = {}) {
    this._assertConnected();

    const { userEmail } = this.credentials;
    const folder = options.folder || 'inbox';
    const top = options.limit || 50;

    // Graph API: filtrar por hasAttachments para reducir tráfico
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/mailFolders/${folder}/messages` +
      `?$top=${top}&$select=id,subject,receivedDateTime,hasAttachments,from` +
      `&$filter=hasAttachments eq true` +
      `&$orderby=receivedDateTime desc`;

    const response = await this._graphRequest('GET', url);
    const messages = response.value || [];

    // Filtro client-side con regex DIAN (Graph no soporta regex en $filter)
    const matched = messages.filter(msg => subjectRegex.test(msg.subject || ''));

    return matched.map(msg => ({
      id: msg.id,
      subject: msg.subject,
      receivedDate: msg.receivedDateTime,
      from: msg.from?.emailAddress?.address || msg.from?.emailAddress?.name || '',
    }));
  }

  // ── Descarga de adjuntos ZIP en memoria ──────────────────────

  async getAttachmentBuffer(emailId) {
    this._assertConnected();

    const { userEmail } = this.credentials;
    const listUrl = `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/messages/${emailId}/attachments` +
      `?$select=id,name,contentType,size`;

    const listResp = await this._graphRequest('GET', listUrl);
    const zipAttachments = this._filterZipAttachments(listResp.value || []);

    const results = [];

    for (const att of zipAttachments) {
      const attUrl = `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/messages/${emailId}/attachments/${att.id}`;
      const fullAtt = await this._graphRequest('GET', attUrl);

      if (!fullAtt.contentBytes) {
        console.warn(`[MicrosoftConnector] Adjunto sin contentBytes: ${att.name}`);
        continue;
      }

      const buffer = Buffer.from(fullAtt.contentBytes, 'base64');
      results.push({
        attachmentId: att.id,
        filename: att.name,
        size: buffer.length,
        mimeType: att.contentType || 'application/zip',
        buffer,
      });
    }

    return results;
  }

  // ── Desconexión ──────────────────────────────────────────────

  async disconnect() {
    this._accessToken = null;
    this._msalApp = null;
    this.connected = false;
    console.log(`[MicrosoftConnector] Desconectado — buzón: ${this.credentials.userEmail}`);
  }

  // ── Helpers privados ─────────────────────────────────────────

  /**
   * Hace una petición autenticada a Microsoft Graph API.
   * @param {string} method - HTTP method
   * @param {string} url    - URL completa del endpoint
   * @param {Object} [body] - Cuerpo opcional (para POST/PATCH)
   * @returns {Promise<Object>}
   */
  _graphRequest(method, url, body = null) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          Authorization: `Bearer ${this._accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(raw);

            if (parsed.error) {
              reject(new Error(`Graph API [${parsed.error.code}]: ${parsed.error.message}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Graph API: Error parseando respuesta — ${e.message}`));
          }
        });
      });

      req.on('error', reject);

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

module.exports = MicrosoftConnector;
