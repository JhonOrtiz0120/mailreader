'use strict';

/**
 * MailboxRepository — Repositorio de Configuración de Buzones
 *
 * Abstracción sobre la fuente de datos de buzones. En v1 lee desde .env.
 * En v2, solo hay que implementar _loadFromDatabase() y cambiar la llamada
 * en getAll() — el resto del sistema no cambia.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  v1 (actual):  Variables de entorno (.env)              │
 * │  v2 (próxima): tabla safite_mailboxes en BD del ERP     │
 * └─────────────────────────────────────────────────────────┘
 *
 * Esquema de un MailboxConfig:
 * {
 *   id:          string   — identificador único del buzón
 *   label:       string   — nombre descriptivo (nombre del cliente)
 *   email:       string   — dirección de correo del buzón
 *   provider:    string   — 'imap' | 'microsoft' | 'google'
 *   active:      boolean  — si está habilitado para extracción
 *   credentials: object   — credenciales específicas del proveedor
 * }
 */
const fs = require('fs/promises');
const path = require('path');
const CONFIG_PATH = path.join(__dirname, '../../mailboxes.json');

class MailboxRepository {
  constructor() {
    this._cache = null; // Cache en memoria para evitar releer .env o .json en cada extracción
  }

  // ─────────────────────────────────────────────────────────────
  // API pública
  // ─────────────────────────────────────────────────────────────

  /**
   * Retorna todos los buzones configurados.
   * Usa cache para evitar múltiples lecturas del .env en la misma sesión.
   *
   * @returns {Promise<Array<MailboxConfig>>}
   */
  async getAll() {
    if (!this._cache) {
      try {
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        this._cache = JSON.parse(data);
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Fallback a .env si el archivo no existe
          this._cache = await this._loadFromEnv();
        } else {
          console.error('[MailboxRepository] Error leyendo mailboxes.json:', err.message);
          this._cache = [];
        }
      }
    }
    return this._cache;
  }

  async saveAll(mailboxes) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(mailboxes, null, 2), 'utf-8');
    this._cache = mailboxes;
    return this._cache;
  }

  /**
   * Retorna solo los buzones activos.
   * @returns {Promise<Array<MailboxConfig>>}
   */
  async getActive() {
    const all = await this.getAll();
    return all.filter(mb => mb.active !== false);
  }

  /**
   * Busca un buzón por ID.
   * @param {string} id
   * @returns {Promise<MailboxConfig|null>}
   */
  async getById(id) {
    const all = await this.getAll();
    return all.find(mb => mb.id === id) || null;
  }

  /**
   * Invalida la cache para forzar recarga (útil en recargas en caliente).
   * @returns {Promise<Array<MailboxConfig>>}
   */
  async reload() {
    this._cache = null;
    return this.getAll();
  }

  // ─────────────────────────────────────────────────────────────
  // v1: Carga desde variables de entorno
  // ─────────────────────────────────────────────────────────────

  /**
   * Lee los buzones desde el .env con la convención MAILBOX_<N>_<CAMPO>.
   * Soporta hasta N buzones (se detiene cuando MAILBOX_N_PROVIDER no existe).
   *
   * @returns {Promise<Array<MailboxConfig>>}
   */
  async _loadFromEnv() {
    const mailboxes = [];
    
    const indices = new Set();
    for (const key of Object.keys(process.env)) {
      const match = key.match(/^MAILBOX_(\d+)_PROVIDER$/);
      if (match) {
        indices.add(parseInt(match[1], 10));
      }
    }
    
    const sortedIndices = Array.from(indices).sort((a, b) => a - b);

    for (const i of sortedIndices) {
      const prefix = `MAILBOX_${i}`;
      const provider = (process.env[`${prefix}_PROVIDER`] || '').toLowerCase().trim();
      const email = process.env[`${prefix}_EMAIL`] || process.env[`${prefix}_USER`] || '';

      const base = {
        id: process.env[`${prefix}_ID`] || `mailbox_${i}`,
        label: process.env[`${prefix}_LABEL`] || `Buzón ${i} — ${email}`,
        email,
        provider,
        active: process.env[`${prefix}_ACTIVE`] !== 'false',
      };

      const credentials = this._buildCredentials(prefix, provider);
      mailboxes.push({ ...base, credentials });
    }

    console.log(`[MailboxRepository] ${mailboxes.length} buzón(es) cargado(s) desde .env`);

    if (mailboxes.length === 0) {
      console.warn(
        '[MailboxRepository] ⚠ No se encontraron buzones configurados. ' +
        'Revise el archivo .env (formato: MAILBOX_1_PROVIDER, MAILBOX_1_EMAIL...)'
      );
    }

    return mailboxes;
  }

  /**
   * Construye el objeto de credenciales según el proveedor.
   */
  _buildCredentials(prefix, provider) {
    switch (provider) {
      case 'imap':
        return {
          host: process.env[`${prefix}_HOST`] || '',
          port: process.env[`${prefix}_PORT`] || '993',
          user: process.env[`${prefix}_USER`] || process.env[`${prefix}_EMAIL`] || '',
          password: process.env[`${prefix}_PASSWORD`] || '',
          tls: process.env[`${prefix}_TLS`] !== 'false',
          mailbox: process.env[`${prefix}_MAILBOX`] || 'INBOX',
        };

      case 'microsoft':
        return {
          tenantId: process.env[`${prefix}_TENANT_ID`] || '',
          clientId: process.env[`${prefix}_CLIENT_ID`] || '',
          clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || '',
          userEmail: process.env[`${prefix}_EMAIL`] || '',
        };

      case 'google': {
        const authType = process.env[`${prefix}_AUTH_TYPE`] || 'oauth2';
        const base = { authType, userEmail: process.env[`${prefix}_EMAIL`] || '' };

        if (authType === 'service_account') {
          return {
            ...base,
            clientEmail: process.env[`${prefix}_SA_EMAIL`] || '',
            privateKey: process.env[`${prefix}_SA_PRIVATE_KEY`] || '',
          };
        }

        return {
          ...base,
          clientId: process.env[`${prefix}_CLIENT_ID`] || '',
          clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || '',
          refreshToken: process.env[`${prefix}_REFRESH_TOKEN`] || '',
        };
      }

      default:
        console.warn(`[MailboxRepository] Proveedor desconocido: "${provider}" — credenciales vacías.`);
        return {};
    }
  }

  // ─────────────────────────────────────────────────────────────
  // TODO v2: Implementación desde Base de Datos
  // ─────────────────────────────────────────────────────────────
  //
  // Para migrar a BD en SAFITE ERP:
  // 1. Instalar driver: npm install pg   (PostgreSQL)
  //                  o: npm install mssql (SQL Server)
  //                  o: npm install mysql2 (MySQL/MariaDB)
  //
  // 2. Crear tabla en la BD del ERP:
  //    CREATE TABLE safite_mailboxes (
  //      id VARCHAR(50) PRIMARY KEY,
  //      label VARCHAR(200),
  //      email VARCHAR(200),
  //      provider VARCHAR(20) CHECK (provider IN ('imap','microsoft','google')),
  //      active BOOLEAN DEFAULT true,
  //      credentials_json TEXT,   -- JSON cifrado con AES-256
  //      created_at TIMESTAMP DEFAULT NOW(),
  //      updated_at TIMESTAMP
  //    );
  //
  // 3. Descomentar y completar el método _loadFromDatabase():
  //
  // async _loadFromDatabase() {
  //   const { Pool } = require('pg');
  //   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  //   const { rows } = await pool.query(
  //     'SELECT * FROM safite_mailboxes WHERE active = true ORDER BY label'
  //   );
  //   return rows.map(row => ({
  //     id: row.id,
  //     label: row.label,
  //     email: row.email,
  //     provider: row.provider,
  //     active: row.active,
  //     credentials: this._decryptCredentials(row.credentials_json),
  //   }));
  // }
  //
  // _decryptCredentials(encryptedJson) {
  //   const crypto = require('crypto');
  //   const key = Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY, 'hex');
  //   // ... implementar AES-256-GCM decrypt
  // }
}

// Singleton: una sola instancia compartida en toda la app
module.exports = new MailboxRepository();
