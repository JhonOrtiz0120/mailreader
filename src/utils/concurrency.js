'use strict';

/**
 * Utilidad de control de concurrencia para procesamiento masivo.
 *
 * SAFITE tiene 80+ clientes activos. Procesar todos simultáneamente
 * colapsaría las APIs externas y agotaría los recursos del servidor.
 * Este limitador garantiza que solo N buzones se procesen en paralelo.
 *
 * Implementado sin dependencias externas para evitar conflictos
 * con módulos ES (p-limit v4+ es ESM-only).
 */

/**
 * Procesa un array de items con un límite máximo de concurrencia.
 *
 * Comportamiento:
 * - Lanza exactamente `limit` workers concurrentes
 * - Cada worker toma el siguiente item disponible cuando termina
 * - Resiliencia: si un item falla, continúa con los demás (similar a Promise.allSettled)
 * - Preserva el orden del array de resultados
 *
 * @param {Array<T>} items       - Lista de elementos a procesar
 * @param {number}   limit       - Número máximo de promesas concurrentes
 * @param {Function} fn          - Función async (item: T, index: number) => Result
 *
 * @returns {Promise<Array<{ status: 'fulfilled'|'rejected', value?: Result, reason?: Error }>>}
 *
 * @example
 * const results = await pLimit(mailboxes, 10, async (mailbox) => {
 *   return processMailbox(mailbox);
 * });
 */
async function pLimit(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (typeof limit !== 'number' || limit < 1) limit = 1;

  const results = new Array(items.length);
  let nextIndex = 0;

  /**
   * Worker: toma items del array hasta que no queden más.
   * Múltiples workers se ejecutan concurrentemente.
   */
  async function worker() {
    while (true) {
      // Tomar el siguiente índice de forma segura (no hay race conditions en V8 event loop)
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;

      const item = items[currentIndex];

      try {
        const value = await fn(item, currentIndex);
        results[currentIndex] = { status: 'fulfilled', value };
      } catch (err) {
        results[currentIndex] = {
          status: 'rejected',
          reason: err,
          // Preservar referencia al item para logging
          _item: item,
        };
      }
    }
  }

  // Crear exactamente min(limit, items.length) workers concurrentes
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, worker);

  await Promise.all(workers);

  return results;
}

/**
 * Versión simplificada que retorna solo los resultados exitosos.
 * Los errores se loggean pero no interrumpen el procesamiento.
 *
 * @param {Array<T>} items
 * @param {number} limit
 * @param {Function} fn
 * @returns {Promise<Array<Result>>}
 */
async function pLimitSuccessOnly(items, limit, fn) {
  const allResults = await pLimit(items, limit, fn);
  return allResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

module.exports = { pLimit, pLimitSuccessOnly };
