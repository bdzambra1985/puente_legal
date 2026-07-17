const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../database');
const authMiddleware = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { SECRET } = require('../config');

const router = express.Router();

// Hash "señuelo" para que el tiempo de respuesta sea similar exista o no el usuario
// (evita enumeración de usuarios por temporización). Password imposible de acertar.
const DUMMY_HASH = bcrypt.hashSync('__no_such_user__', 10);

// Backstop grueso por IP: máx. 30 peticiones de login cada 15 min.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Demasiados intentos de acceso. Espera unos minutos e intenta de nuevo.',
});

// Anti-fuerza-bruta: se cuentan SOLO los intentos FALLIDOS por IP. Tras 5 fallos
// en 15 min se bloquea esa IP; un login exitoso limpia el contador. Se cuenta por
// IP (no por cuenta) a propósito: con un solo usuario admin, un bloqueo por cuenta
// permitiría a un atacante dejar al admin fuera (denegación de servicio).
const FAIL_MAX = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map(); // ip -> { count, reset }

function ipKey(req) { return req.ip || req.connection?.remoteAddress || 'unknown'; }

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Credenciales requeridas' });

  const key = ipKey(req);
  const now = Date.now();
  const entry = failedLogins.get(key);
  if (entry && entry.reset > now && entry.count >= FAIL_MAX) {
    const retry = Math.ceil((entry.reset - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.' });
  }

  const user = getDB().prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  const hash = user ? user.password_hash : DUMMY_HASH;
  const valid = bcrypt.compareSync(password, hash);

  if (!user || !valid) {
    const e = (entry && entry.reset > now) ? entry : { count: 0, reset: now + FAIL_WINDOW_MS };
    e.count++;
    failedLogins.set(key, e);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  failedLogins.delete(key); // login correcto → limpia el contador de esa IP

  const token = jwt.sign({ id: user.id, username: user.username, typ: 'admin' }, SECRET, { expiresIn: '8h' });
  res.json({
    token,
    username: user.username,
    mustChangePassword: !!user.must_change_password,
  });
});

router.post('/change-password', authMiddleware, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const hash = bcrypt.hashSync(newPassword, 10);
  getDB().prepare('UPDATE admin_users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(hash, req.admin.id);
  res.json({ ok: true });
});

module.exports = router;
