'use strict';

const fs   = require('fs');
const path = require('path');

const { generarClaveAcceso }              = require('./claveAcceso');
const { buildFacturaXML, detectarTipoId } = require('./xmlFactura');
const { signXML }                         = require('./signer');
const { enviarComprobante, autorizarComprobante } = require('./client');

function getP12Path() {
  return path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data.db')), 'firma.p12');
}

function getP12() {
  if (process.env.P12_BASE64) return Buffer.from(process.env.P12_BASE64, 'base64');
  const p = getP12Path();
  if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error('Certificado .p12 no encontrado. Súbelo desde el panel admin → Facturación.');
}

// Lee config SRI desde la tabla contacto (DB) con fallback a env vars
function getSRIConfig(db) {
  const rows = db.prepare('SELECT key,value FROM contacto WHERE key LIKE \'sri_%\' OR key=\'p12_password\'').all();
  const c = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    ambiente:        c.sri_ambiente        || process.env.SRI_AMBIENTE       || '1',
    ruc:             c.sri_ruc             || process.env.SRI_RUC             || '',
    razonSocial:     c.sri_razon_social    || process.env.SRI_RAZON_SOCIAL    || '',
    nombreComercial: c.sri_nombre_comercial|| process.env.SRI_NOMBRE_COMERCIAL|| '',
    direccion:       c.sri_direccion       || process.env.SRI_DIRECCION       || '',
    estab:           c.sri_estab           || process.env.SRI_ESTAB           || '001',
    ptoEmi:          c.sri_pto_emi         || process.env.SRI_PTO_EMI         || '001',
    ivaRate:         parseFloat(c.sri_iva_rate || process.env.SRI_IVA_RATE || '15'),
    p12Password:     c.p12_password        || process.env.P12_PASSWORD        || '',
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function emitirFactura(db, { nombre, email, doc, monto, subtotal, iva, concepto, formaPago, fecha, secuencial }) {
  const cfg = getSRIConfig(db);
  if (!cfg.ruc) throw new Error('SRI_RUC no configurado. Completa la configuración en admin → Facturación.');

  const fechaEmision = fecha || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const tipoIdComprador = detectarTipoId(doc);

  const claveAcceso = generarClaveAcceso({
    fecha: fechaEmision,
    ruc:        cfg.ruc,
    ambiente:   cfg.ambiente,
    estab:      cfg.estab,
    ptoEmi:     cfg.ptoEmi,
    secuencial,
    tipoEmision: '1'
  });

  const xmlUnsigned = buildFacturaXML({
    claveAcceso,
    ambiente:                cfg.ambiente,
    razonSocial:             cfg.razonSocial,
    nombreComercial:         cfg.nombreComercial,
    ruc:                     cfg.ruc,
    estab:                   cfg.estab,
    ptoEmi:                  cfg.ptoEmi,
    secuencial,
    dirMatriz:               cfg.direccion,
    fecha:                   fechaEmision,
    tipoIdComprador,
    razonSocialComprador:    nombre,
    identificacionComprador: doc,
    subtotal,
    iva,
    total:                   monto,
    concepto:                (concepto || 'Servicios Legales').slice(0, 300),
    email,
    ivaRate:                 cfg.ivaRate,
    formaPago:               formaPago || '20'
  });

  const xmlSigned = signXML(xmlUnsigned, getP12(), cfg.p12Password);

  const recepcion = await enviarComprobante(xmlSigned, cfg.ambiente);
  if (recepcion.estado !== 'RECIBIDA') {
    const msg = (recepcion.mensajes || []).map(m =>
      [m.identificador, m.mensaje, m.informacionAdicional].filter(Boolean).join(' - ')
    ).filter(Boolean).join('; ') || ('Estado SRI: ' + (recepcion.estado || 'sin respuesta'));
    return { ok: false, claveAcceso, error: msg };
  }

  for (let i = 1; i <= 5; i++) {
    await delay(2000);
    let autResp;
    try { autResp = await autorizarComprobante(claveAcceso, cfg.ambiente); }
    catch (e) {
      if (i === 5) return { ok: false, claveAcceso, xmlSigned, error: 'Error de red en autorización: ' + e.message };
      continue;
    }
    const auts = autResp.autorizaciones || [];
    if (!auts.length) continue;
    const aut = auts[0];
    if (aut.estado === 'AUTORIZADO') return {
      ok: true, claveAcceso,
      numeroAutorizacion: aut.numeroAutorizacion,
      fechaAutorizacion:  aut.fechaAutorizacion,
      xmlSigned,
      xmlAutorizado: aut.comprobante || xmlSigned
    };
    if (aut.estado === 'NO AUTORIZADO') {
      const msg = (aut.mensajes || []).map(m => [m.mensaje, m.informacionAdicional].filter(Boolean).join(' - ')).join('; ') || 'NO AUTORIZADO';
      return { ok: false, claveAcceso, xmlSigned, error: msg };
    }
  }
  return { ok: false, claveAcceso, xmlSigned, error: 'RECIBIDA sin autorización después de 5 intentos' };
}

module.exports = { emitirFactura, getSRIConfig, getP12Path };
