'use strict';

const MicrosoftConnector = require('../connectors/MicrosoftConnector');
const GoogleConnector = require('../connectors/GoogleConnector');
const ImapConnector = require('../connectors/ImapConnector');

/**
 * MailConnectorFactory — Patrón de Diseño Factory
 *
 * Responsabilidad única: instanciar el conector de correo correcto
 * según el proveedor indicado en la configuración del buzón.
 *
 * Uso:
 *   const connector = MailConnectorFactory.create({
 *     provider: 'imap',
 *     credentials: { host, port, user, password }
 *   });
 *   await connector.connect();
 *
 * Extensibilidad:
 *   Para agregar un nuevo proveedor (ej: 'yahoo', 'zoho'):
 *   MailConnectorFactory.registerProvider('yahoo', YahooConnector);
 */
class MailConnectorFactory {
  /**
   * Registro interno de proveedores soportados.
   * Clave: nombre del proveedor en minúsculas.
   * Valor: clase que extiende MailConnector.
   */
  static _providers = {
    microsoft: MicrosoftConnector,
    google: GoogleConnector,
    imap: ImapConnector,
  };

  // ─────────────────────────────────────────────────────────────

  /**
   * Crea e instancia el conector correcto según el proveedor.
   *
   * @param {Object} config
   * @param {string} config.provider     - 'microsoft' | 'google' | 'imap'
   * @param {Object} config.credentials  - Credenciales específicas del proveedor
   *
   * @returns {MailConnector} Instancia del conector (sin conectar aún)
   * @throws {Error} Si el proveedor no está registrado o faltan parámetros
   */
  static create({ provider, credentials }) {
    // Validación de parámetros (fail-fast)
    if (!provider) {
      throw new Error(
        'MailConnectorFactory.create(): Se requiere el campo "provider". ' +
        `Proveedores disponibles: ${this.getSupportedProviders().join(', ')}`
      );
    }

    if (!credentials || typeof credentials !== 'object') {
      throw new Error(
        `MailConnectorFactory.create(): Se requiere el campo "credentials" para el proveedor "${provider}".`
      );
    }

    const normalizedProvider = provider.toLowerCase().trim();
    const ConnectorClass = this._providers[normalizedProvider];

    if (!ConnectorClass) {
      const available = this.getSupportedProviders().join(', ');
      throw new Error(
        `MailConnectorFactory: Proveedor "${provider}" no reconocido. ` +
        `Proveedores disponibles: ${available}. ` +
        `Para agregar uno nuevo use: MailConnectorFactory.registerProvider(name, Class)`
      );
    }

    return new ConnectorClass(credentials);
  }

  // ─────────────────────────────────────────────────────────────

  /**
   * Retorna la lista de nombres de proveedores registrados.
   * @returns {string[]}
   */
  static getSupportedProviders() {
    return Object.keys(this._providers);
  }

  /**
   * Registra un nuevo proveedor de correo en tiempo de ejecución.
   * Permite extender el sistema sin modificar este archivo (Open/Closed Principle).
   *
   * @param {string} name                       - Nombre del proveedor (ej: 'yahoo')
   * @param {typeof import('../connectors/base/MailConnector')} ConnectorClass - Clase que extiende MailConnector
   */
  static registerProvider(name, ConnectorClass) {
    if (!name || typeof name !== 'string') {
      throw new Error('registerProvider: name debe ser un string no vacío.');
    }
    const key = name.toLowerCase().trim();
    if (this._providers[key]) {
      console.warn(`[MailConnectorFactory] Sobreescribiendo proveedor existente: "${key}"`);
    }
    this._providers[key] = ConnectorClass;
    console.log(`[MailConnectorFactory] Proveedor registrado: "${key}" → ${ConnectorClass.name}`);
  }

  /**
   * Elimina un proveedor del registro (útil para pruebas).
   * @param {string} name
   */
  static unregisterProvider(name) {
    const key = name.toLowerCase().trim();
    delete this._providers[key];
  }
}

module.exports = MailConnectorFactory;
