'use strict';

const crypto = require('crypto');

/*
 * Cabeceras de seguridad HTTP (equivalente ligero a helmet, sin dependencias).
 *
 * script-src NO lleva 'unsafe-inline': se genera un nonce distinto por
 * request (res.locals.cspNonce) que los handlers de /admin y del sitio
 * público usan para marcar su único <script> inline (ver server.js). Los
 * ~130 handlers onXXX="" que había en el HTML se convirtieron a
 * addEventListener/delegación de eventos — un atributo onclick="" cuenta
 * como script inline para la CSP y un nonce NO lo habilita.
 *
 * style-src SÍ mantiene 'unsafe-inline' a propósito: son ~160 atributos
 * style="" repartidos por el HTML; convertirlos todos a clases CSS es un
 * trabajo enorme para un riesgo bajo (inyección de CSS, no ejecución de
 * código). Documentado como decisión consciente, no un olvido.
 */
function buildCSP(nonce) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `script-src 'self' 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "frame-src 'self' blob:",
  ].join('; ');
}

module.exports = function securityHeaders(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy', buildCSP(res.locals.cspNonce));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');
  // HSTS solo tiene sentido sobre HTTPS (Railway termina TLS en el proxy)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
};
