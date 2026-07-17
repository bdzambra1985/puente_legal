const jwt = require('jsonwebtoken');
const { SECRET, TOKEN_COOKIE } = require('../config');
const { parseCookies } = require('../utils/cookies');

module.exports = function(req, res, next) {
  // El token de sesión admin vive en una cookie HttpOnly (no en localStorage
  // ni en el header Authorization) — así un XSS no puede leerlo con JS.
  const token = parseCookies(req.headers.cookie)[TOKEN_COOKIE] || null;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const payload = jwt.verify(token, SECRET);
    // Endurecimiento: el mismo JWT_SECRET firma también los tokens de
    // verificación de cita (scope:'cita'), que cualquier usuario obtiene por OTP.
    // Solo los tokens de login llevan typ:'admin' — exigirlo evita que un token
    // de cliente sea aceptado como token de administrador.
    if (payload.typ !== 'admin')
      return res.status(401).json({ error: 'Token no autorizado' });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
