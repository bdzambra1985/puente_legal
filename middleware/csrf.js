'use strict';

const { parseCookies } = require('../utils/cookies');
const { CSRF_COOKIE } = require('../config');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Patrón double-submit: el CSRF token vive en una cookie legible por JS (a
// diferencia de la de sesión) y el frontend la reenvía en el header
// X-CSRF-Token en cada mutación. Un sitio de terceros puede hacer que el
// navegador mande la cookie sola, pero no puede leerla para poner el header
// (same-origin policy) — sin los dos valores iguales, se rechaza.
module.exports = function csrfCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookieToken = parseCookies(req.headers.cookie)[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken)
    return res.status(403).json({ error: 'CSRF_TOKEN_INVALID' });
  next();
};
