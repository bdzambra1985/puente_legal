# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
## Wiki personal

Cuando termines cambios importantes en este proyecto, actualizá también /home/dzc/Escritorio/wiki/log.md y la página correspondiente en wiki/proyectos/, siguiendo las convenciones de wiki/CLAUDE.md.

## Architecture

Node.js + Express + SQLite application. The frontend fetches all content from `/api/content` on load and renders it dynamically. An admin panel at `/admin` allows editing all content via a browser-based UI.

```
puente_legal/
├── server.js          — Express app (static serving, route mounting, DB init)
├── database.js        — SQLite schema + seeding via better-sqlite3
├── middleware/auth.js — JWT Bearer token validation
├── routes/auth.js     — POST /api/auth/login, POST /api/auth/change-password
├── routes/api.js      — GET /api/content (public, no auth)
├── routes/admin.js    — CRUD for testimonios/servicios/contenido/contacto (JWT protected)
├── public/index.html  — Frontend (fetches /api/content, renders dynamically)
├── admin/index.html   — Admin panel (login screen + content dashboard)
├── img/               — Source images (served at /img via Express)
└── public/img/        — Images also accessible from public dir
```

## Running locally

```bash
npm install
node server.js          # starts on port 3000
# dev mode with auto-reload:
npx nodemon server.js
```

## Deployment

Railway via Docker. Push to GitHub → Railway auto-deploys.

```bash
git add -A
git commit -m "descripción del cambio"
git push origin main
```

Environment variables to set in Railway:
- `JWT_SECRET` — secret for signing JWTs (defaults to `puente-legal-jwt-2026` if not set)
- `DB_PATH` — path to SQLite file (defaults to `./data.db`)
- `PORT` — set automatically by Railway

## Default admin credentials

- Username: `admin`
- Password: `puentelegal2026`
- Change via `/admin` → Contraseña section after first login

## API routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/content` | Public | All content for frontend |
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/change-password` | JWT | Update password |
| GET/POST/PUT/DELETE | `/api/admin/testimonios` | JWT | Manage testimonials |
| GET/PUT | `/api/admin/servicios/:id` | JWT | Update services |
| GET/PUT | `/api/admin/contenido` | JWT | Hero, stats, FAQ text |
| GET/PUT | `/api/admin/contacto` | JWT | WhatsApp, email, coverage |

## Database tables

- `admin_users` — credentials (bcrypt hashed passwords)
- `testimonios` — reviews with `active` flag (only active ones served publicly)
- `servicios` — 6 fixed service cards with `tags` stored as JSON
- `contenido` — key/value store for hero text, stats, FAQ, banner
- `contacto` — key/value store for whatsapp, telefono, email, cobertura

## Design tokens

| Token | Value |
|-------|-------|
| `--navy` | `#0f1e38` |
| `--gold` | `#C9A227` |
| `--off` | `#f8f7f4` |
| `--muted` | `#64748b` |

Fonts: **Playfair Display** (headings) and **Inter** (body) from Google Fonts.
Breakpoints: `≤1024px` tablet, `≤640px` mobile.
