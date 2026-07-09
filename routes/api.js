const express = require('express');
const { getDB } = require('../database');

const router = express.Router();

const SLOTS_ALL = ['09:00','10:00','11:00','12:00','14:00','15:00','16:00','17:00'];

/* Slots disponibles para una fecha (GET /api/citas/disponibles?fecha=YYYY-MM-DD) */
router.get('/citas/disponibles', (req, res) => {
  const { fecha } = req.query;
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });
  const ocupadas = getDB().prepare('SELECT hora FROM citas WHERE fecha=?').all(fecha).map(r => r.hora);
  res.json({ disponibles: SLOTS_ALL.filter(s => !ocupadas.includes(s)) });
});

/* Crear cita (POST /api/citas) */
router.post('/citas', (req, res) => {
  const { nombre, email, fecha, hora, contacto_tipo, contacto_valor } = req.body;
  if (!nombre || !email || !fecha || !hora) return res.status(400).json({ error: 'Faltan campos' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !SLOTS_ALL.includes(hora))
    return res.status(400).json({ error: 'Fecha u hora inválida' });
  const tipo = contacto_tipo === 'whatsapp' ? 'whatsapp' : 'zoom';
  const valor = String(contacto_valor || '').trim();
  try {
    getDB().prepare('INSERT INTO citas (nombre,email,fecha,hora,contacto_tipo,contacto_valor) VALUES (?,?,?,?,?,?)')
      .run(nombre, email, fecha, hora, tipo, valor);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'SLOT_TAKEN' });
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/content', (req, res) => {
  const db = getDB();
  const testimonios  = db.prepare('SELECT * FROM testimonios WHERE active=1 ORDER BY sort_order').all();
  const servicios    = db.prepare('SELECT * FROM servicios ORDER BY sort_order').all()
    .map(s => ({ ...s, tags: JSON.parse(s.tags) }));
  const contenido    = Object.fromEntries(db.prepare('SELECT key,value FROM contenido').all().map(r => [r.key, r.value]));
  const contacto     = Object.fromEntries(db.prepare('SELECT key,value FROM contacto').all().map(r => [r.key, r.value]));
  const promoCards   = db.prepare('SELECT * FROM promo_cards WHERE active=1 ORDER BY sort_order').all()
    .map(p => ({ ...p, bullets: JSON.parse(p.bullets) }));
  res.json({ testimonios, servicios, contenido, contacto, promoCards });
});

module.exports = router;
