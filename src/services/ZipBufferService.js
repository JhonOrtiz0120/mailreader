'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * ZipBufferService — Almacén en memoria de buffers ZIP (sin escritura en disco)
 *
 * Actúa como un caché temporal con TTL (Time To Live).
 * Cada buffer se asocia a un token UUID para descarga segura.
 *
 * Flujo:
 *  1. Extractor descarga ZIP → llama store(buffer, filename)
 *  2. store() guarda en Map y retorna downloadToken
 *  3. Usuario descarga → API llama retrieve(token) → retorna buffer
 *  4. GC limpia entradas expiradas cada 5 minutos
 */
class ZipBufferService {
  /**
   * @param {number} [ttlMs=1800000] - TTL en milisegundos (default: 30 minutos)
   */
  constructor(ttlMs = 30 * 60 * 1000) {
    /** @type {Map<string, {buffer: Buffer, filename: string, size: number, mimeType: string, createdAt: number}>} */
    this._store = new Map();
    this._ttlMs = ttlMs;
    this._gcTimer = this._startGarbageCollector();
  }

  // ─────────────────────────────────────────────────────────────
  // API pública
  // ─────────────────────────────────────────────────────────────

  /**
   * Almacena un buffer ZIP en memoria y retorna un token de descarga.
   * El token expira después del TTL configurado.
   *
   * @param {Buffer} buffer       - Contenido del archivo ZIP
   * @param {string} filename     - Nombre original del archivo
   * @param {string} [mimeType]   - MIME type (default: application/zip)
   * @returns {string}            - Token UUID para descarga posterior
   */
  store(buffer, filename, mimeType = 'application/zip') {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('ZipBufferService.store(): buffer debe ser un Buffer de Node.js.');
    }

    const token = uuidv4();
    this._store.set(token, {
      buffer,
      filename: filename || `factura_${Date.now()}.zip`,
      size: buffer.length,
      mimeType,
      createdAt: Date.now(),
    });

    return token;
  }

  /**
   * Recupera un buffer por su token de descarga.
   * Retorna null si el token no existe o ha expirado.
   *
   * @param {string} token - Token UUID retornado por store()
   * @returns {{ buffer: Buffer, filename: string, size: number, mimeType: string } | null}
   */
  retrieve(token) {
    const entry = this._store.get(token);
    if (!entry) return null;

    if (Date.now() - entry.createdAt > this._ttlMs) {
      this._store.delete(token);
      return null;
    }

    return entry;
  }

  /**
   * Elimina un buffer de memoria por su token.
   * Llamar después de que el usuario descargó el archivo.
   *
   * @param {string} token
   */
  release(token) {
    this._store.delete(token);
  }

  /**
   * Limpia todos los buffers en memoria.
   * Útil al inicio de una nueva extracción para liberar memoria.
   */
  clear() {
    const count = this._store.size;
    this._store.clear();
    console.log(`[ZipBufferService] Cache limpiada: ${count} entrada(s) eliminada(s).`);
  }

  /**
   * Retorna estadísticas del almacén en memoria.
   * @returns {{ entries: number, totalSizeBytes: number, totalSizeMB: string }}
   */
  getStats() {
    const totalBytes = [...this._store.values()].reduce((acc, e) => acc + e.size, 0);
    return {
      entries: this._store.size,
      totalSizeBytes: totalBytes,
      totalSizeMB: (totalBytes / 1024 / 1024).toFixed(2),
      ttlMinutes: Math.round(this._ttlMs / 60000),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // GC interno
  // ─────────────────────────────────────────────────────────────

  _startGarbageCollector() {
    return setInterval(() => {
      const now = Date.now();
      let evicted = 0;

      for (const [token, entry] of this._store.entries()) {
        if (now - entry.createdAt > this._ttlMs) {
          this._store.delete(token);
          evicted++;
        }
      }

      if (evicted > 0) {
        console.log(`[ZipBufferService] GC: ${evicted} buffer(s) expirado(s) liberado(s).`);
      }
    }, 5 * 60 * 1000); // ejecutar cada 5 minutos
  }

  /**
   * Detiene el GC y limpia la memoria. Llamar al cerrar el servidor.
   */
  destroy() {
    clearInterval(this._gcTimer);
    this._store.clear();
  }
}

// Singleton compartido en toda la aplicación
module.exports = new ZipBufferService();
