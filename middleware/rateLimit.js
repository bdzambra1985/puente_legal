'use strict';

/*
 * Rate limiter en memoria, sin dependencias (suficiente para un despliegue
 * de instancia única como Railway). Cuenta peticiones por clave (IP + ruta,
 * o una clave personalizada) dentro de una ventana deslizante simple.
 *
 * NOTA: si en el futuro se escala a múltiples instancias, conviene migrar a
 * un almacén compartido (Redis) o al middleware nativo de la plataforma.
 */
function rateLimit({ windowMs = 60_000, max = 30, keyGenerator, message } = {}) {
  const hits = new Map(); // key -> { count, reset }

  // Limpieza periódica para no acumular memoria
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return function (req, res, next) {
    const now = Date.now();
    const ipRaw = req.ip || req.connection?.remoteAddress || 'unknown';
    const baseKey = keyGenerator ? keyGenerator(req) : ipRaw;
    const key = `${req.method}:${req.baseUrl || ''}${req.path}:${baseKey}`;

    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (entry.count > max) {
      const retry = Math.ceil((entry.reset - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: message || 'Demasiadas solicitudes. Intenta más tarde.' });
    }
    next();
  };
}

module.exports = rateLimit;
