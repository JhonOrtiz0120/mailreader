/* ════════════════════════════════════════════════════════════
   SAFITE — Extractor de Facturas DIAN
   Frontend SPA Logic
   ════════════════════════════════════════════════════════════ */

'use strict';

// ── Estado de la aplicación ───────────────────────────────────
const state = {
  currentView: 'dashboard',
  invoices: [],          // Lista plana de todas las facturas (de todos los buzones)
  mailboxes: [],         // Configuración de buzones
  lastResult: null,      // Último resultado de extracción
  scheduler: null,       // Estado del scheduler
  isExtracting: false,
  filteredInvoices: [],
};

// ── Inicialización ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTheme();
  setupNavigation();
  await Promise.allSettled([
    loadMailboxes(),
    loadLastInvoices(),
    loadSchedulerStatus(),
  ]);
  startPolling();
});

// ── Tema Claro/Oscuro ─────────────────────────────────────────
function setupTheme() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const sun = document.getElementById('theme-icon-sun');
  const moon = document.getElementById('theme-icon-moon');
  if (sun && moon) {
    sun.style.display = theme === 'dark' ? 'block' : 'none';
    moon.style.display = theme === 'dark' ? 'none' : 'block';
  }
}

// ── Navegación SPA ────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) navigateTo(view);
    });
  });
}

function navigateTo(viewName) {
  state.currentView = viewName;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Update views
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === `view-${viewName}`);
  });

  // Update topbar
  const titles = {
    dashboard: ['Dashboard', 'Resumen del sistema'],
    invoices:  ['Facturas', 'Facturas electrónicas DIAN detectadas'],
    mailboxes: ['Buzones', 'Estado de los buzones de correo'],
    scheduler: ['Scheduler', 'Configuración de extracción automática'],
  };
  const [title, subtitle] = titles[viewName] || ['', ''];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent = subtitle;
}

// ── API Calls ─────────────────────────────────────────────────
const API = '/api';

async function apiFetch(path, options = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// ── Carga de datos ────────────────────────────────────────────

async function loadMailboxes() {
  const { ok, data } = await apiFetch('/mailboxes');
  if (ok && data.success) {
    state.mailboxes = data.data || [];
    renderMailboxes();
    updateStatMailboxes();
  }
}

async function loadLastInvoices() {
  const { ok, data } = await apiFetch('/invoices');
  if (ok && data.success && data.data) {
    processExtractionResult(data.data);
  }
}

async function loadSchedulerStatus() {
  const { ok, data } = await apiFetch('/scheduler/status');
  if (ok && data.success) {
    state.scheduler = data.data;
    renderSchedulerStatus();
  }
}

// ── Extracción ────────────────────────────────────────────────

async function triggerExtraction() {
  if (state.isExtracting) {
    showToast('info', 'En progreso', 'Ya hay una extracción en curso. Por favor espere.');
    return;
  }

  state.isExtracting = true;
  setExtractionUI(true);
  
  const daysBack = document.getElementById('days-back')?.value;
  let sinceDate;
  if (daysBack && !isNaN(daysBack) && parseInt(daysBack, 10) > 0) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(daysBack, 10));
    sinceDate = d.toISOString();
  }

  const { ok, status, data } = await apiFetch('/extract', { method: 'POST', body: JSON.stringify({ sinceDate }) });

  setExtractionUI(false);
  state.isExtracting = false;

  if (status === 202) {
    showToast('info', 'Ya en curso', data.error || 'Extracción ya iniciada.');
    return;
  }

  if (ok && data.success) {
    processExtractionResult(data.data);
    showToast('success', '¡Extracción completada!',
      `${data.data.summary.totalInvoicesFound} factura(s) encontrada(s) en ${data.data.summary.successfulMailboxes} buzón(es).`);
  } else {
    showToast('error', 'Error en extracción', data.error || 'Error desconocido. Revise la consola del servidor.');
  }
}

function setExtractionUI(loading) {
  const btn = document.getElementById('btn-extract');
  const text = document.getElementById('btn-extract-text');
  const progress = document.getElementById('progress-container');
  const dot = document.getElementById('system-status-dot');
  const statusText = document.getElementById('system-status-text');

  if (loading) {
    btn.classList.add('loading');
    text.innerHTML = '<span class="spinner"></span> Extrayendo...';
    progress.style.display = 'flex';
    dot.className = 'status-indicator running';
    statusText.textContent = 'Extrayendo...';
  } else {
    btn.classList.remove('loading');
    text.textContent = 'Extraer Ahora';
    progress.style.display = 'none';
    dot.className = 'status-indicator';
    statusText.textContent = 'Sistema listo';
  }
}

// ── Procesamiento de resultado ────────────────────────────────

function processExtractionResult(result) {
  state.lastResult = result;

  // Aplanar facturas de todos los buzones
  state.invoices = [];
  (result.mailboxes || []).forEach(mb => {
    (mb.invoices || []).forEach(inv => {
      state.invoices.push({ ...inv, _mailbox: mb });
    });
  });
  state.filteredInvoices = [...state.invoices];

  // Actualizar tiempo de sincronización
  document.getElementById('last-sync-time').textContent =
    formatRelativeTime(result.completedAt);

  // Actualizar stats
  updateDashboardStats(result);
  renderSessionSummary(result);

  // Actualizar tabla de facturas
  renderInvoicesTable();

  // Actualizar mailboxes con resultados
  updateMailboxesWithResults(result.mailboxes || []);
  renderMailboxes();

  // Badge de la nav
  const badge = document.getElementById('invoices-badge');
  if (state.invoices.length > 0) {
    badge.textContent = state.invoices.length;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  // Historial
  loadSchedulerStatus(); // Refrescar stats del scheduler
}

// ── Dashboard ─────────────────────────────────────────────────

function updateDashboardStats(result) {
  const empty = document.getElementById('dashboard-empty');
  const sessionCard = document.getElementById('session-card');

  if (result && result.summary) {
    empty.style.display = 'none';
    sessionCard.style.display = '';

    animateValue('stat-total-value', result.summary.totalInvoicesFound);
    animateValue('stat-success-value', result.summary.successfulMailboxes);
    animateValue('stat-errors-value', result.summary.failedMailboxes);
  }
}

function updateStatMailboxes() {
  const active = state.mailboxes.filter(m => m.active).length;
  animateValue('stat-mailboxes-value', active);
}

function renderSessionSummary(result) {
  const container = document.getElementById('session-mailboxes-summary');
  const sessionIdEl = document.getElementById('session-id');
  const durationEl = document.getElementById('session-duration');

  sessionIdEl.textContent = result.sessionId?.substring(0, 8) || '';
  durationEl.textContent = result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '';

  container.innerHTML = (result.mailboxes || []).map(mb => `
    <div class="timeline-item ${mb.status}">
      <span class="timeline-provider ${mb.provider}">${mb.provider}</span>
      <span class="timeline-email" title="${mb.email}">${mb.label || mb.email}</span>
      ${mb.status === 'success'
        ? `<span class="timeline-count">${mb.invoicesFound} factura(s)</span>`
        : `<span class="timeline-error" title="${mb.error}">${truncate(mb.error, 40)}</span>`
      }
    </div>
  `).join('');
}

// ── Tabla de Facturas ─────────────────────────────────────────

function renderInvoicesTable() {
  const tbody = document.getElementById('invoices-tbody');
  const empty = document.getElementById('invoices-empty');
  const countEl = document.getElementById('invoice-count');

  const invoices = state.filteredInvoices;
  countEl.textContent = `${invoices.length} factura(s)`;

  if (invoices.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';

  tbody.innerHTML = invoices.map(inv => {
    const tipoClass = `tipo-${inv.tipoDoc || 'xx'}`;
    const dateStr = formatDate(inv.receivedDate);
    const attachments = inv.attachments || [];

    return `
      <tr>
        <td class="mono-text">${escHtml(inv.nit || '—')}</td>
        <td class="td-company" title="${escHtml(inv.nombre || '')}">
          ${escHtml(inv.nombre || '—')}
        </td>
        <td class="td-factura">${escHtml(inv.factura || '—')}</td>
        <td>
          <span class="tipo-badge ${tipoClass}" title="${escHtml(inv.tipoDocDescripcion || '')}">
            ${escHtml(inv.tipoDoc || '—')} · ${escHtml(inv.tipoDocDescripcion?.split(' ').slice(0,2).join(' ') || '')}
          </span>
        </td>
        <td class="mono-text">${escHtml(inv.adquirente || '—')}</td>
        <td>
          <span class="mailbox-chip" title="${escHtml(inv._mailbox?.label || '')}">
            ${providerIcon(inv._mailbox?.provider)} ${escHtml(inv._mailbox?.email || inv._mailbox?.label || '—')}
          </span>
        </td>
        <td class="td-date">${dateStr}</td>
        <td>
          ${attachments.length === 0 ? '<span style="color:var(--text-muted)">Sin ZIP</span>' : ''}
          ${attachments.map(att => `
            <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:2px;">
              ${escHtml(att.filename)} (${formatSize(att.size)})
            </div>
          `).join('')}
        </td>
        <td class="td-actions">
          ${attachments.map(att => `
            <button class="btn-download" onclick="downloadZip('${att.downloadToken}', '${escHtml(att.filename)}')"
              title="Descargar ${escHtml(att.filename)}">
              ⬇ ZIP
            </button>
          `).join(' ')}
          ${attachments.length === 0 ? '<span style="color:var(--text-muted);font-size:0.7rem">—</span>' : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function filterInvoices() {
  const search = document.getElementById('invoice-search').value.toLowerCase().trim();
  const providerFilter = document.getElementById('filter-provider').value;
  const tipoFilter = document.getElementById('filter-tipodoc').value;

  state.filteredInvoices = state.invoices.filter(inv => {
    const matchSearch = !search || [
      inv.nit, inv.nombre, inv.factura, inv.adquirente,
      inv._mailbox?.label, inv._mailbox?.email,
    ].some(v => (v || '').toLowerCase().includes(search));

    const matchProvider = !providerFilter || inv._mailbox?.provider === providerFilter;
    const matchTipo = !tipoFilter || inv.tipoDoc === tipoFilter;

    return matchSearch && matchProvider && matchTipo;
  });

  renderInvoicesTable();
}

// ── Descarga de ZIP ───────────────────────────────────────────

async function downloadZip(token, filename) {
  try {
    const res = await fetch(`${API}/download/${token}`);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast('error', 'No disponible', data.error || 'El archivo expiró (TTL: 30 min). Extraiga nuevamente.');
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'factura.zip';
    a.click();
    URL.revokeObjectURL(url);

    showToast('success', 'Descarga iniciada', `${filename} descargado correctamente.`);
  } catch (err) {
    showToast('error', 'Error de descarga', err.message);
  }
}

// ── Buzones ───────────────────────────────────────────────────

function toggleMailboxEditor() {
  const grid = document.getElementById('mailboxes-grid');
  const empty = document.getElementById('mailboxes-empty');
  const editor = document.getElementById('mailboxes-editor-container');
  const isEditing = editor.style.display !== 'none';
  
  if (isEditing) {
    editor.style.display = 'none';
    grid.style.display = '';
    renderMailboxes(); // Show grid again
  } else {
    // Start editing
    grid.style.display = 'none';
    empty.style.display = 'none';
    editor.style.display = 'flex';
    
    // Quitar campos internos temporales como _result para que no se guarden
    const cleanMailboxes = state.mailboxes.map(mb => {
      const copy = { ...mb };
      delete copy._result;
      return copy;
    });
    document.getElementById('mailboxes-json-input').value = JSON.stringify(cleanMailboxes, null, 2);
  }
}

async function saveMailboxes() {
  const input = document.getElementById('mailboxes-json-input').value;
  let parsed = [];
  try {
    parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) throw new Error('Debe ser un arreglo de buzones.');
  } catch (e) {
    showToast('error', 'JSON Inválido', e.message);
    return;
  }
  
  const { ok, data } = await apiFetch('/mailboxes', {
    method: 'POST',
    body: JSON.stringify({ mailboxes: parsed })
  });
  
  if (ok && data.success) {
    showToast('success', 'Configuración guardada', data.message);
    toggleMailboxEditor();
    await loadMailboxes();
  } else {
    showToast('error', 'Error al guardar', data.error || 'Error desconocido');
  }
}

async function clearMailboxes() {
  if (!confirm('¿Está seguro de que desea eliminar todos los buzones configurados?')) return;
  const { ok, data } = await apiFetch('/mailboxes', {
    method: 'POST',
    body: JSON.stringify({ mailboxes: [] })
  });
  
  if (ok && data.success) {
    showToast('info', 'Buzones limpiados', 'Se ha borrado toda la configuración de buzones.');
    await loadMailboxes();
  }
}

async function deleteMailbox(id) {
  if (!confirm('¿Está seguro de que desea eliminar este buzón?')) return;
  
  const updatedMailboxes = state.mailboxes
    .filter(mb => mb.id !== id)
    .map(mb => {
      const copy = { ...mb };
      delete copy._result;
      return copy;
    });
  
  const { ok, data } = await apiFetch('/mailboxes', {
    method: 'POST',
    body: JSON.stringify({ mailboxes: updatedMailboxes })
  });
  
  if (ok && data.success) {
    showToast('success', 'Buzón eliminado', 'El buzón ha sido borrado exitosamente.');
    await loadMailboxes();
  } else {
    showToast('error', 'Error al eliminar', data.error || 'Error desconocido');
  }
}

function updateMailboxesWithResults(resultMailboxes) {
  // Enriquecer los buzones configurados con el resultado de la última extracción
  const resultMap = new Map(resultMailboxes.map(mb => [mb.mailboxId, mb]));

  state.mailboxes = state.mailboxes.map(mb => ({
    ...mb,
    _result: resultMap.get(mb.id) || null,
  }));
}

function renderMailboxes() {
  const grid = document.getElementById('mailboxes-grid');
  const empty = document.getElementById('mailboxes-empty');

  if (!state.mailboxes.length) {
    grid.innerHTML = '';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';

  grid.innerHTML = state.mailboxes.map(mb => {
    const result = mb._result;
    let statusHtml = '';

    if (!mb.active) {
      statusHtml = `<span class="mailbox-status-pill status-pill--inactive">⏸ Inactivo</span>`;
    } else if (result) {
      if (result.status === 'success') {
        statusHtml = `<span class="mailbox-status-pill status-pill--success">✓ OK</span>`;
      } else {
        statusHtml = `<span class="mailbox-status-pill status-pill--error" title="${escHtml(result.error || '')}">✗ Error</span>`;
      }
    } else {
      statusHtml = `<span class="mailbox-status-pill status-pill--active">• Activo</span>`;
    }

    const invoiceCount = result?.invoicesFound ?? '—';
    const errorMsg = result?.error ? `<div style="font-size:0.72rem;color:var(--danger);margin-top:8px;">${truncate(result.error, 80)}</div>` : '';

    return `
      <div class="mailbox-card">
        <div class="mailbox-card-header">
          <div class="mailbox-provider-icon provider-${mb.provider}">
            ${providerEmoji(mb.provider)}
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${statusHtml}
            <button class="btn-ghost" onclick="deleteMailbox('${mb.id}')" title="Eliminar buzón" style="padding: 0; background: transparent; border: none; color: var(--danger); cursor: pointer; font-size: 1.1rem; line-height: 1;">
              ×
            </button>
          </div>
        </div>
        <div class="mailbox-label">${escHtml(mb.label || mb.email)}</div>
        <div class="mailbox-email">${escHtml(mb.email)}</div>
        ${errorMsg}
        <div class="mailbox-stats">
          <div class="mailbox-stat">
            <div class="mailbox-stat-value">${invoiceCount}</div>
            <div class="mailbox-stat-label">Facturas</div>
          </div>
          <div class="mailbox-stat">
            <div class="mailbox-stat-value" style="text-transform:capitalize">${mb.provider}</div>
            <div class="mailbox-stat-label">Proveedor</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Scheduler ─────────────────────────────────────────────────

async function startScheduler() {
  const cronExpression = document.getElementById('cron-input').value.trim();

  if (!cronExpression) {
    showToast('error', 'Falta expresión', 'Ingrese una expresión cron válida.');
    return;
  }

  const { ok, data } = await apiFetch('/scheduler/start', {
    method: 'POST',
    body: JSON.stringify({ cronExpression }),
  });

  if (ok && data.success) {
    state.scheduler = data.data;
    renderSchedulerStatus();
    showToast('success', 'Scheduler iniciado', `Ejecución automática: ${cronExpression}`);
  } else {
    showToast('error', 'Error al iniciar', data.error || 'Verifique la expresión cron.');
  }
}

async function stopScheduler() {
  const { ok, data } = await apiFetch('/scheduler/stop', { method: 'POST' });

  if (ok && data.success) {
    state.scheduler = data.data;
    renderSchedulerStatus();
    showToast('info', 'Scheduler detenido', 'La extracción automática fue deshabilitada.');
  }
}

function setCron(expr) {
  document.getElementById('cron-input').value = expr;
}

function renderSchedulerStatus() {
  const sched = state.scheduler;
  if (!sched) return;

  const statusBadge = document.getElementById('sched-status-badge');
  const dot = statusBadge.querySelector('.status-dot');
  const text = document.getElementById('sched-status-text');
  const cronDisplay = document.getElementById('sched-cron-display');
  const startBtn = document.getElementById('btn-start-scheduler');
  const stopBtn = document.getElementById('btn-stop-scheduler');
  const navDot = document.getElementById('scheduler-dot');

  if (sched.enabled) {
    dot.className = 'status-dot active';
    text.textContent = 'Activo';
    cronDisplay.textContent = sched.schedule || '';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    navDot.style.display = '';
  } else {
    dot.className = 'status-dot';
    text.textContent = 'Inactivo';
    cronDisplay.textContent = '';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    navDot.style.display = 'none';
  }

  document.getElementById('sched-last-run').textContent =
    sched.lastRun ? formatRelativeTime(sched.lastRun) : '—';
  document.getElementById('sched-run-count').textContent = sched.runCount ?? 0;
  document.getElementById('sched-timezone').textContent = sched.timezone || 'America/Bogota';
  document.getElementById('sched-last-error').textContent = sched.lastError || 'Ninguno';
}

// ── Historial ─────────────────────────────────────────────────

async function renderHistory() {
  const { ok, data } = await apiFetch('/invoices/history');
  if (!ok || !data.success) return;

  const list = document.getElementById('history-list');
  const history = data.data || [];

  if (!history.length) {
    list.innerHTML = '<p class="empty-history">Sin historial aún.</p>';
    return;
  }

  list.innerHTML = history.map(h => `
    <div class="history-item">
      <span class="history-item-time">${formatRelativeTime(h.startedAt)}</span>
      <span class="history-item-success">✓ ${h.successCount}/${h.totalMailboxes || '?'} buzones</span>
      <span class="history-item-count">${h.totalInvoices} factura(s)</span>
    </div>
  `).join('');
}

// ── Polling ───────────────────────────────────────────────────

function startPolling() {
  // Refrescar datos cada 60 segundos
  setInterval(async () => {
    await loadSchedulerStatus();
    // Si el scheduler está activo, refrescar facturas también
    if (state.scheduler?.enabled) {
      await loadLastInvoices();
    }
    renderHistory();
  }, 60_000);
}

// ── Toast ─────────────────────────────────────────────────────

function showToast(type, title, message, durationMs = 5000) {
  const icons = { success: '✓', error: '✗', info: 'ℹ', warning: '⚠' };
  const container = document.getElementById('toast-container');

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || 'ℹ'}</div>
    <div class="toast-body">
      <div class="toast-title">${escHtml(title)}</div>
      ${message ? `<div class="toast-msg">${escHtml(message)}</div>` : ''}
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ── Helpers ───────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  } catch { return dateStr; }
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '—';
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60)  return 'hace unos segundos';
    const m = Math.floor(s / 60);
    if (m < 60)  return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} día(s)`;
  } catch { return dateStr; }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length <= maxLen ? str : str.substring(0, maxLen) + '…';
}

function providerIcon(provider) {
  const icons = { microsoft: '🔵', google: '🔴', imap: '🟣' };
  return icons[provider] || '📧';
}

function providerEmoji(provider) {
  const icons = { microsoft: '🔵', google: '🔴', imap: '🟣' };
  return icons[provider] || '📧';
}

function animateValue(elId, target, duration = 600) {
  const el = document.getElementById(elId);
  if (!el) return;
  const start = 0;
  const startTime = performance.now();

  function update(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * ease);
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}
