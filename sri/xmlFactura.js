'use strict';

/**
 * SRI Ecuador — Constructor de XML de Factura v2.1.0
 *
 * Genera el XML sin firmar, listo para ser firmado con signer.js
 */

/**
 * Detecta el tipo de identificación del comprador según la longitud del documento.
 * @param {string} doc
 * @returns {string} '04'=RUC, '05'=cédula, '06'=pasaporte/otro
 */
function detectarTipoId(doc) {
    const limpio = (doc || '').replace(/\D/g, '');
    if (limpio.length === 13) return '04'; // RUC
    if (limpio.length === 10) return '05'; // Cédula
    return '06';                            // Pasaporte / extranjero
}

/**
 * Mapea la tasa de IVA al código SRI.
 * 15% → '10', 12% → '2', otro → '2'
 * @param {number} ivaRate
 * @returns {string}
 */
function codigoIVA(ivaRate) {
    if (ivaRate === 15) return '4';
    if (ivaRate === 13) return '10';
    if (ivaRate === 12) return '2';
    return '2';
}

/**
 * Escapa caracteres especiales XML.
 * @param {string|number} val
 * @returns {string}
 */
function xmlEsc(val) {
    return String(val == null ? '' : val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Formatea número con 2 decimales.
 * @param {number} n
 * @returns {string}
 */
function fmt(n) {
    return parseFloat(n || 0).toFixed(2);
}

/**
 * Construye el XML de factura SRI v2.1.0 sin firma.
 *
 * @param {object} opts
 * @param {string}  opts.claveAcceso
 * @param {string|number} opts.ambiente       1=pruebas, 2=producción
 * @param {string}  opts.razonSocial
 * @param {string}  opts.nombreComercial
 * @param {string}  opts.ruc
 * @param {string}  opts.estab                Establecimiento (ej. '001')
 * @param {string}  opts.ptoEmi               Punto de emisión (ej. '001')
 * @param {string|number} opts.secuencial     Número secuencial
 * @param {string}  opts.dirMatriz            Dirección matriz
 * @param {string}  opts.fecha                Fecha de emisión 'DD/MM/YYYY'
 * @param {string}  opts.tipoIdComprador      '04'|'05'|'06'
 * @param {string}  opts.razonSocialComprador Nombre del comprador
 * @param {string}  opts.identificacionComprador
 * @param {number}  opts.subtotal             Subtotal sin IVA
 * @param {number}  opts.iva                  Valor del IVA
 * @param {number}  opts.total                Total con IVA
 * @param {string}  opts.concepto             Descripción del servicio
 * @param {string}  opts.email                Correo del comprador
 * @param {number}  opts.ivaRate              Porcentaje de IVA (15, 12, etc.)
 * @returns {string} XML string
 */
function buildFacturaXML({
    claveAcceso,
    ambiente,
    razonSocial,
    nombreComercial,
    ruc,
    estab,
    ptoEmi,
    secuencial,
    dirMatriz,
    fecha,
    tipoIdComprador,
    razonSocialComprador,
    identificacionComprador,
    subtotal,
    iva,
    total,
    concepto,
    email,
    ivaRate,
    formaPago
}) {
    // Normalizar fecha a DD/MM/YYYY
    let fechaEmision = fecha;
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        const [y, m, d] = fecha.split('-');
        fechaEmision = `${d}/${m}/${y}`;
    }

    const establStr     = String(estab).padStart(3, '0');
    const ptoEmiStr     = String(ptoEmi).padStart(3, '0');
    const secuencialStr = String(secuencial).padStart(9, '0');
    const codIVA        = codigoIVA(ivaRate);

    // Número de factura: estab-ptoEmi-secuencial
    const numeroFactura = `${establStr}-${ptoEmiStr}-${secuencialStr}`;

    // Subtotal sin impuesto (tarifa 0 o sin IVA)
    const totalSinImpuesto = fmt(subtotal);
    const ivaVal            = fmt(iva);
    const totalStr          = fmt(total);

    return `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="2.1.0">
  <infoTributaria>
    <ambiente>${xmlEsc(ambiente)}</ambiente>
    <tipoEmision>1</tipoEmision>
    <razonSocial>${xmlEsc(razonSocial)}</razonSocial>
    <nombreComercial>${xmlEsc(nombreComercial)}</nombreComercial>
    <ruc>${xmlEsc(ruc)}</ruc>
    <claveAcceso>${xmlEsc(claveAcceso)}</claveAcceso>
    <codDoc>01</codDoc>
    <estab>${xmlEsc(establStr)}</estab>
    <ptoEmi>${xmlEsc(ptoEmiStr)}</ptoEmi>
    <secuencial>${xmlEsc(secuencialStr)}</secuencial>
    <dirMatriz>${xmlEsc(dirMatriz)}</dirMatriz>
  </infoTributaria>
  <infoFactura>
    <fechaEmision>${xmlEsc(fechaEmision)}</fechaEmision>
    <dirEstablecimiento>${xmlEsc(dirMatriz)}</dirEstablecimiento>
    <obligadoContabilidad>NO</obligadoContabilidad>
    <tipoIdentificacionComprador>${xmlEsc(tipoIdComprador)}</tipoIdentificacionComprador>
    <razonSocialComprador>${xmlEsc(razonSocialComprador)}</razonSocialComprador>
    <identificacionComprador>${xmlEsc(identificacionComprador)}</identificacionComprador>
    <totalSinImpuestos>${totalSinImpuesto}</totalSinImpuestos>
    <totalDescuento>0.00</totalDescuento>
    <totalConImpuestos>
      <totalImpuesto>
        <codigo>2</codigo>
        <codigoPorcentaje>${xmlEsc(codIVA)}</codigoPorcentaje>
        <baseImponible>${totalSinImpuesto}</baseImponible>
        <valor>${ivaVal}</valor>
      </totalImpuesto>
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>${totalStr}</importeTotal>
    <moneda>DOLAR</moneda>
    <pagos>
      <pago>
        <formaPago>${formaPago || '20'}</formaPago>
        <total>${totalStr}</total>
        <plazo>0</plazo>
        <unidadTiempo>dias</unidadTiempo>
      </pago>
    </pagos>
  </infoFactura>
  <detalles>
    <detalle>
      <codigoPrincipal>SRV001</codigoPrincipal>
      <descripcion>${xmlEsc(concepto)}</descripcion>
      <cantidad>1.000000</cantidad>
      <precioUnitario>${totalSinImpuesto}</precioUnitario>
      <descuento>0.00</descuento>
      <precioTotalSinImpuesto>${totalSinImpuesto}</precioTotalSinImpuesto>
      <impuestos>
        <impuesto>
          <codigo>2</codigo>
          <codigoPorcentaje>${xmlEsc(codIVA)}</codigoPorcentaje>
          <tarifa>${ivaRate}.00</tarifa>
          <baseImponible>${totalSinImpuesto}</baseImponible>
          <valor>${ivaVal}</valor>
        </impuesto>
      </impuestos>
    </detalle>
  </detalles>
  <infoAdicional>
    <campoAdicional nombre="email">${xmlEsc(email)}</campoAdicional>
    <campoAdicional nombre="factura">${xmlEsc(numeroFactura)}</campoAdicional>
  </infoAdicional>
</factura>`;
}

module.exports = { buildFacturaXML, detectarTipoId };
