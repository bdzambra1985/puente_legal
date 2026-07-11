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

module.exports = { SECRET };
