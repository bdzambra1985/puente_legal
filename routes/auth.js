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

// Máximo 10 intentos de login por IP cada 15 minutos
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos de acceso. Espera unos minutos e intenta de nuevo.',
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Credenciales requeridas' });

  const user = getDB().prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  const hash = user ? user.password_hash : DUMMY_HASH;
  const valid = bcrypt.compareSync(password, hash);

  if (!user || !valid)
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

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
