'use strict';

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const MailConnector = require('./base/MailConnector');

/**
 * Conector genérico IMAP-SSL para servidores de correo propios.
 * Compatible con: cPanel, Hostinger, Plesk, Directadmin, Zimbra, etc.
 *
 * Credenciales requeridas:
 * @param {string} credentials.host       - Servidor IMAP (ej: mail.empresa.com)
 * @param {number} credentials.port       - Puerto (993 para TLS, 143 para STARTTLS)
 * @param {string} credentials.user       - Usuario / email
 * @param {string} credentials.password   - Contraseña
 * @param {boolean} [credentials.tls]     - Usar TLS (default: true)
 * @param {string} [credentials.mailbox]  - Carpeta IMAP (default: INBOX)
 */
class ImapConnector extends MailConnector {
  constructor(credentials) {
    super(credentials);
    this._imap = null;
  }

  // ── Conexión ────────────────────────────────────────────────

  async connect() {
    const {
      host, port, user, password,
      tls = true,
    } = this.credentials;

    if (!host || !user || !password) {
      throw new Error('ImapConnector: Se requieren host, user y password.');
    }

    return new Promise((resolve, reject) => {
      const imapConfig = {
        user,
        password,
        host,
        port: parseInt(port || 993, 10),
        tls,
        tlsOptions: { rejectUnauthorized: false }, // Tolerante con certs auto-firmados
        connTimeout: 15000,
        authTimeout: 10000,
        keepalive: true,
      };

      this._imap = new Imap(imapConfig);

      this._imap.once('ready', () => {
        this.connected = true;
        console.log(`[ImapConnector] ✓ Conectado a ${host}:${port} — usuario: ${user}`);
        resolve();
      });

      this._imap.once('error', (err) => {
        this.connected = false;
        reject(new Error(`ImapConnector [${host}]: ${err.message}`));
      });

      this._imap.once('end', () => {
        this.connected = false;
      });

      this._imap.connect();
    });
  }

  // ── Búsqueda de correos DIAN ─────────────────────────────────

  async fetchInvoiceEmails(subjectRegex, options = {}) {
    this._assertConnected();

    const mailbox = options.folder || this.credentials.mailbox || 'INBOX';
    const limit = options.limit || 50;
    const sinceDate = this._resolveSinceDate(options.sinceDate);

    // Abrir buzón en modo read-only
    await this._openBox(mailbox, true);

    // Buscar UIDs desde una fecha
    const uids = await this._search([['SINCE', sinceDate]]);
    if (!uids || uids.length === 0) return [];

    // Tomar los más recientes (slice al final del array)
    const toFetch = uids.slice(-limit);

    // Obtener solo headers para el filtrado (más eficiente)
    const headerMessages = await this._fetchHeaders(toFetch);

    // Aplicar filtro DIAN regex + verificar que tiene adjuntos ZIP
    const matched = headerMessages.filter(msg =>
      msg.hasZipAttachment && subjectRegex.test(msg.subject)
    );

    return matched.map(msg => ({
      id: String(msg.uid),
      subject: msg.subject,
      receivedDate: msg.date,
      from: msg.from,
    }));
  }

  // ── Descarga de adjuntos ZIP en memoria ──────────────────────

  async getAttachmentBuffer(emailId) {
    this._assertConnected();

    const uid = parseInt(emailId, 10);
    const rawBuffer = await this._fetchFullMessage(uid);

    // Parsear el mensaje completo con mailparser
    const parsed = await simpleParser(rawBuffer);

    const zipAttachments = this._filterZipAttachments(
      parsed.attachments || []
    );

    return zipAttachments.map((att, idx) => ({
      attachmentId: `${emailId}-${att.filename || idx}`,
      filename: att.filename || `factura_${idx + 1}.zip`,
      size: att.size || (att.content ? att.content.length : 0),
      mimeType: att.contentType || 'application/zip',
      buffer: att.content, // Buffer en memoria
    }));
  }

  // ── Desconexión ──────────────────────────────────────────────

  async disconnect() {
    if (this._imap && this.connected) {
      this._imap.end();
    }
    this._imap = null;
    this.connected = false;
    console.log(`[ImapConnector] Desconectado — usuario: ${this.credentials.user}`);
  }

  // ── Helpers privados ─────────────────────────────────────────

  /** Abre una carpeta IMAP */
  _openBox(name, readOnly) {
    return new Promise((resolve, reject) => {
      this._imap.openBox(name, readOnly, (err, box) => {
        if (err) return reject(new Error(`ImapConnector: Error abriendo carpeta "${name}": ${err.message}`));
        resolve(box);
      });
    });
  }

  /** Busca UIDs de mensajes por criterios IMAP */
  _search(criteria) {
    return new Promise((resolve, reject) => {
      this._imap.search(criteria, (err, uids) => {
        if (err) return reject(err);
        resolve(uids || []);
      });
    });
  }

  /**
   * Obtiene headers y estructura de mensajes para filtrado.
   * Usa un solo fetch para todos los UIDs (eficiente para 80+ buzones).
   */
  _fetchHeaders(uids) {
    return new Promise((resolve, reject) => {
      if (!uids.length) return resolve([]);

      const fetch = this._imap.fetch(uids, {
        bodies: 'HEADER.FIELDS (SUBJECT FROM DATE)',
        struct: true,
      });

      const messages = [];

      fetch.on('message', (msg) => {
        const entry = {
          uid: null,
          subject: '',
          from: '',
          date: '',
          hasZipAttachment: false,
        };

        msg.on('body', (stream) => {
          const chunks = [];
          stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          stream.once('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const headers = Imap.parseHeader(raw);
            entry.subject = (headers.subject || [''])[0] || '';
            entry.from = (headers.from || [''])[0] || '';
            entry.date = (headers.date || [''])[0] || '';
          });
        });

        msg.once('attributes', (attrs) => {
          entry.uid = attrs.uid;
          entry.hasZipAttachment = this._structHasZip(attrs.struct);
        });

        msg.once('end', () => messages.push(entry));
      });

      fetch.once('error', reject);
      fetch.once('end', () => resolve(messages));
    });
  }

  /**
   * Descarga el cuerpo completo de un mensaje (necesario para parsear adjuntos).
   */
  _fetchFullMessage(uid) {
    return new Promise((resolve, reject) => {
      const fetch = this._imap.fetch([uid], { bodies: '', uid: true });
      const chunks = [];

      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        });
      });

      fetch.once('error', reject);
      fetch.once('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * Inspecciona la estructura IMAP de un mensaje para detectar adjuntos ZIP.
   * Evita descargar el mensaje completo solo para saber si tiene ZIPs.
   */
  _structHasZip(struct) {
    if (!struct || !Array.isArray(struct)) return false;

    const flatten = (s) => {
      const parts = [];
      for (const item of s) {
        if (Array.isArray(item)) {
          parts.push(...flatten(item));
        } else if (item && typeof item === 'object' && item.type) {
          parts.push(item);
        }
      }
      return parts;
    };

    const parts = flatten(struct);
    return parts.some(part => {
      const dispType = (part.disposition?.type || '').toLowerCase();
      const partType = (part.type || '').toLowerCase();
      const subType = (part.subtype || '').toLowerCase();
      const name = (part.params?.name || part.disposition?.params?.filename || '').toLowerCase();

      return (
        (dispType === 'attachment' || name.endsWith('.zip')) &&
        (partType.includes('zip') || subType.includes('zip') || name.endsWith('.zip'))
      );
    });
  }

  /** Calcula la fecha "desde" para la búsqueda (default: últimos 30 días) */
  _resolveSinceDate(sinceDate) {
    if (sinceDate instanceof Date) return sinceDate;
    if (sinceDate) return new Date(sinceDate);
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  }
}

module.exports = ImapConnector;
