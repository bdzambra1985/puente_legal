const express = require('express');
const { getDB } = require('../database');

const router = express.Router();

router.get('/content', (req, res) => {
  const db = getDB();
  const testimonios = db.prepare('SELECT * FROM testimonios WHERE active=1 ORDER BY sort_order').all();
  const servicios   = db.prepare('SELECT * FROM servicios ORDER BY sort_order').all()
    .map(s => ({ ...s, tags: JSON.parse(s.tags) }));
  const contenido   = Object.fromEntries(db.prepare('SELECT key,value FROM contenido').all().map(r => [r.key, r.value]));
  const contacto    = Object.fromEntries(db.prepare('SELECT key,value FROM contacto').all().map(r => [r.key, r.value]));
  res.json({ testimonios, servicios, contenido, contacto });
});

module.exports = router;
