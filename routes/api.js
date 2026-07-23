const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { getDB } = require('../database');
const { sendOTP, sendComprobanteNotificacion, sendCitaNuevaNotificacion } = require('../utils/email');
const { saveComprobante } = require('../utils/upload');
const rateLimit = require('../middleware/rateLimit');
const { SECRET } = require('../config');

const router = express.Router();

const uploadsDir = path.join(path.dirname(path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data.db'))), 'comprobantes');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Comprobantes: se guardan en memoria para validar el contenido real (magic bytes)
// antes de escribir a disco. Así el tipo/extensión no dependen de datos del cliente.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Detecta el tipo real por los primeros bytes. Devuelve la extensión segura o null.
function detectFileType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

const SLOTS_ALL = ['09:00','10:00','11:00','12:00','14:00','15:00','16:00','17:00'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fecha/hora actual en Ecuador (UTC-5 fijo, sin horario de verano).
function ahoraEcuador() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, minutos: parseInt(partes.hour, 10) * 60 + parseInt(partes.minute, 10) };
}

function slotAMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

// Un horario deja de poder agendarse si la fecha ya pasó, o si es hoy y falta
// menos de 1 hora para esa hora (bloquea también, de paso, las horas ya
// pasadas del día de hoy). Fechas futuras no tienen esta restricción.
function horaFueraDeRango(fecha, hora) {
  const { fecha: hoy, minutos: ahora } = ahoraEcuador();
  if (fecha < hoy) return true;
  if (fecha > hoy) return false;
  return slotAMinutos(hora) < ahora + 60;
}

function genCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 dígitos, CSPRNG
}

// Número de referencia de cita para mostrar en el admin: 0000001.
function refCita(id) {
  return String(id).padStart(7, '0');
}

function issueVerifToken(email) {
  return jwt.sign({ email: String(email).toLowerCase(), scope: 'cita', typ: 'cita' }, SECRET, { expiresIn: '20m' });
}

function verifTokenEmail(token) {
  try {
    const p = jwt.verify(token, SECRET);
    return p.scope === 'cita' ? p.email : null;
  } catch { return null; }
}

// Limitadores
const otpByEmail = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyGenerator: r => (r.body?.email || '').toLowerCase(),
  message: 'Demasiadas solicitudes de código para este correo. Espera unos minutos.' });
// Límite por IP (además del límite por email): evita que se use el servicio de
// correo para enviar OTP a muchas direcciones distintas (spam/abuso de cuota).
const otpByIp = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,
  message: 'Demasiadas solicitudes de código desde esta red. Espera unos minutos.' });
const verifLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Demasiados intentos. Espera unos minutos.' });
const citaLimiter  = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, message: 'Demasiadas solicitudes. Intenta más tarde.' });
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Demasiadas subidas. Intenta más tarde.' });

/* Enviar OTP (POST /api/citas/send-otp) */
router.post('/citas/send-otp', otpByIp, otpByEmail, async (req, res) => {
  const { email, phone } = req.body;
  if (!email || !EMAIL_RE.test(email))
    return res.status(400).json({ error: 'Email inválido' });
  const code = genCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const db = getDB();
  db.prepare('DELETE FROM otp_verifications WHERE email=?').run(email);
  db.prepare('INSERT INTO otp_verifications (email,phone,code,expires_at) VALUES (?,?,?,?)').run(email, phone || '', code, expires);
  try {
    const resendId = await sendOTP(email, code);
    if (resendId) db.prepare('UPDATE otp_verifications SET resend_email_id=? WHERE email=?').run(resendId, email);
    res.json({ ok: true });
  } catch (e) {
    console.error('[otp] Error enviando email:', e.message);
    res.status(500).json({ error: 'Error al enviar el correo' });
  }
});

// Límite laxo: el frontend consulta esto cada pocos segundos mientras el
// cliente está en la pantalla de "ingresa el código" esperando su correo.
const otpStatusLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 100,
  keyGenerator: r => (r.query?.email || '').toLowerCase(), message: 'Demasiadas consultas. Espera un momento.' });

/* Estado del envío del OTP por correo (GET /api/citas/otp-status?email=...)
   Permite avisarle al cliente, mientras espera el código, si el correo que
   escribió rebotó (bounce/suppressed) o si Resend ya confirmó la entrega
   (delivered) — hasta que llegue uno de los dos, el estado queda "pendiente"
   en el frontend, nunca se asume enviado de antemano. */
router.get('/citas/otp-status', otpStatusLimiter, (req, res) => {
  const { email } = req.query;
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email inválido' });
  // Sin "AND used=0" a propósito: la confirmación de entrega (email.delivered)
  // suele llegar DESPUÉS de que el cliente ya verificó el código (used pasa a
  // 1 en ese momento) — sobre todo en el modo WhatsApp, donde el código lo
  // conoce el navegador de entrada y no depende de leerlo del correo. El
  // patrón delete-then-insert de arriba ya garantiza una sola fila por
  // email, así que filtrar por used=0 acá solo perdía la confirmación tardía.
  const otp = getDB().prepare('SELECT bounced_at, delivered_at FROM otp_verifications WHERE email=? ORDER BY id DESC LIMIT 1').get(email);
  res.json({ bounced: !!(otp && otp.bounced_at), delivered: !!(otp && otp.delivered_at) });
});

// Verifica la firma Svix que Resend adjunta a sus webhooks (cabeceras
// svix-id/svix-timestamp/svix-signature) usando el secreto RESEND_WEBHOOK_SECRET
// (se obtiene al crear el webhook en el panel de Resend). Sin firma válida,
// cualquiera podría marcar OTPs ajenos como rebotados.
function verifyResendWebhook(req) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const id = req.headers['svix-id'];
  const timestamp = req.headers['svix-timestamp'];
  const sigHeader = req.headers['svix-signature'];
  if (!secret || !id || !timestamp || !sigHeader || !req.rawBody) return false;

  const ts = parseInt(timestamp, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false; // ventana anti-replay

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${req.rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return sigHeader.split(' ').some(part => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    try {
      const a = Buffer.from(sig, 'base64'), b = Buffer.from(expected, 'base64');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  });
}

// Además de email.bounced (rebote real, la primera vez que un correo falla),
// Resend agrega automáticamente esa dirección a su lista de supresión para
// cuidar la reputación del remitente: los envíos siguientes a la misma
// dirección ni se intentan entregar, quedan en estado "suppressed" y
// disparan email.suppressed en vez de email.bounced — sin tratar ambos
// casos igual, un correo que ya falló una vez queda "silencioso" para
// siempre en los intentos posteriores.
const BOUNCE_LIKE_EVENTS = new Set(['email.bounced', 'email.suppressed']);

/* Webhook de Resend (POST /api/webhooks/resend) — notifica rebotes/supresiones/entregas de correo. */
router.post('/webhooks/resend', (req, res) => {
  if (!verifyResendWebhook(req)) return res.status(401).json({ error: 'Firma inválida' });
  const { type, data } = req.body || {};
  // Sin "AND used=0" — ver comentario en /citas/otp-status: la confirmación
  // puede llegar después de que el cliente ya verificó el código.
  if (BOUNCE_LIKE_EVENTS.has(type) && data && data.email_id) {
    getDB().prepare('UPDATE otp_verifications SET bounced_at=? WHERE resend_email_id=?')
      .run(new Date().toISOString(), data.email_id);
  } else if (type === 'email.delivered' && data && data.email_id) {
    getDB().prepare('UPDATE otp_verifications SET delivered_at=? WHERE resend_email_id=?')
      .run(new Date().toISOString(), data.email_id);
  }
  res.json({ ok: true });
});

/* Verificar OTP (POST /api/citas/verify-otp) → devuelve token de verificación */
router.post('/citas/verify-otp', verifLimiter, (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Faltan campos' });
  const db = getDB();
  const otp = db.prepare('SELECT * FROM otp_verifications WHERE email=? AND used=0 ORDER BY id DESC LIMIT 1').get(email);
  if (!otp) return res.status(400).json({ error: 'INVALID_CODE' });
  if (new Date(otp.expires_at) < new Date()) {
    db.prepare('UPDATE otp_verifications SET used=1 WHERE id=?').run(otp.id);
    return res.status(400).json({ error: 'EXPIRED' });
  }
  if (otp.attempts >= 5) {
    db.prepare('UPDATE otp_verifications SET used=1 WHERE id=?').run(otp.id);
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  }
  if (otp.code !== String(code).trim()) {
    db.prepare('UPDATE otp_verifications SET attempts=attempts+1 WHERE id=?').run(otp.id);
    return res.status(400).json({ error: 'INVALID_CODE' });
  }
  db.prepare('UPDATE otp_verifications SET used=1 WHERE id=?').run(otp.id);
  res.json({ ok: true, verifToken: issueVerifToken(email) });
});

/* Generar código WhatsApp (POST /api/citas/gen-code) — el usuario lo envía por WhatsApp,
   y ahora también se le manda el mismo código por correo: el flujo de WhatsApp valida el
   correo igual que el de Zoom (bounce/suppressed vía webhook), ya que ese correo es donde
   después le va a llegar la confirmación de la cita. */
router.post('/citas/gen-code', otpByIp, otpByEmail, async (req, res) => {
  const { email, phone } = req.body;
  if (!email || !EMAIL_RE.test(email))
    return res.status(400).json({ error: 'Email inválido' });
  const code = genCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const db = getDB();
  db.prepare('DELETE FROM otp_verifications WHERE email=?').run(email);
  db.prepare('INSERT INTO otp_verifications (email,phone,code,expires_at) VALUES (?,?,?,?)').run(email, phone || '', code, expires);
  try {
    const resendId = await sendOTP(email, code);
    if (resendId) db.prepare('UPDATE otp_verifications SET resend_email_id=? WHERE email=?').run(resendId, email);
    res.json({ ok: true, code });
  } catch (e) {
    console.error('[gen-code] Error enviando email:', e.message);
    res.status(500).json({ error: 'Error al enviar el correo' });
  }
});

/* Slots disponibles para una fecha (GET /api/citas/disponibles?fecha=YYYY-MM-DD) */
router.get('/citas/disponibles', (req, res) => {
  const { fecha } = req.query;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });
  const ocupadas = getDB().prepare('SELECT hora FROM citas WHERE fecha=?').all(fecha).map(r => r.hora);
  res.json({ disponibles: SLOTS_ALL.filter(s => !ocupadas.includes(s) && !horaFueraDeRango(fecha, s)) });
});

/* Crear cita (POST /api/citas) — requiere token de verificación de email */
router.post('/citas', citaLimiter, (req, res) => {
  const { nombre, email, fecha, hora, contacto_tipo, contacto_valor, verifToken } = req.body;
  if (!nombre || !email || !fecha || !hora) return res.status(400).json({ error: 'Faltan campos' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !SLOTS_ALL.includes(hora))
    return res.status(400).json({ error: 'Fecha u hora inválida' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email inválido' });
  // Revalida acá por si el cliente tardó (ej. verificando el OTP) y el
  // horario que había elegido ya quedó fuera de rango mientras tanto.
  if (horaFueraDeRango(fecha, hora)) return res.status(400).json({ error: 'HORA_FUERA_DE_RANGO' });

  // El correo debe estar verificado (OTP) y el token corresponder a ese correo
  const verifiedEmail = verifTokenEmail(verifToken);
  if (!verifiedEmail || verifiedEmail !== String(email).toLowerCase())
    return res.status(401).json({ error: 'VERIF_REQUIRED' });

  const tipo = contacto_tipo === 'whatsapp' ? 'whatsapp' : 'zoom';
  const valor = String(contacto_valor || '').trim().slice(0, 120);
  try {
    const db2 = getDB();
    const result = db2
      .prepare('INSERT INTO citas (nombre,email,fecha,hora,contacto_tipo,contacto_valor) VALUES (?,?,?,?,?,?)')
      .run(String(nombre).slice(0, 120), String(email).slice(0, 160), fecha, hora, tipo, valor);
    const newId = result.lastInsertRowid;

    // Número de referencia mostrado en el admin, formato SL-0000001. Si este
    // cliente (mismo nombre+correo, sin distinguir mayúsculas/espacios) ya
    // tenía citas, la nueva lleva "<ref-de-su-primera-cita>-N" (N = cuántas
    // tenía antes, ej. SL-0000001-1). Si es su primera cita, lleva su propio
    // número formateado a partir de su id.
    const previas = db2.prepare(
      'SELECT id, ref_display FROM citas WHERE id<>? AND LOWER(TRIM(nombre))=LOWER(TRIM(?)) AND LOWER(TRIM(email))=LOWER(TRIM(?)) ORDER BY id ASC'
    ).all(newId, nombre, email);
    let refDisplay;
    if (previas.length === 0) {
      refDisplay = refCita(newId);
    } else {
      const primera = previas[0];
      const base = primera.ref_display || refCita(primera.id);
      refDisplay = `${base}-${previas.length}`;
    }
    db2.prepare('UPDATE citas SET ref_display=? WHERE id=?').run(refDisplay, newId);

    res.json({ ok: true, id: newId, ref_display: refDisplay });
    // Aviso al despacho de que entró una cita nueva, sea por Zoom o por
    // WhatsApp — se manda al correo de notificaciones configurado en el
    // admin. No debe bloquear ni condicionar la respuesta ya enviada.
    const notifEmail = getDB().prepare("SELECT value FROM contacto WHERE key='email_notificaciones'").get();
    if (notifEmail && notifEmail.value) {
      const cita = { id: result.lastInsertRowid, ref_display: refDisplay, nombre, email, fecha, hora, contacto_tipo: tipo, contacto_valor: valor };
      sendCitaNuevaNotificacion(cita, notifEmail.value)
        .catch(e => console.error('[citas] Error enviando notificación de nueva cita:', e.message));
    }
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'SLOT_TAKEN' });
    console.error('[citas] Error creando cita:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

/* Buscar cita por número (GET /api/citas/:id?email=...) — requiere email coincidente.
   El "número" que ve el cliente es ref_display (ej. 0000001 o 0000001-1); se
   busca primero por ese valor. Como respaldo (citas viejas sin ref_display, o si
   escriben el id pelado) también se intenta por id numérico si es solo dígitos. */

// Normaliza lo que escribe el cliente a la forma guardada (con ceros a la
// izquierda): "1" -> "0000001", "1-1" -> "0000001-1", "7-2" -> "0000007-2".
// Devuelve la lista de variantes a probar (incluye siempre lo escrito tal cual).
function refCandidatos(raw) {
  const cands = new Set([raw]);
  const m = raw.match(/^0*(\d+)(?:-0*(\d+))?$/);
  if (m) {
    const base = m[1].padStart(7, '0');
    cands.add(m[2] != null ? `${base}-${m[2]}` : base);
  }
  return [...cands];
}

router.get('/citas/:id', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  const raw = String(req.params.id || '').trim();
  const cols = 'SELECT id,ref_display,nombre,email,fecha,hora,contacto_tipo,estado,comprobante_estado,resumen_texto FROM citas WHERE ';
  const db = getDB();
  const cands = refCandidatos(raw);
  let cita = db.prepare(cols + `ref_display IN (${cands.map(() => '?').join(',')})`).get(...cands);
  if (!cita && /^\d+$/.test(raw)) cita = db.prepare(cols + 'id=?').get(Number(raw));
  // Misma respuesta si no existe o el email no coincide (evita enumeración)
  if (!cita || String(cita.email).toLowerCase() !== email)
    return res.status(404).json({ error: 'NOT_FOUND' });
  delete cita.email;
  // El pago solo se habilita una vez que el admin confirmó la cita Y guardó
  // el resumen — no se expone el contenido del resumen en sí, solo si existe.
  cita.puedePagar = cita.estado === 'confirmada' && !!(cita.resumen_texto || '').trim();
  delete cita.resumen_texto;
  res.json(cita);
});

/* Subir comprobante (POST /api/citas/:id/comprobante) — requiere email coincidente */
router.post('/citas/:id/comprobante', uploadLimiter, upload.single('comprobante'), async (req, res) => {
  const db = getDB();
  const email = String(req.body.email || '').trim().toLowerCase();
  const cita = db.prepare('SELECT id,ref_display,nombre,email,estado,resumen_texto FROM citas WHERE id=?').get(req.params.id);
  if (!cita || !email || String(cita.email).toLowerCase() !== email)
    return res.status(404).json({ error: 'NOT_FOUND' });
  if (cita.estado !== 'confirmada' || !(cita.resumen_texto || '').trim())
    return res.status(403).json({ error: 'PAGO_NO_HABILITADO' });
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });

  const ext = detectFileType(req.file.buffer);
  if (!ext) return res.status(400).json({ error: 'Tipo de archivo no permitido' });

  try {
    const { path: savedPath } = await saveComprobante(req.file.buffer, ext, cita.id, uploadsDir);
    // El monto y la cédula/RUC ya no los ingresa el cliente acá — el admin los
    // define desde el popup "Resumen de la cita" antes de verificar el pago.
    db.prepare('UPDATE citas SET comprobante_path=?, comprobante_estado=?, factura_estado=? WHERE id=?')
      .run(savedPath, 'pendiente', 'pendiente', cita.id);
    res.json({ ok: true });
    // No debe bloquear ni condicionar la respuesta al cliente: si no hay
    // correo de notificaciones configurado, o falla el envío, el
    // comprobante ya quedó guardado igual.
    const notifEmail = db.prepare("SELECT value FROM contacto WHERE key='email_notificaciones'").get();
    if (notifEmail && notifEmail.value) {
      sendComprobanteNotificacion(cita, notifEmail.value)
        .catch(e => console.error('[comprobante] Error enviando notificación:', e.message));
    }
  } catch (e) {
    console.error('[comprobante] Error guardando archivo:', e.message);
    res.status(500).json({ error: 'Error al guardar el archivo' });
  }
});

// Solo estas claves de `contacto` se exponen públicamente. Excluye deliberadamente
// p12_password y la configuración SRI (sri_*), que son secretas/internas.
const PUBLIC_CONTACTO_KEYS = new Set([
  'whatsapp', 'telefono', 'email', 'cobertura',
  'banco_nombre', 'banco_titular', 'banco_tipo', 'banco_cuenta', 'banco_nota',
]);

router.get('/content', (req, res) => {
  const db = getDB();
  const testimonios  = db.prepare('SELECT * FROM testimonios WHERE active=1 ORDER BY sort_order').all();
  const servicios    = db.prepare('SELECT * FROM servicios ORDER BY sort_order').all()
    .map(s => ({ ...s, tags: JSON.parse(s.tags) }));
  const contenido    = Object.fromEntries(db.prepare('SELECT key,value FROM contenido').all().map(r => [r.key, r.value]));
  const contacto     = Object.fromEntries(
    db.prepare('SELECT key,value FROM contacto').all()
      .filter(r => PUBLIC_CONTACTO_KEYS.has(r.key))
      .map(r => [r.key, r.value]));
  const promoCards   = db.prepare('SELECT * FROM promo_cards WHERE active=1 ORDER BY sort_order').all()
    .map(p => ({ ...p, bullets: JSON.parse(p.bullets) }));
  res.json({ testimonios, servicios, contenido, contacto, promoCards });
});

module.exports = router;
