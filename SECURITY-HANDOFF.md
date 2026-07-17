# Handoff de seguridad — tarea pendiente #5 (CSP + token en cookie)

> Documento para retomar el trabajo en una sesión de Claude Code **local** (en la PC),
> donde SÍ se puede levantar la app y probarla antes de desplegar.
> Contexto: se hizo una auditoría de seguridad completa; los PR #1 y #2 ya están en `main`.
> Falta **solo** la mejora #5, que no se hizo en remoto porque no se podía probar la app
> end-to-end (el entorno remoto mata el servidor). Es **defensa en profundidad**, no un
> agujero abierto: los XSS explotables ya están cerrados (todas las salidas van escapadas).

## Estado actual (ya en `main`)
- ✅ Escalada de privilegios por confusión de tokens JWT cerrada (`middleware/auth.js` exige `typ:'admin'`).
- ✅ SSRF del proxy de comprobantes mitigado (`routes/admin.js` solo sirve rutas que existen en la BD).
- ✅ Comprobantes de Cloudinary con entrega autenticada (URLs firmadas).
- ✅ Login anti-fuerza-bruta por IP (5 fallos → bloqueo 15 min, solo cuenta fallos, por IP).
- ✅ Límite por IP en OTP (`send-otp`, `gen-code`).
- ✅ RNG criptográfico en la clave de acceso SRI. `.gitignore` cubre `*.p12` y `comprobantes/`.

## Objetivo de la #5
1. **Quitar `'unsafe-inline'` de la CSP** (al menos de `script-src`).
2. **Mover el token de admin de `localStorage` a una cookie `HttpOnly`** (para que un XSS
   no lo pueda robar) + protección CSRF.

## Por qué es un cambio grande (medir antes de tocar)
En el frontend actual hay (contar de nuevo por si cambió):
- ~130 manejadores inline (`onclick`, `oninput`, `onkeydown`…): **83** en `admin/index.html`,
  **47** en `public/index.html`. Comando: `grep -oE 'on(click|input|change|keydown|keyup|submit|focus|blur)=' admin/index.html | wc -l`
- 2 bloques `<script>` inline (uno por archivo).
- ~162 atributos `style=` inline (123 admin + 39 public).
- La sesión se detecta con `localStorage.getItem('pl_token')` en `admin/index.html`
  (aprox. líneas 813–875: `TOKEN`, `showApp`, `logout`).

Una CSP con `script-src` estricto **rompe los 130 `onclick` inline**: los nonces habilitan
los `<script>` pero NO los atributos `onXXX=`. Hay que convertirlos a `addEventListener`.

## Plan sugerido

### Parte A — CSP `script-src` sin `unsafe-inline`
1. Convertir **todos** los `onclick=`/`oninput=`/etc. a `addEventListener` (o delegación de
   eventos por `data-*` en un único listener raíz, que reduce el trabajo).
2. Los 2 bloques `<script>` inline: darles un **nonce por request**. Como el HTML se sirve
   con `res.sendFile` (estático), cambiar a leer el archivo, inyectar
   `nonce="<valor>"` y setear la CSP con ese mismo nonce por request (middleware).
3. **Mantener `style-src 'unsafe-inline'`** (los 162 `style=` inline): la inyección de CSS
   es riesgo bajo; quitarlo es enorme y aporta poco. Dejarlo documentado.
4. Actualizar `middleware/securityHeaders.js`: `script-src 'self' 'nonce-<x>'` (sin `unsafe-inline`).

### Parte B — token en cookie `HttpOnly`
1. **Backend** (`routes/auth.js`): en login, además (o en vez) del JSON, setear
   `Set-Cookie: token=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`.
   En logout, limpiar la cookie.
2. **Middleware** (`middleware/auth.js`): leer el token de la cookie (además del header
   `Authorization` para compatibilidad, o migrar del todo). Parsear cookie (sin dependencia:
   leer `req.headers.cookie`, o usar `cookie-parser`).
3. **CSRF**: con cookie, agregar protección. Opción simple: `SameSite=Strict` +
   patrón "double-submit" (cookie no-HttpOnly con token CSRF que el front reenvía en un
   header `X-CSRF-Token`, y el backend compara). Aplica a todas las mutaciones admin.
4. **Frontend** (`admin/index.html`): sacar el token de `localStorage`; detectar sesión con
   un endpoint nuevo `GET /api/auth/me` (200 si la cookie es válida) en vez de leer el token;
   todas las llamadas `fetch` con `credentials:'include'` y sin header `Authorization`;
   adaptar `showApp()`, `logout()` y el helper `api()`.

## Cómo PROBAR localmente antes de desplegar (imprescindible)
```bash
npm install
JWT_SECRET=algo-largo-y-aleatorio node server.js   # http://localhost:3000
```
Con la app corriendo, verificar **en el navegador (consola abierta, mirando violaciones de CSP)**:
- [ ] Login en `/admin` funciona y NO hay errores de CSP en consola.
- [ ] Cada función del panel: citas (confirmar, resumen), facturas (emitir, reintentar,
      borrar), comprobantes (ver imagen y PDF), testimonios, servicios, promo, contenido,
      contacto, subir `.p12`, cambiar contraseña, seguimiento, enviar correo con adjunto.
- [ ] Logout limpia la sesión (no se puede volver sin re-login).
- [ ] Sitio público: flujo de cita completo (OTP → cita) sigue andando, sin errores de CSP.
- [ ] Verificar que el token ya NO está en `localStorage` (DevTools → Application → Local Storage).

Si algo se rompe, corregir ANTES de subir. No desplegar con violaciones de CSP pendientes.

## Al desplegar
- Los admin tendrán que **volver a iniciar sesión** (cambia el mecanismo de sesión).
- Recordar que en Railway debe estar `JWT_SECRET` (si no, la app aborta a propósito).
- Tras el deploy, repetir el checklist de arriba en producción.

## Nota
Cuando la #5 esté hecha y probada, **borrar este archivo** en el mismo commit.
