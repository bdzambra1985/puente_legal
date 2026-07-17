const jwt = require('jsonwebtoken');
const { SECRET } = require('../config');

module.exports = function(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
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
