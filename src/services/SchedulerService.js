'use strict';

const cron = require('node-cron');
const InvoiceExtractorService = require('./InvoiceExtractorService');

/**
 * SchedulerService — Control del Scheduler Automático
 *
 * Permite configurar extracciones automáticas mediante expresiones cron,
 * además de la extracción bajo demanda via REST.
 *
 * Ejemplos de expresiones cron:
 *   '* /15 * * * *'   → cada 15 minutos
 *   '0 * * * *'       → cada hora en punto
 *   '0 8,12,17 * * *' → a las 8:00, 12:00 y 17:00
 *   '0 8 * * 1-5'     → lunes a viernes a las 8:00
 */
class SchedulerService {
  constructor() {
    this._task = null;
    this._schedule = null;
    this._enabled = false;
    this._lastRun = null;
    this._runCount = 0;
    this._lastError = null;
  }

  // ─────────────────────────────────────────────────────────────
  // API pública
  // ─────────────────────────────────────────────────────────────

  /**
   * Inicia el scheduler con una expresión cron.
   * Si ya había un scheduler activo, lo detiene primero.
   *
   * @param {string} cronExpression - Expresión cron estándar de 5 campos
   * @param {Object} [extractOptions] - Opciones adicionales para la extracción
   * @returns {{ enabled, schedule, message }}
   * @throws {Error} Si la expresión cron es inválida
   */
  start(cronExpression, extractOptions = {}) {
    if (!cronExpression || typeof cronExpression !== 'string') {
      throw new Error('Se requiere una expresión cron válida. Ej: "*/15 * * * *"');
    }

    if (!cron.validate(cronExpression)) {
      throw new Error(
        `Expresión cron inválida: "${cronExpression}". ` +
        'Use el formato estándar de 5 campos: minuto hora día mes día-semana. ' +
        'Ejemplo: "*/15 * * * *" para cada 15 minutos.'
      );
    }

    // Detener scheduler previo si existe
    if (this._task) {
      this._task.stop();
      this._task = null;
    }

    this._schedule = cronExpression;
    this._enabled = true;
    this._lastError = null;

    this._task = cron.schedule(cronExpression, async () => {
      this._lastRun = new Date().toISOString();
      this._runCount++;
      console.log(`[SchedulerService] ⏰ Disparo automático #${this._runCount} — ${this._lastRun}`);

      try {
        await InvoiceExtractorService.extractAll(extractOptions);
        this._lastError = null;
      } catch (err) {
        this._lastError = err.message;
        console.error(`[SchedulerService] Error en extracción automática:`, err.message);
      }
    }, {
      scheduled: true,
      timezone: process.env.TZ || 'America/Bogota', // Zona horaria Colombia por defecto
    });

    console.log(`[SchedulerService] ✓ Scheduler iniciado: "${cronExpression}" (TZ: ${process.env.TZ || 'America/Bogota'})`);
    return this.getStatus();
  }

  /**
   * Detiene el scheduler.
   * La extracción bajo demanda sigue disponible.
   *
   * @returns {{ enabled, schedule, message }}
   */
  stop() {
    if (this._task) {
      this._task.stop();
      this._task = null;
    }
    this._enabled = false;
    console.log('[SchedulerService] Scheduler detenido.');
    return this.getStatus();
  }

  /**
   * Retorna el estado actual del scheduler.
   * @returns {SchedulerStatus}
   */
  getStatus() {
    return {
      enabled: this._enabled,
      schedule: this._schedule,
      lastRun: this._lastRun,
      runCount: this._runCount,
      lastError: this._lastError,
      extractionRunning: InvoiceExtractorService.isRunning(),
      timezone: process.env.TZ || 'America/Bogota',
      examples: {
        'Cada 15 minutos': '*/15 * * * *',
        'Cada hora':       '0 * * * *',
        'Lun-Vie 8:00':    '0 8 * * 1-5',
        'Cada 6 horas':    '0 */6 * * *',
      },
    };
  }
}

// Singleton
module.exports = new SchedulerService();
