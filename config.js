'use strict';

const crypto = require('crypto');

/*
 * Secreto para firmar/verificar JWT.
 * - En producción es OBLIGATORIO definir JWT_SECRET; si falta, la app aborta
 *   (antes existía un valor por defecto público que permitía forjar tokens de admin).
 * - En desarrollo, si no está definido se genera uno efímero y aleatorio: los
 *   tokens dejan de ser válidos al reiniciar, pero nunca se usa un secreto conocido.
 */
let SECRET = process.env.JWT_SECRET;

if (!SECRET || SECRET.length < 16) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET no está definido (o es demasiado corto). ' +
      'Definí una variable de entorno JWT_SECRET larga y aleatoria antes de arrancar.');
    process.exit(1);
  }
  SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[seguridad] JWT_SECRET no definido — usando un secreto efímero de desarrollo. ' +
    'Los tokens se invalidarán al reiniciar el proceso.');
}

// Nombres de las cookies de sesión admin. El token va en una cookie HttpOnly
// (no accesible desde JS, así un XSS no puede robarlo); el CSRF token va en
// una cookie legible por JS a propósito (patrón double-submit: el frontend
// la lee y la reenvía en el header X-CSRF-Token en cada mutación).
const TOKEN_COOKIE = 'admin_token';
const CSRF_COOKIE = 'admin_csrf';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h, igual que expiresIn del JWT

module.exports = { SECRET, TOKEN_COOKIE, CSRF_COOKIE, COOKIE_MAX_AGE_MS };
