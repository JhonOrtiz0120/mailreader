'use strict';

/**
 * Parser para el estándar de asuntos de correo de la DIAN (Colombia).
 *
 * Formato oficial: NIT;Nombre;NumeroFactura;TipoDocumento;NIT_Adquirente
 *
 * Ejemplos válidos:
 *   900123456;EMPRESA EJEMPLO SAS;FE001;01;830000000
 *   9001234567;COMERCIALIZADORA XYZ;FEV-1234;92;8000123450
 */

/**
 * Expresión regular oficial DIAN para el asunto del correo.
 *
 * Grupos:
 *  1. NIT emisor       → 1 o más dígitos
 *  2. Nombre emisor    → cualquier texto sin punto y coma
 *  3. Número factura   → alfanumérico con guiones permitidos
 *  4. Tipo documento   → exactamente 2 dígitos (01, 91, 92, 95, 96...)
 *  5. NIT adquirente   → cualquier texto sin punto y coma
 */
const DIAN_SUBJECT_REGEX = /^(\d+);([^;]+);([A-Za-z0-9\-]+);(\d{2});([^;]+)$/;

/**
 * Parsea el asunto de un correo según el estándar DIAN.
 *
 * @param {string} subject - Asunto del correo
 * @returns {{ nit, nombre, factura, tipoDoc, adquirente } | null}
 *          null si el asunto no cumple el formato DIAN
 */
function parseDianSubject(subject) {
  if (!subject || typeof subject !== 'string') return null;

  const trimmed = subject.trim();
  const match = trimmed.match(DIAN_SUBJECT_REGEX);
  if (!match) return null;

  return {
    nit: match[1].trim(),
    nombre: match[2].trim(),
    factura: match[3].trim(),
    tipoDoc: match[4].trim(),
    adquirente: match[5].trim(),
  };
}

/**
 * Verifica si un asunto cumple el formato DIAN sin parsearlo.
 * Más eficiente para filtrado masivo.
 *
 * @param {string} subject
 * @returns {boolean}
 */
function isDianSubject(subject) {
  if (!subject || typeof subject !== 'string') return false;
  return DIAN_SUBJECT_REGEX.test(subject.trim());
}

/**
 * Mapa de códigos de tipo de documento DIAN → descripción legible.
 * Fuente: Resolución 042 de 2020 / DIAN Colombia
 */
const TIPO_DOC_MAP = {
  '01': 'Factura Electrónica de Venta',
  '02': 'Factura de Exportación Electrónica',
  '03': 'Factura por Contingencia - Nombre Técnico',
  '04': 'Factura por Contingencia - Tiquete POS',
  '91': 'Nota Débito',
  '92': 'Nota Crédito',
  '93': 'Nota de Ajuste (Exportación)',
  '94': 'Nota de Ajuste (Contingencia)',
  '95': 'Documento Soporte en Adquisiciones con No Obligados',
  '96': 'Nota de Ajuste al Documento Soporte',
};

/**
 * Retorna la descripción legible de un tipo de documento DIAN.
 *
 * @param {string} tipoDoc - Código de 2 dígitos (ej: '01', '92')
 * @returns {string}
 */
function getTipoDocDescripcion(tipoDoc) {
  return TIPO_DOC_MAP[tipoDoc] || `Tipo de documento ${tipoDoc}`;
}

module.exports = {
  DIAN_SUBJECT_REGEX,
  parseDianSubject,
  isDianSubject,
  getTipoDocDescripcion,
  TIPO_DOC_MAP,
};
