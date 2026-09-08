'use strict';

const express = require('express');
const router = express.Router();
const InvoiceController = require('../controllers/InvoiceController');

// ── Buzones ──────────────────────────────────────────────────
// GET /api/mailboxes — Lista los buzones configurados (sin credenciales)
router.get('/mailboxes', InvoiceController.getMailboxes);

// POST /api/mailboxes — Guarda la configuración de buzones
router.post('/mailboxes', InvoiceController.saveMailboxes);

// POST /api/mailboxes/reload — Recarga la configuración de buzones
router.post('/mailboxes/reload', InvoiceController.reloadMailboxes);

// ── Facturas ─────────────────────────────────────────────────
// GET /api/invoices — Retorna el último resultado de extracción
router.get('/invoices', InvoiceController.getLastInvoices);

// GET /api/invoices/history — Historial de sesiones recientes
router.get('/invoices/history', InvoiceController.getHistory);

// POST /api/extract — Dispara extracción manual
//   Body opcional: { limit, sinceDate, folder, mailboxIds }
router.post('/extract', InvoiceController.extract);

// ── Descarga de ZIPs ──────────────────────────────────────────
// GET /api/download/:token — Descarga el ZIP por su token (TTL: 30 min)
router.get('/download/:token', InvoiceController.downloadZip);

// ── Scheduler ─────────────────────────────────────────────────
// GET  /api/scheduler/status        — Estado del scheduler
// POST /api/scheduler/start         — Iniciar scheduler { cronExpression }
// POST /api/scheduler/stop          — Detener scheduler

router.get('/scheduler/status', InvoiceController.getSchedulerStatus);
router.post('/scheduler/start', InvoiceController.startScheduler);
router.post('/scheduler/stop', InvoiceController.stopScheduler);

// ── Sistema ───────────────────────────────────────────────────
// GET /api/health — Health check
router.get('/health', InvoiceController.health);

// GET /api/stats  — Estadísticas del sistema (memoria, buffers)
router.get('/stats', InvoiceController.getStats);

module.exports = router;
