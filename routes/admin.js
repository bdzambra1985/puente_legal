const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDB } = require('../database');
const auth = require('../middleware/auth');
const csrfCheck = require('../middleware/csrf');
const { sendCitaConfirmada, sendFacturaEmitida, sendCorreoAdjunto, sendCorreoNotaria } = require('../utils/email');
const { emitirFactura, getSRIConfig, getP12Path } = require('../sri/index');
require('../utils/upload'); // asegura que el SDK de Cloudinary quede configurado
const cloudinary = require('cloudinary').v2;

const router = express.Router();
router.use(auth);
router.use(csrfCheck); // no-op en GET/HEAD/OPTIONS; exige X-CSRF-Token en mutaciones

/* ── P12 upload (multer en memoria) ────────────────────────────────── */
const uploadP12 = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.post('/p12-upload', uploadP12.single('p12'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
  fs.writeFileSync(getP12Path(), req.file.buffer, { mode: 0o600 });
  res.json({ ok: true });
});

router.get('/p12-status', (req, res) => {
  const p = getP12Path();
  res.json({ exists: fs.existsSync(p) });
});

/* ── SRI CONFIG (GET config actual) ───────────────────────────────── */
router.get('/sri-config', (req, res) => {
  const cfg = getSRIConfig(getDB());
  // Nunca exponer la contraseña del certificado por API; solo si está configurada.
  const { p12Password, ...safe } = cfg;
  res.json({ ...safe, p12PasswordSet: !!p12Password });
});

router.put('/sri-config', (req, res) => {
  const body = req.body || {};
  const ALLOWED = ['sri_ambiente','sri_ruc','sri_razon_social','sri_nombre_comercial',
                   'sri_direccion','sri_estab','sri_pto_emi','sri_iva_rate','p12_password'];

  if ('sri_ruc' in body && body.sri_ruc !== '' && !/^\d{13}$/.test(String(body.sri_ruc)))
    return res.status(400).json({ error: 'RUC debe tener 13 dígitos' });
  if ('sri_ambiente' in body && !['1','2'].includes(String(body.sri_ambiente)))
    return res.status(400).json({ error: 'Ambiente debe ser 1 (pruebas) o 2 (producción)' });
  if ('sri_iva_rate' in body && isNaN(parseFloat(body.sri_iva_rate)))
    return res.status(400).json({ error: 'iva_rate debe ser numérico' });
  if ('sri_estab' in body && !/^\d{1,3}$/.test(String(body.sri_estab)))
    return res.status(400).json({ error: 'Establecimiento inválido' });
  if ('sri_pto_emi' in body && !/^\d{1,3}$/.test(String(body.sri_pto_emi)))
    return res.status(400).json({ error: 'Punto de emisión inválido' });

  const norm = { ...body };
  if ('sri_estab' in norm)   norm.sri_estab   = String(norm.sri_estab).padStart(3, '0');
  if ('sri_pto_emi' in norm) norm.sri_pto_emi = String(norm.sri_pto_emi).padStart(3, '0');

  const db = getDB();
  const upd = db.prepare('UPDATE contacto SET value=? WHERE key=?');
  Object.entries(norm).filter(([k]) => ALLOWED.includes(k)).forEach(([k, v]) => upd.run(String(v), k));
  res.json({ ok: true });
});

// Contador durable: nunca retrocede aunque se borren facturas de la tabla
// (evita repetir un secuencial que el SRI ya autorizó).
function nextSecuencial(db, estab, ptoEmi) {
  db.prepare('INSERT OR IGNORE INTO sri_secuenciales (estab, pto_emi, ultimo) VALUES (?, ?, 0)').run(estab, ptoEmi);
  db.prepare('UPDATE sri_secuenciales SET ultimo = ultimo + 1 WHERE estab=? AND pto_emi=?').run(estab, ptoEmi);
  return db.prepare('SELECT ultimo FROM sri_secuenciales WHERE estab=? AND pto_emi=?').get(estab, ptoEmi).ultimo;
}

/* ── FACTURACIÓN ELECTRÓNICA (SRI) ─────────────────────────────────── */

// Al resolverse una factura vinculada a una cita (autorizada o error): sincroniza
// el estado en la cita y, si quedó autorizada, envía el comprobante por correo.
// Nunca debe tumbar la respuesta del caller.
async function syncCitaFactura(db, citaId, facturaId, ok) {
  if (!citaId) return;
  db.prepare('UPDATE citas SET factura_id=?, factura_estado=?, facturado=? WHERE id=?')
    .run(facturaId, ok ? 'aprobada' : 'error', ok ? 1 : 0, citaId);
  if (ok) {
    try {
      const factura = db.prepare('SELECT * FROM facturas WHERE id=?').get(facturaId);
      if (factura) await sendFacturaEmitida(factura);
    } catch (e) {
      console.error('[email] Error enviando factura:', e.message);
    }
  }
}

// Reserva secuencial, inserta la factura y la emite contra el SRI. Si viene
// cita_id, marca la cita como 'esperando_sri' antes de la llamada async y la
// sincroniza al resultado final (aprobada/error). Nunca lanza sin capturar.
async function crearYEmitirFactura(db, { cita_id, cliente_nombre, cliente_email, cliente_telefono, cliente_doc, monto, concepto, forma_pago }) {
  const cfg = getSRIConfig(db);
  const ivaRate  = cfg.ivaRate || 15;
  const subtotal = Math.round((monto / (1 + ivaRate / 100)) * 100) / 100;
  const iva      = Math.round((monto - subtotal) * 100) / 100;

  const secuencial    = nextSecuencial(db, cfg.estab, cfg.ptoEmi);
  const fechaEmision  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
  const numeroFactura = `${cfg.estab}-${cfg.ptoEmi}-${String(secuencial).padStart(9, '0')}`;

  const ins = db.prepare(`INSERT INTO facturas
    (cita_id, cliente_nombre, cliente_email, cliente_telefono, cliente_doc, monto, subtotal, iva, iva_rate,
     concepto, forma_pago, estab, pto_emi, secuencial, fecha_emision, numero_factura, sri_estado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'procesando')`)
    .run(cita_id || null, cliente_nombre, cliente_email || '', cliente_telefono || '', cliente_doc, monto, subtotal, iva,
         ivaRate, concepto || '', forma_pago || '20', cfg.estab, cfg.ptoEmi, secuencial, fechaEmision, numeroFactura);
  const facturaId = ins.lastInsertRowid;
  if (cita_id) db.prepare("UPDATE citas SET factura_id=?, factura_estado='esperando_sri' WHERE id=?").run(facturaId, cita_id);

  try {
    const result = await emitirFactura(db, {
      nombre: cliente_nombre, email: cliente_email, doc: cliente_doc,
      monto, subtotal, iva, concepto, formaPago: forma_pago || '20',
      fecha: fechaEmision, secuencial
    });
    db.prepare('UPDATE facturas SET clave_acceso=?, sri_estado=?, sri_data=? WHERE id=?')
      .run(result.claveAcceso || '', result.ok ? 'autorizada' : 'error', JSON.stringify(result), facturaId);
    await syncCitaFactura(db, cita_id, facturaId, result.ok);
    return { ok: result.ok, id: facturaId, numero_factura: numeroFactura, ...(result.ok ? {} : { error: result.error }) };
  } catch (e) {
    db.prepare('UPDATE facturas SET sri_estado=?, sri_data=? WHERE id=?')
      .run('error', JSON.stringify({ ok: false, error: e.message }), facturaId);
    await syncCitaFactura(db, cita_id, facturaId, false);
    return { ok: false, id: facturaId, numero_factura: numeroFactura, error: e.message };
  }
}

async function reintentarFacturaRow(db, row) {
  let secuencial = row.secuencial;
  let numeroFactura = row.numero_factura;

  // Si el intento anterior falló porque el SRI ya tenía ese secuencial
  // registrado (error 45), reintentar con el mismo número vuelve a fallar
  // siempre — hay que reservar uno nuevo antes de reintentar.
  let prevData = {};
  try { prevData = JSON.parse(row.sri_data || '{}'); } catch (e) { /* noop */ }
  if (/SECUENCIAL REGISTRADO/i.test(prevData.error || '')) {
    secuencial = nextSecuencial(db, row.estab, row.pto_emi);
    numeroFactura = `${row.estab}-${row.pto_emi}-${String(secuencial).padStart(9, '0')}`;
    db.prepare('UPDATE facturas SET secuencial=?, numero_factura=? WHERE id=?').run(secuencial, numeroFactura, row.id);
  }

  db.prepare("UPDATE facturas SET sri_estado='procesando' WHERE id=?").run(row.id);
  if (row.cita_id) db.prepare("UPDATE citas SET factura_estado='esperando_sri' WHERE id=?").run(row.cita_id);
  try {
    const result = await emitirFactura(db, {
      nombre: row.cliente_nombre, email: row.cliente_email, doc: row.cliente_doc,
      monto: row.monto, subtotal: row.subtotal, iva: row.iva,
      concepto: row.concepto, formaPago: row.forma_pago,
      fecha: row.fecha_emision, secuencial
    });
    db.prepare('UPDATE facturas SET clave_acceso=?, sri_estado=?, sri_data=? WHERE id=?')
      .run(result.claveAcceso || '', result.ok ? 'autorizada' : 'error', JSON.stringify(result), row.id);
    await syncCitaFactura(db, row.cita_id, row.id, result.ok);
    return { ok: result.ok, id: row.id, numero_factura: numeroFactura, ...(result.ok ? {} : { error: result.error }) };
  } catch (e) {
    db.prepare('UPDATE facturas SET sri_estado=?, sri_data=? WHERE id=?')
      .run('error', JSON.stringify({ ok: false, error: e.message }), row.id);
    await syncCitaFactura(db, row.cita_id, row.id, false);
    return { ok: false, id: row.id, error: e.message };
  }
}

router.post('/facturas', async (req, res) => {
  const { cita_id, cliente_nombre, cliente_email, cliente_telefono, cliente_doc, monto, concepto, forma_pago } = req.body || {};
  const montoNum = parseFloat(monto);
  if (!cliente_nombre || !cliente_doc || !monto || isNaN(montoNum) || montoNum <= 0)
    return res.status(400).json({ error: 'Faltan campos o monto inválido' });

  const db = getDB();
  const result = await crearYEmitirFactura(db, { cita_id, cliente_nombre, cliente_email, cliente_telefono, cliente_doc, monto: montoNum, concepto, forma_pago });
  res.json(result);
});

router.post('/facturas/:id/reintentar', async (req, res) => {
  const db  = getDB();
  const row = db.prepare('SELECT * FROM facturas WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  if (row.sri_estado !== 'error')
    return res.status(409).json({ error: 'Solo se puede reintentar una factura en estado error' });

  const result = await reintentarFacturaRow(db, row);
  res.json(result);
});

router.get('/facturas', (req, res) => {
  res.json(getDB().prepare('SELECT * FROM facturas ORDER BY id DESC').all());
});

router.get('/facturas/:id', (req, res) => {
  const row = getDB().prepare('SELECT * FROM facturas WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ...row, sri_data: JSON.parse(row.sri_data || '{}') });
});

// Borra solo el registro local (no revierte una autorización ya emitida por el
// SRI). Pensado para limpiar facturas de prueba en ambiente Pruebas.
router.delete('/facturas/:id', (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM facturas WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  if (row.cita_id) {
    db.prepare("UPDATE citas SET factura_id=NULL, factura_estado='', facturado=0 WHERE id=? AND factura_id=?")
      .run(row.cita_id, row.id);
  }
  db.prepare('DELETE FROM facturas WHERE id=?').run(row.id);
  res.json({ ok: true });
});

/* Servir comprobante (GET /api/admin/comprobante/:filename) */
const COMPROBANTE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf', '.webp': 'image/webp' };

// Proxea los bytes desde una URL (para no perder el gate de JWT de esta ruta).
async function proxyBytes(res, url) {
  const upstream = await fetch(url);
  if (!upstream.ok) return res.status(404).send('No encontrado');
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(buf);
}

router.get('/comprobante/:filename', async (req, res) => {
  const raw = req.params.filename;
  const db = getDB();

  // Solo se sirve un valor que realmente exista como comprobante en la BD.
  // Evita que el path param se use como SSRF hacia URLs arbitrarias.
  const known = db.prepare('SELECT 1 FROM citas WHERE comprobante_path=?').get(raw);
  if ((raw.startsWith('cld:') || /^https?:\/\//i.test(raw)) && !known)
    return res.status(404).send('No encontrado');

  // Comprobante en Cloudinary con entrega autenticada: cld:<resource_type>:<public_id>
  if (raw.startsWith('cld:')) {
    try {
      const idx = raw.indexOf(':', 4);
      const resourceType = raw.slice(4, idx);
      const publicId     = raw.slice(idx + 1);
      const signed = cloudinary.url(publicId, {
        resource_type: resourceType || 'image', type: 'authenticated',
        sign_url: true, secure: true,
      });
      return await proxyBytes(res, signed);
    } catch (e) {
      return res.status(502).send('Error al obtener el archivo');
    }
  }

  // Compatibilidad con comprobantes antiguos (URL pública de Cloudinary).
  // Se restringe el host para que solo se pueda proxear a Cloudinary.
  if (/^https?:\/\//i.test(raw)) {
    let host = '';
    try { host = new URL(raw).hostname; } catch { return res.status(400).send('URL inválida'); }
    if (!/(^|\.)cloudinary\.com$/i.test(host)) return res.status(400).send('Origen no permitido');
    try {
      return await proxyBytes(res, raw);
    } catch (e) {
      return res.status(502).send('Error al obtener el archivo');
    }
  }

  try {
    const uploadsDir = path.join(path.dirname(path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data.db'))), 'comprobantes');
    const safeName = path.basename(raw);
    const file = path.join(uploadsDir, safeName);
    if (!fs.existsSync(file)) return res.status(404).send('No encontrado');
    // Content-Type fijo por extensión y descarga (no render inline) para evitar
    // que un archivo malicioso se ejecute como HTML/SVG en el navegador del admin.
    const ext = path.extname(safeName).toLowerCase();
    const type = COMPROBANTE_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  } catch (e) {
    console.error('[comprobante] Error sirviendo archivo local:', e.message);
    res.status(500).send('Error al obtener el archivo');
  }
});

/* ── TESTIMONIOS ─────────────────────────────────────────── */
router.get('/testimonios', (req, res) => {
  res.json(getDB().prepare('SELECT * FROM testimonios ORDER BY sort_order').all());
});

router.post('/testimonios', (req, res) => {
  const { name, initials, location, flag, stars, text, service, date } = req.body;
  const db = getDB();
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM testimonios').get().m || 0;
  const r = db.prepare(`INSERT INTO testimonios (name,initials,location,flag,stars,text,service,date,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(name, initials, location, flag||'🌍', stars||5, text, service, date, maxOrder+1);
  res.json({ id: r.lastInsertRowid });
});

router.put('/testimonios/:id', (req, res) => {
  const { name, initials, location, flag, stars, text, service, date, active } = req.body;
  getDB().prepare(`UPDATE testimonios SET name=?,initials=?,location=?,flag=?,stars=?,text=?,service=?,date=?,active=? WHERE id=?`)
    .run(name, initials, location, flag, stars, text, service, date, active??1, req.params.id);
  res.json({ ok: true });
});

router.delete('/testimonios/:id', (req, res) => {
  getDB().prepare('DELETE FROM testimonios WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ── SERVICIOS ───────────────────────────────────────────── */
router.get('/servicios', (req, res) => {
  res.json(getDB().prepare('SELECT * FROM servicios ORDER BY sort_order').all()
    .map(s => ({ ...s, tags: JSON.parse(s.tags) })));
});

router.put('/servicios/:id', (req, res) => {
  const { title, description, tags } = req.body;
  getDB().prepare('UPDATE servicios SET title=?,description=?,tags=? WHERE id=?')
    .run(title, description, JSON.stringify(tags||[]), req.params.id);
  res.json({ ok: true });
});

/* ── PROMO CARDS ─────────────────────────────────────────── */
router.get('/promo-cards', (req, res) => {
  res.json(getDB().prepare('SELECT * FROM promo_cards ORDER BY sort_order').all()
    .map(p => ({ ...p, bullets: JSON.parse(p.bullets) })));
});

router.put('/promo-cards/:id', (req, res) => {
  const { title, subtitle, description, badge, bullets, image, cta_text, active } = req.body;
  getDB().prepare(`UPDATE promo_cards SET title=?,subtitle=?,description=?,badge=?,bullets=?,image=?,cta_text=?,active=? WHERE id=?`)
    .run(title, subtitle, description, badge, JSON.stringify(bullets||[]), image, cta_text, active??1, req.params.id);
  res.json({ ok: true });
});

/* ── CITAS ───────────────────────────────────────────────── */
router.get('/citas', (req, res) => {
  res.json(getDB().prepare('SELECT * FROM citas ORDER BY fecha DESC, hora ASC').all());
});

router.get('/otp-pending', (req, res) => {
  const rows = getDB().prepare(
    "SELECT email, phone, code, expires_at FROM otp_verifications WHERE used=0 AND expires_at > datetime('now') ORDER BY expires_at ASC"
  ).all();
  res.json(rows);
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.put('/citas/:id', async (req, res) => {
  const { estado, zoom_link, resumen_titulo, resumen_texto,
          nombre, email, cliente_telefono, cliente_doc, monto_pagado, factura_descripcion } = req.body;
  const db = getDB();
  if (zoom_link !== undefined) {
    db.prepare('UPDATE citas SET zoom_link=? WHERE id=?').run(zoom_link, req.params.id);
  }
  if (resumen_titulo !== undefined || resumen_texto !== undefined) {
    if (email !== undefined && email !== '' && !EMAIL_RE.test(email))
      return res.status(400).json({ error: 'Correo inválido' });
    let montoNum = null;
    if (monto_pagado !== undefined && monto_pagado !== '') {
      montoNum = parseFloat(monto_pagado);
      if (isNaN(montoNum) || montoNum < 0)
        return res.status(400).json({ error: 'Valor de servicio inválido' });
    }
    db.prepare(`UPDATE citas SET resumen_titulo=?, resumen_texto=?,
      nombre=COALESCE(?,nombre), email=COALESCE(?,email),
      cliente_telefono=COALESCE(?,cliente_telefono), cliente_doc=COALESCE(?,cliente_doc),
      monto_pagado=COALESCE(?,monto_pagado), factura_descripcion=COALESCE(?,factura_descripcion)
      WHERE id=?`)
      .run(resumen_titulo ?? '', resumen_texto ?? '',
           nombre !== undefined ? String(nombre).slice(0, 120) : null,
           email !== undefined ? String(email).slice(0, 160) : null,
           cliente_telefono !== undefined ? String(cliente_telefono).slice(0, 30) : null,
           cliente_doc !== undefined ? String(cliente_doc).slice(0, 20) : null,
           montoNum,
           factura_descripcion !== undefined ? String(factura_descripcion).slice(0, 300) : null,
           req.params.id);
    return res.json({ ok: true });
  }
  if (req.body.comprobante_estado !== undefined) {
    const nuevoEstado = req.body.comprobante_estado;
    if (nuevoEstado === 'rechazado') {
      db.prepare("UPDATE citas SET comprobante_estado=?, factura_estado='rechazada' WHERE id=?")
        .run(nuevoEstado, req.params.id);
    } else {
      db.prepare('UPDATE citas SET comprobante_estado=? WHERE id=?').run(nuevoEstado, req.params.id);
    }
    return res.json({ ok: true });
  }
  db.prepare('UPDATE citas SET estado=? WHERE id=?').run(estado, req.params.id);
  if (estado === 'confirmada') {
    const cita = db.prepare('SELECT * FROM citas WHERE id=?').get(req.params.id);
    if (cita) {
      try { await sendCitaConfirmada(cita); }
      catch (e) { console.error('[email] Error enviando confirmación:', e.message); }
    }
  }
  res.json({ ok: true });
});

// Verifica el pago de una cita y dispara la emisión de la factura vinculada
// (monto y documento del cliente ya se cargaron al subir el comprobante).
router.post('/citas/:id/verificar-pago', async (req, res) => {
  const db = getDB();
  const cita = db.prepare('SELECT * FROM citas WHERE id=?').get(req.params.id);
  if (!cita) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!cita.monto_pagado || cita.monto_pagado <= 0 || !cita.cliente_doc)
    return res.status(400).json({ error: 'La cita no tiene monto o documento del cliente registrado' });
  if (cita.factura_id)
    return res.status(409).json({ error: 'Esta cita ya tiene una factura asociada' });

  db.prepare("UPDATE citas SET comprobante_estado='verificado' WHERE id=?").run(cita.id);

  const result = await crearYEmitirFactura(db, {
    cita_id: cita.id, cliente_nombre: cita.nombre, cliente_email: cita.email,
    cliente_telefono: cita.cliente_telefono, cliente_doc: cita.cliente_doc, monto: cita.monto_pagado,
    concepto: cita.factura_descripcion || `Servicios legales — Cita #${cita.id}`
  });
  res.json(result);
});

// Envía un correo puntual al cliente con título, mensaje y un adjunto (independiente del Resumen de la cita).
const uploadAdjunto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/citas/:id/enviar-correo', uploadAdjunto.single('adjunto'), async (req, res) => {
  const db = getDB();
  const cita = db.prepare('SELECT * FROM citas WHERE id=?').get(req.params.id);
  if (!cita) return res.status(404).json({ error: 'NOT_FOUND' });

  const titulo  = String(req.body.titulo || '').trim().slice(0, 200);
  const mensaje = String(req.body.mensaje || '').trim().slice(0, 9999);
  if (!titulo || !mensaje) return res.status(400).json({ error: 'Falta título o mensaje' });

  try {
    await sendCorreoAdjunto(cita, titulo, mensaje, req.file);
    db.prepare("UPDATE citas SET correo_enviado_at=datetime('now','localtime') WHERE id=?").run(cita.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[email] Error enviando correo con adjunto:', e.message);
    res.status(500).json({ error: 'Error al enviar el correo' });
  }
});

// Envía un correo a la notaría (destinatario libre, lo escribe el admin cada
// vez — no se guarda en la cita) con los datos del cliente ya armados en el
// cuerpo + un mensaje libre y adjunto opcional. Solo tiene sentido después de
// haberle avisado al cliente (correo_enviado_at seteado); se exige también
// del lado del servidor, no solo ocultando el botón en el panel.
router.post('/citas/:id/enviar-correo-notaria', uploadAdjunto.single('adjunto'), async (req, res) => {
  const db = getDB();
  const cita = db.prepare('SELECT * FROM citas WHERE id=?').get(req.params.id);
  if (!cita) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!cita.correo_enviado_at)
    return res.status(403).json({ error: 'Primero hay que enviarle el correo al cliente' });

  const notariaEmail = String(req.body.notaria_email || '').trim();
  const titulo  = String(req.body.titulo || '').trim().slice(0, 200);
  const mensaje = String(req.body.mensaje || '').trim().slice(0, 9999);
  if (!notariaEmail || !EMAIL_RE.test(notariaEmail)) return res.status(400).json({ error: 'Email de notaría inválido' });
  if (!titulo || !mensaje) return res.status(400).json({ error: 'Falta título o mensaje' });

  try {
    await sendCorreoNotaria(cita, notariaEmail, titulo, mensaje, req.file);
    db.prepare("UPDATE citas SET correo_notaria_enviado_at=datetime('now','localtime') WHERE id=?").run(cita.id);
    const updated = db.prepare('SELECT correo_notaria_enviado_at FROM citas WHERE id=?').get(cita.id);
    res.json({ ok: true, correo_notaria_enviado_at: updated.correo_notaria_enviado_at });
  } catch (e) {
    console.error('[email] Error enviando correo a notaría:', e.message);
    res.status(500).json({ error: 'Error al enviar el correo' });
  }
});

router.delete('/citas/:id', (req, res) => {
  getDB().prepare('DELETE FROM citas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ── CONTENIDO GENERAL ───────────────────────────────────── */
router.get('/contenido', (req, res) => {
  res.json(Object.fromEntries(
    getDB().prepare('SELECT key,value FROM contenido').all().map(r => [r.key, r.value])
  ));
});

router.put('/contenido', (req, res) => {
  const upd = getDB().prepare('UPDATE contenido SET value=? WHERE key=?');
  // Solo actualiza claves ya existentes; coerciona a string.
  Object.entries(req.body || {}).forEach(([k, v]) => {
    if (v !== null && typeof v !== 'object') upd.run(String(v), k);
  });
  res.json({ ok: true });
});

/* ── CONTACTO ────────────────────────────────────────────── */
router.get('/contacto', (req, res) => {
  res.json(Object.fromEntries(
    getDB().prepare('SELECT key,value FROM contacto').all().map(r => [r.key, r.value])
  ));
});

// Claves de `contacto` editables desde el panel de contacto. La config SRI y
// la contraseña del .p12 se gestionan aparte (por /sri-config, con validación).
const CONTACTO_EDITABLE = new Set([
  'whatsapp', 'telefono', 'email', 'cobertura',
  'banco_nombre', 'banco_titular', 'banco_tipo', 'banco_cuenta', 'banco_nota',
]);

router.put('/contacto', (req, res) => {
  const upd = getDB().prepare('UPDATE contacto SET value=? WHERE key=?');
  Object.entries(req.body || {}).forEach(([k, v]) => {
    if (CONTACTO_EDITABLE.has(k) && v !== null && typeof v !== 'object') upd.run(String(v), k);
  });
  res.json({ ok: true });
});

module.exports = router;
