const express = require('express');
const { getDB } = require('../database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

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

router.put('/citas/:id', (req, res) => {
  const { estado } = req.body;
  getDB().prepare('UPDATE citas SET estado=? WHERE id=?').run(estado, req.params.id);
  res.json({ ok: true });
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
  Object.entries(req.body).forEach(([k,v]) => upd.run(v, k));
  res.json({ ok: true });
});

/* ── CONTACTO ────────────────────────────────────────────── */
router.get('/contacto', (req, res) => {
  res.json(Object.fromEntries(
    getDB().prepare('SELECT key,value FROM contacto').all().map(r => [r.key, r.value])
  ));
});

router.put('/contacto', (req, res) => {
  const upd = getDB().prepare('UPDATE contacto SET value=? WHERE key=?');
  Object.entries(req.body).forEach(([k,v]) => upd.run(v, k));
  res.json({ ok: true });
});

module.exports = router;
