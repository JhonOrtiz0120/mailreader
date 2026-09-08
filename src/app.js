'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const invoicesRouter = require('./routes/invoices.routes');
const SchedulerService = require('./services/SchedulerService');
const ZipBufferService = require('./services/ZipBufferService');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middlewares ──────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Frontend estático ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ───────────────────────────────────────────────
app.use('/api', invoicesRouter);

// ── SPA Fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  // Solo para rutas no-API (sirve el index.html del frontend)
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ── Error handler global ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR GLOBAL]', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Error interno del servidor',
  });
});

// ── Auto-scheduler (si está configurado en .env) ─────────────
const autoSchedule = process.env.AUTO_SCHEDULE;
if (autoSchedule && autoSchedule !== 'false' && autoSchedule.trim() !== '') {
  try {
    SchedulerService.start(autoSchedule.trim());
    console.log(`[App] Scheduler automático iniciado: "${autoSchedule}"`);
  } catch (err) {
    console.error(`[App] Error iniciando AUTO_SCHEDULE "${autoSchedule}":`, err.message);
  }
}

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n[App] Apagando servidor...');
  SchedulerService.stop();
  ZipBufferService.destroy();
  process.exit(0);
}

// ── Arrancar servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🧾  SAFITE — Extractor de Facturas DIAN v1.0.0          ║
║                                                           ║
║   🌐  http://localhost:${PORT}                               ║
║   📡  API: http://localhost:${PORT}/api/health               ║
║                                                           ║
║   Proveedores: Microsoft Graph | Gmail API | IMAP-SSL     ║
║   Patrón:      Factory Design Pattern                     ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
