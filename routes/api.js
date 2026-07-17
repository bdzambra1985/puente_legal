const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { getDB } = require('../database');
const { sendOTP } = require('../utils/email');
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

function genCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 dígitos, CSPRNG
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
const verifLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Demasiados intentos. Espera unos minutos.' });
const citaLimiter  = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, message: 'Demasiadas solicitudes. Intenta más tarde.' });
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Demasiadas subidas. Intenta más tarde.' });

/* Enviar OTP (POST /api/citas/send-otp) */
router.post('/citas/send-otp', otpByEmail, async (req, res) => {
  const { email, phone } = req.body;
  if (!email || !EMAIL_RE.test(email))
    return res.status(400).json({ error: 'Email inválido' });
  const code = genCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const db = getDB();
  db.prepare('DELETE FROM otp_verifications WHERE email=?').run(email);
  db.prepare('INSERT INTO otp_verifications (email,phone,code,expires_at) VALUES (?,?,?,?)').run(email, phone || '', code, expires);
  try {
    await sendOTP(email, code);
    res.json({ ok: true });
  } catch (e) {
    console.error('[otp] Error enviando email:', e.message);
    res.status(500).json({ error: 'Error al enviar el correo' });
  }
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

/* Generar código WhatsApp (POST /api/citas/gen-code) — el usuario lo envía por WhatsApp */
router.post('/citas/gen-code', otpByEmail, (req, res) => {
  const { email, phone } = req.body;
  if (!email || !EMAIL_RE.test(email))
    return res.status(400).json({ error: 'Email inválido' });
  const code = genCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const db = getDB();
  db.prepare('DELETE FROM otp_verifications WHERE email=?').run(email);
  db.prepare('INSERT INTO otp_verifications (email,phone,code,expires_at) VALUES (?,?,?,?)').run(email, phone || '', code, expires);
  res.json({ ok: true, code });
});

/* Slots disponibles para una fecha (GET /api/citas/disponibles?fecha=YYYY-MM-DD) */
router.get('/citas/disponibles', (req, res) => {
  const { fecha } = req.query;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });
  const ocupadas = getDB().prepare('SELECT hora FROM citas WHERE fecha=?').all(fecha).map(r => r.hora);
  res.json({ disponibles: SLOTS_ALL.filter(s => !ocupadas.includes(s)) });
});

/* Crear cita (POST /api/citas) — requiere token de verificación de email */
router.post('/citas', citaLimiter, (req, res) => {
  const { nombre, email, fecha, hora, contacto_tipo, contacto_valor, verifToken } = req.body;
  if (!nombre || !email || !fecha || !hora) return res.status(400).json({ error: 'Faltan campos' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !SLOTS_ALL.includes(hora))
    return res.status(400).json({ error: 'Fecha u hora inválida' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email inválido' });

  // El correo debe estar verificado (OTP) y el token corresponder a ese correo
  const verifiedEmail = verifTokenEmail(verifToken);
  if (!verifiedEmail || verifiedEmail !== String(email).toLowerCase())
    return res.status(401).json({ error: 'VERIF_REQUIRED' });

  const tipo = contacto_tipo === 'whatsapp' ? 'whatsapp' : 'zoom';
  const valor = String(contacto_valor || '').trim().slice(0, 120);
  try {
    const result = getDB()
      .prepare('INSERT INTO citas (nombre,email,fecha,hora,contacto_tipo,contacto_valor) VALUES (?,?,?,?,?,?)')
      .run(String(nombre).slice(0, 120), String(email).slice(0, 160), fecha, hora, tipo, valor);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'SLOT_TAKEN' });
    console.error('[citas] Error creando cita:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

/* Buscar cita por ID (GET /api/citas/:id?email=...) — requiere email coincidente */
router.get('/citas/:id', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  const cita = getDB()
    .prepare('SELECT id,nombre,email,fecha,hora,contacto_tipo,estado,comprobante_estado,resumen_texto FROM citas WHERE id=?')
    .get(req.params.id);
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
  const cita = db.prepare('SELECT id,email,estado,resumen_texto FROM citas WHERE id=?').get(req.params.id);
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
