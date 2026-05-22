/**
 * ═══════════════════════════════════════════════════════════════
 *  SILOTRACK · app.js
 *  Sistema de Control de Acondicionamiento de Trigo
 *  100% localStorage · Sin frameworks · Sin datos predeterminados
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────
   CONSTANTES DE CONFIGURACIÓN
───────────────────────────────────────── */
const CONFIG = {
  STORAGE_KEY:        'silotrack_registros_v1',
  UPDATE_INTERVAL_MS: 60_000,          // 1 minuto
  HOURS_READY:        24,              // horas para "listo para molienda"
  HOURS_PLUS24:       24,              // exactamente 24h → acondicionado+24
  HOURS_EXPIRED:      36,              // horas para "vencido"
};

/* ─────────────────────────────────────────
   ESTADO DE LA APLICACIÓN
───────────────────────────────────────── */
let state = {
  registros:   [],    // Array de objetos de registro
  filtrados:   [],    // Copia filtrada para la tabla
  updateTimer: null,  // Referencia al setInterval
};

/* ─────────────────────────────────────────
   MODELO DE UN REGISTRO
   {
     id:          string (timestamp + random)
     fecha:       string "YYYY-MM-DD"
     codigo:      string
     tipo:        string
     cantidad:    number  (kg inicial)
     turno:       string
     operador:    string
     horaInicio:  string (ISO datetime-local)
     horaFin:     string|null
     consumo:     number  (kg)
     creadoEn:    number  (timestamp)
   }
───────────────────────────────────────── */

/* ═══════════════════════════════════════
   INICIALIZACIÓN
═══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  cargarDesdeStorage();
  iniciarReloj();
  iniciarActualizador();
  renderAll();
  setFechaHoyDefault();
  attachFormListeners();
});

/* ─────────────────────────────────────────
   PERSISTENCIA · localStorage
───────────────────────────────────────── */

/** Guarda el array completo de registros en localStorage */
function guardarEnStorage() {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state.registros));
  } catch (e) {
    showToast('Error al guardar en localStorage: ' + e.message, 'error');
  }
}

/** Carga los registros desde localStorage al iniciar */
function cargarDesdeStorage() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    state.registros = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.registros = [];
    showToast('Error al leer datos guardados', 'error');
  }
}

/* ═══════════════════════════════════════
   LÓGICA DE CÁLCULOS
═══════════════════════════════════════ */

/**
 * Calcula los campos derivados de un registro dado el momento actual.
 * Retorna un objeto con: horasAcondicionadas, tiempoRestante,
 * diferencia, stockActual, estado, progreso (0-100), colorClass
 */
function calcularCampos(reg, ahora = Date.now()) {
  const inicio  = new Date(reg.horaInicio).getTime();
  const fin     = reg.horaFin ? new Date(reg.horaFin).getTime() : ahora;
  const consumo = Number(reg.consumo) || 0;
  const cantidad = Number(reg.cantidad) || 0;

  // Horas acondicionadas (desde inicio hasta fin o ahora)
  const msAcond      = fin - inicio;
  const horasAcond   = Math.max(0, msAcond / 3_600_000);

  // Tiempo restante para 24 horas
  const msRestante    = Math.max(0, inicio + CONFIG.HOURS_READY * 3_600_000 - ahora);
  const horasRestante = msRestante / 3_600_000;

  // Diferencia entre cantidad inicial y consumo
  const diferencia   = cantidad - consumo;

  // Stock actual (cantidad - consumo, mínimo 0)
  const stockActual  = Math.max(0, diferencia);

  // Estado
  const estado = calcularEstado(horasAcond, inicio, ahora, reg.horaFin);

  // Progreso visual: 0–100 dentro del rango 0–36h
  const progreso = Math.min(100, (horasAcond / CONFIG.HOURS_EXPIRED) * 100);

  // Color de barra según estado
  let colorClass = 'yellow';
  if (estado === 'Pendiente')              colorClass = 'grey';
  if (estado === 'En acondicionamiento')   colorClass = 'yellow';
  if (estado === 'Acondicionado +24h')     colorClass = 'orange';
  if (estado === 'Listo para molienda')    colorClass = 'green';
  if (estado === 'Vencido')               colorClass = 'red';

  return {
    horasAcond:      horasAcond,
    horasRestante:   horasRestante,
    diferencia:      diferencia,
    stockActual:     stockActual,
    estado:          estado,
    progreso:        progreso,
    colorClass:      colorClass,
  };
}

/**
 * Reglas de estado:
 * Sin inicio definido (no debería ocurrir) → Pendiente
 * horaFin definida Y horasAcond < 24 → En acondicionamiento
 * horasAcond == 24 exacto (±5 min) → Listo para molienda
 * horasAcond > 36 → Vencido
 * 24 < horasAcond <= 36 → Acondicionado +24h
 * horasAcond < 24 → En acondicionamiento
 */
function calcularEstado(horasAcond, inicioTs, ahoraTs, horaFin) {
  if (!inicioTs) return 'Pendiente';

  // Si no ha arrancado aún (inicio en el futuro)
  if (inicioTs > ahoraTs) return 'Pendiente';

  if (horasAcond > CONFIG.HOURS_EXPIRED) return 'Vencido';
  if (horasAcond >= CONFIG.HOURS_READY && horasAcond <= CONFIG.HOURS_EXPIRED) {
    // Exactamente 24 h (ventana de ±15 min)
    if (horasAcond >= CONFIG.HOURS_READY && horasAcond < CONFIG.HOURS_READY + 0.5) {
      return 'Listo para molienda';
    }
    return 'Acondicionado +24h';
  }
  return 'En acondicionamiento';
}

/** Formatea horas decimales a "Xh Ym" */
function formatHoras(h) {
  const horas  = Math.floor(h);
  const mins   = Math.round((h - horas) * 60);
  return `${horas}h ${mins.toString().padStart(2, '0')}m`;
}

/** Clase CSS del badge según estado */
function badgeClass(estado) {
  const map = {
    'Pendiente':            'badge-pending',
    'En acondicionamiento': 'badge-process',
    'Acondicionado +24h':   'badge-plus24',
    'Listo para molienda':  'badge-ready',
    'Vencido':              'badge-expired',
  };
  return map[estado] || 'badge-pending';
}

/* ═══════════════════════════════════════
   RENDER COMPLETO
═══════════════════════════════════════ */

/** Actualiza todos los componentes visuales */
function renderAll() {
  renderKPIs();
  renderActiveLots();
  renderQuickTable();
  renderDataTable();
  renderAlerts();
  updateAlertBadge();
  actualizarTimestamp();
}

/* ─── KPIs ─── */
function renderKPIs() {
  const ahora = Date.now();
  let total = 0, enProceso = 0, listos = 0, vencidos = 0;
  let stockTotal = 0, consumoTotal = 0;

  state.registros.forEach(reg => {
    total++;
    const c = calcularCampos(reg, ahora);
    if (c.estado === 'En acondicionamiento') enProceso++;
    if (c.estado === 'Listo para molienda' || c.estado === 'Acondicionado +24h') listos++;
    if (c.estado === 'Vencido') vencidos++;
    stockTotal   += c.stockActual;
    consumoTotal += Number(reg.consumo) || 0;
  });

  setText('kpiTotal',    total);
  setText('kpiProcess',  enProceso);
  setText('kpiReady',    listos);
  setText('kpiExpired',  vencidos);
  setText('kpiStock',    formatKg(stockTotal));
  setText('kpiConsumed', formatKg(consumoTotal));
}

/* ─── Lotes activos (cards) ─── */
function renderActiveLots() {
  const container = document.getElementById('activeLots');
  const ahora     = Date.now();
  const activos   = state.registros.filter(r => {
    const c = calcularCampos(r, ahora);
    return c.estado !== 'Vencido' && c.estado !== 'Pendiente';
  });

  if (activos.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">◫</div>
        <div class="empty-title">Sin lotes activos</div>
        <div class="empty-sub">Registre un nuevo lote para comenzar el monitoreo</div>
      </div>`;
    return;
  }

  container.innerHTML = activos.map(reg => {
    const c = calcularCampos(reg, ahora);
    return `
      <div class="lot-card">
        <div class="lot-card-header">
          <div>
            <div class="lot-code">${escHtml(reg.codigo)}</div>
            <div class="lot-type">${escHtml(reg.tipo)}</div>
          </div>
          <span class="badge ${badgeClass(c.estado)}">${escHtml(c.estado)}</span>
        </div>
        <div class="lot-card-body">
          <div class="lot-time-row">
            <span class="lot-hours">${formatHoras(c.horasAcond)}</span>
            <span class="lot-hours-label">ACONDICIONADO</span>
          </div>
          <div class="progress-wrap">
            <div class="progress-bar ${c.colorClass}"
                 style="width:${c.progreso.toFixed(1)}%"></div>
          </div>
          <div class="lot-meta">
            <span>Restante: ${c.horasRestante > 0 ? formatHoras(c.horasRestante) : '—'}</span>
            <span>${c.progreso.toFixed(0)}% / 36h</span>
          </div>
        </div>
        <div class="lot-card-footer">
          <span class="td-mono" style="font-size:10px;color:#8fa0b3;">
            ${escHtml(reg.operador)} · ${escHtml(reg.turno.split(' ')[0])}
          </span>
          <span class="td-mono" style="font-size:10px;color:#8fa0b3;">
            Stock: ${formatKg(c.stockActual)}
          </span>
        </div>
      </div>`;
  }).join('');
}

/* ─── Tabla rápida (dashboard últimos 5) ─── */
function renderQuickTable() {
  const body  = document.getElementById('quickTableBody');
  const ahora = Date.now();
  const ultimos = [...state.registros]
    .sort((a, b) => b.creadoEn - a.creadoEn)
    .slice(0, 5);

  if (ultimos.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="td-empty">Sin registros</td></tr>`;
    return;
  }

  body.innerHTML = ultimos.map(reg => {
    const c = calcularCampos(reg, ahora);
    const progPct = c.progreso.toFixed(0);
    return `
      <tr>
        <td class="td-mono">${escHtml(reg.codigo)}</td>
        <td>${escHtml(reg.tipo)}</td>
        <td class="td-mono">${formatDatetime(reg.horaInicio)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;height:5px;background:#e8ecf0;border-radius:3px;overflow:hidden;">
              <div style="width:${progPct}%;height:100%;background:var(--c-${c.colorClass === 'grey' ? 'grey' : c.colorClass});border-radius:3px;"></div>
            </div>
            <span class="td-mono" style="font-size:10px;color:#8fa0b3;">${progPct}%</span>
          </div>
        </td>
        <td><span class="badge ${badgeClass(c.estado)}">${escHtml(c.estado)}</span></td>
      </tr>`;
  }).join('');
}

/* ─── Tabla de datos completa ─── */
function renderDataTable() {
  const body  = document.getElementById('tableBody');
  const count = document.getElementById('tableCount');
  const ahora = Date.now();

  count.textContent = `${state.filtrados.length} registro${state.filtrados.length !== 1 ? 's' : ''}`;

  if (state.filtrados.length === 0) {
    body.innerHTML = `<tr><td colspan="15" class="td-empty">Sin registros que coincidan con los filtros</td></tr>`;
    return;
  }

  body.innerHTML = state.filtrados.map(reg => {
    const c = calcularCampos(reg, ahora);
    const rowClass = c.estado === 'Vencido' ? 'row-expired'
                   : c.estado === 'Listo para molienda' ? 'row-ready' : '';
    const difStyle = c.diferencia < 0 ? 'color:var(--c-red)' : '';
    return `
      <tr class="${rowClass}">
        <td class="td-mono">${escHtml(reg.fecha)}</td>
        <td class="td-mono" style="font-weight:600;">${escHtml(reg.codigo)}</td>
        <td>${escHtml(reg.tipo)}</td>
        <td class="td-mono">${formatKg(reg.cantidad)}</td>
        <td style="font-size:11px;">${escHtml(reg.turno)}</td>
        <td>${escHtml(reg.operador)}</td>
        <td class="td-mono">${formatDatetime(reg.horaInicio)}</td>
        <td class="td-mono">${reg.horaFin ? formatDatetime(reg.horaFin) : '—'}</td>
        <td class="td-mono" style="font-weight:600;">${formatHoras(c.horasAcond)}</td>
        <td class="td-mono">${c.horasRestante > 0 ? formatHoras(c.horasRestante) : '—'}</td>
        <td class="td-mono">${formatKg(reg.consumo)}</td>
        <td class="td-mono" style="${difStyle}">${formatKg(c.diferencia)}</td>
        <td class="td-mono" style="font-weight:600;">${formatKg(c.stockActual)}</td>
        <td><span class="badge ${badgeClass(c.estado)}">${escHtml(c.estado)}</span></td>
        <td>
          <button class="btn-icon edit" title="Editar" onclick="editarRegistro('${reg.id}')">✎</button>
          <button class="btn-icon del"  title="Eliminar" onclick="confirmarEliminar('${reg.id}')">✕</button>
        </td>
      </tr>`;
  }).join('');
}

/* ─── Panel de alertas ─── */
function renderAlerts() {
  const container = document.getElementById('alertsContainer');
  const ahora     = Date.now();
  const alertas   = [];

  state.registros.forEach(reg => {
    const c = calcularCampos(reg, ahora);
    if (c.estado === 'Vencido') {
      alertas.push({
        nivel: 'red',
        icon:  '⛔',
        titulo: `LOTE VENCIDO: ${reg.codigo}`,
        cuerpo: `El lote de ${reg.tipo} ha superado las 36 horas de acondicionamiento.
                 Operador: ${reg.operador} · Turno: ${reg.turno}`,
        tiempo: `Inicio: ${formatDatetime(reg.horaInicio)} · ${formatHoras(c.horasAcond)} acondicionado`,
      });
    } else if (c.estado === 'Acondicionado +24h') {
      alertas.push({
        nivel: 'orange',
        icon:  '⚠',
        titulo: `SUPERA 24H: ${reg.codigo}`,
        cuerpo: `El lote de ${reg.tipo} ha superado las 24 horas.
                 Evaluación requerida antes de las 36h.`,
        tiempo: `${formatHoras(c.horasAcond)} acondicionado · Restante para vencer: ${formatHoras(Math.max(0, CONFIG.HOURS_EXPIRED - c.horasAcond))}`,
      });
    } else if (c.estado === 'Listo para molienda') {
      alertas.push({
        nivel: 'yellow',
        icon:  '✅',
        titulo: `LISTO PARA MOLIENDA: ${reg.codigo}`,
        cuerpo: `El lote de ${reg.tipo} ha alcanzado las 24 horas de acondicionamiento.`,
        tiempo: `${formatHoras(c.horasAcond)} acondicionado · Iniciar proceso de molienda`,
      });
    }
  });

  if (alertas.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✓</div>
        <div class="empty-title">Sin alertas activas</div>
        <div class="empty-sub">Todos los lotes están en estado normal</div>
      </div>`;
    return;
  }

  container.innerHTML = alertas.map(a => `
    <div class="alert-card alert-${a.nivel}">
      <div class="alert-icon">${a.icon}</div>
      <div>
        <div class="alert-title">${escHtml(a.titulo)}</div>
        <div class="alert-body">${escHtml(a.cuerpo)}</div>
        <div class="alert-time">${escHtml(a.tiempo)}</div>
      </div>
    </div>`).join('');
}

/** Actualiza el badge de alertas en el sidebar */
function updateAlertBadge() {
  const ahora   = Date.now();
  const count   = state.registros.filter(reg => {
    const c = calcularCampos(reg, ahora);
    return ['Vencido', 'Acondicionado +24h', 'Listo para molienda'].includes(c.estado);
  }).length;

  const badge = document.getElementById('alertBadge');
  badge.textContent = count > 0 ? count : '';
}

/* ═══════════════════════════════════════
   CRUD
═══════════════════════════════════════ */

/** Maneja el submit del formulario (crear o editar) */
function handleFormSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('editId').value;

  // Validación básica adicional
  const horaInicio = document.getElementById('fHoraInicio').value;
  const horaFin    = document.getElementById('fHoraFin').value;
  if (horaFin && horaFin <= horaInicio) {
    showToast('La hora fin debe ser posterior a la hora inicio', 'error');
    return;
  }

  const registro = {
    id:         id || generarId(),
    fecha:      document.getElementById('fFecha').value,
    codigo:     document.getElementById('fCodigo').value.trim().toUpperCase(),
    tipo:       document.getElementById('fTipo').value,
    cantidad:   Number(document.getElementById('fCantidad').value) || 0,
    turno:      document.getElementById('fTurno').value,
    operador:   document.getElementById('fOperador').value.trim(),
    horaInicio: horaInicio,
    horaFin:    horaFin || null,
    consumo:    Number(document.getElementById('fConsumo').value) || 0,
    creadoEn:   id ? (state.registros.find(r => r.id === id)?.creadoEn || Date.now()) : Date.now(),
  };

  if (id) {
    // ACTUALIZAR
    const idx = state.registros.findIndex(r => r.id === id);
    if (idx !== -1) state.registros[idx] = registro;
    showToast(`Registro ${registro.codigo} actualizado`, 'success');
  } else {
    // CREAR
    state.registros.push(registro);
    showToast(`Registro ${registro.codigo} guardado`, 'success');
  }

  guardarEnStorage();
  applyFilters();
  renderAll();
  resetForm();
  switchSection('dashboard');
}

/** Carga un registro en el formulario para edición */
function editarRegistro(id) {
  const reg = state.registros.find(r => r.id === id);
  if (!reg) return;

  document.getElementById('editId').value        = reg.id;
  document.getElementById('fFecha').value        = reg.fecha;
  document.getElementById('fCodigo').value       = reg.codigo;
  document.getElementById('fTipo').value         = reg.tipo;
  document.getElementById('fCantidad').value     = reg.cantidad;
  document.getElementById('fTurno').value        = reg.turno;
  document.getElementById('fOperador').value     = reg.operador;
  document.getElementById('fHoraInicio').value   = reg.horaInicio;
  document.getElementById('fHoraFin').value      = reg.horaFin || '';
  document.getElementById('fConsumo').value      = reg.consumo || '';

  document.getElementById('submitBtn').innerHTML = '<span>✎</span> Actualizar Registro';
  switchSection('registro');
  actualizarPreviewCalculo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Confirma y elimina un registro individual */
function confirmarEliminar(id) {
  const reg = state.registros.find(r => r.id === id);
  if (!reg) return;
  openModal({
    icon: '⚠',
    title: 'Eliminar Registro',
    body: `¿Eliminar el lote <strong>${escHtml(reg.codigo)}</strong>?<br>Esta acción no se puede deshacer.`,
    onConfirm: () => {
      eliminarRegistro(id);
      closeModal();
    }
  });
}

/** Elimina un registro del array y guarda */
function eliminarRegistro(id) {
  state.registros = state.registros.filter(r => r.id !== id);
  guardarEnStorage();
  applyFilters();
  renderAll();
  showToast('Registro eliminado', 'info');
}

/** Muestra confirmación para borrar todos los registros */
function confirmClearAll() {
  if (state.registros.length === 0) {
    showToast('No hay registros que eliminar', 'info');
    return;
  }
  openModal({
    icon: '⛔',
    title: 'Limpiar Todos los Registros',
    body: `¿Está seguro de que desea eliminar <strong>todos los ${state.registros.length} registros</strong>?<br>Esta acción no se puede deshacer.`,
    onConfirm: () => {
      state.registros = [];
      guardarEnStorage();
      applyFilters();
      renderAll();
      closeModal();
      showToast('Todos los registros eliminados', 'warning');
    }
  });
}

/* ═══════════════════════════════════════
   FILTROS
═══════════════════════════════════════ */

/** Aplica los filtros activos y actualiza state.filtrados */
function applyFilters() {
  const desde  = document.getElementById('filtFechaDesde').value;
  const hasta  = document.getElementById('filtFechaHasta').value;
  const tipo   = document.getElementById('filtTipo').value;
  const turno  = document.getElementById('filtTurno').value;
  const estado = document.getElementById('filtEstado').value;
  const ahora  = Date.now();

  state.filtrados = state.registros.filter(reg => {
    if (desde  && reg.fecha < desde) return false;
    if (hasta  && reg.fecha > hasta) return false;
    if (tipo   && reg.tipo !== tipo) return false;
    if (turno  && reg.turno !== turno) return false;
    if (estado) {
      const c = calcularCampos(reg, ahora);
      if (c.estado !== estado) return false;
    }
    return true;
  });

  // Orden: más reciente primero
  state.filtrados.sort((a, b) => b.creadoEn - a.creadoEn);
  renderDataTable();
}

/** Limpia todos los filtros */
function clearFilters() {
  document.getElementById('filtFechaDesde').value = '';
  document.getElementById('filtFechaHasta').value = '';
  document.getElementById('filtTipo').value    = '';
  document.getElementById('filtTurno').value   = '';
  document.getElementById('filtEstado').value  = '';
  applyFilters();
}

/* ═══════════════════════════════════════
   EXPORTACIÓN EXCEL (CSV)
═══════════════════════════════════════ */

/** Exporta los registros filtrados a CSV descargable */
function exportToExcel() {
  const ahora = Date.now();

  if (state.filtrados.length === 0) {
    showToast('No hay registros para exportar', 'warning');
    return;
  }

  const headers = [
    'Fecha', 'Código', 'Tipo de Trigo', 'Cantidad Inicial (kg)',
    'Turno', 'Operador', 'Hora Inicio', 'Hora Fin',
    'Horas Acondicionadas', 'Tiempo Restante', 'Consumo (kg)',
    'Diferencia (kg)', 'Stock Actual (kg)', 'Estado'
  ];

  const rows = state.filtrados.map(reg => {
    const c = calcularCampos(reg, ahora);
    return [
      reg.fecha,
      reg.codigo,
      reg.tipo,
      reg.cantidad,
      reg.turno,
      reg.operador,
      reg.horaInicio,
      reg.horaFin || '',
      formatHoras(c.horasAcond),
      c.horasRestante > 0 ? formatHoras(c.horasRestante) : '—',
      reg.consumo,
      c.diferencia,
      c.stockActual,
      c.estado,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`);
  });

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const bom  = '\uFEFF'; // UTF-8 BOM para Excel
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const ts   = new Date().toISOString().slice(0, 10);

  const a    = document.createElement('a');
  a.href     = url;
  a.download = `silotrack_registros_${ts}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`${state.filtrados.length} registros exportados`, 'success');
}

/* ═══════════════════════════════════════
   FORMULARIO · UTILIDADES
═══════════════════════════════════════ */

/** Resetea el formulario a estado vacío */
function resetForm() {
  document.getElementById('wheatForm').reset();
  document.getElementById('editId').value = '';
  document.getElementById('submitBtn').innerHTML = '<span>✚</span> Guardar Registro';
  document.getElementById('calcPreview').style.display = 'none';
}

/** Establece la fecha de hoy como valor por defecto */
function setFechaHoyDefault() {
  const hoy = new Date().toISOString().slice(0, 10);
  document.getElementById('fFecha').value = hoy;
}

/** Listeners de cambio en el formulario para el preview en vivo */
function attachFormListeners() {
  const campos = ['fHoraInicio', 'fHoraFin', 'fCantidad', 'fConsumo'];
  campos.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', actualizarPreviewCalculo);
  });
}

/** Actualiza el panel de preview de cálculos en tiempo real */
function actualizarPreviewCalculo() {
  const horaInicio = document.getElementById('fHoraInicio').value;
  if (!horaInicio) {
    document.getElementById('calcPreview').style.display = 'none';
    return;
  }

  const regTemp = {
    horaInicio: horaInicio,
    horaFin:    document.getElementById('fHoraFin').value || null,
    cantidad:   Number(document.getElementById('fCantidad').value) || 0,
    consumo:    Number(document.getElementById('fConsumo').value) || 0,
  };

  const c = calcularCampos(regTemp);
  document.getElementById('calcPreview').style.display = 'grid';
  document.getElementById('prevHoras').textContent     = formatHoras(c.horasAcond);
  document.getElementById('prevRestante').textContent  = c.horasRestante > 0 ? formatHoras(c.horasRestante) : '—';
  document.getElementById('prevStock').textContent     = formatKg(c.stockActual);
  document.getElementById('prevEstado').textContent    = c.estado;
}

/* ═══════════════════════════════════════
   NAVEGACIÓN DE SECCIONES
═══════════════════════════════════════ */

/** Cambia la sección activa del dashboard */
function switchSection(sectionName) {
  // Ocultar todas las secciones
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));

  // Mostrar la seleccionada
  const target = document.getElementById(`section-${sectionName}`);
  if (target) target.classList.add('active');

  // Actualizar nav items
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.section === sectionName);
  });

  // Actualizar título
  const titles = {
    dashboard: 'Dashboard',
    registro:  'Nuevo Registro',
    tabla:     'Registros',
    alertas:   'Alertas',
  };
  setText('pageTitle', titles[sectionName] || 'SILOTRACK');

  // Actualizar filtros al entrar a tabla
  if (sectionName === 'tabla') applyFilters();
  if (sectionName === 'registro') {
    setFechaHoyDefault();
    actualizarPreviewCalculo();
  }
}

/* ═══════════════════════════════════════
   RELOJ Y ACTUALIZADOR AUTOMÁTICO
═══════════════════════════════════════ */

/** Inicia el reloj del sidebar */
function iniciarReloj() {
  actualizarReloj();
  setInterval(actualizarReloj, 1000);
}

function actualizarReloj() {
  const ahora = new Date();
  const h = padTwo(ahora.getHours());
  const m = padTwo(ahora.getMinutes());
  const s = padTwo(ahora.getSeconds());
  const d = padTwo(ahora.getDate());
  const mo = padTwo(ahora.getMonth() + 1);
  const y  = ahora.getFullYear();
  setText('systemClock', `${h}:${m}:${s}`);
  setText('systemDate',  `${d}/${mo}/${y}`);
}

/** Inicia el actualizador automático cada minuto */
function iniciarActualizador() {
  if (state.updateTimer) clearInterval(state.updateTimer);
  state.updateTimer = setInterval(() => {
    renderAll();
  }, CONFIG.UPDATE_INTERVAL_MS);
}

function actualizarTimestamp() {
  const ahora = new Date();
  setText('updateCounter', `Actualizado: ${padTwo(ahora.getHours())}:${padTwo(ahora.getMinutes())}`);
}

/* ═══════════════════════════════════════
   MODAL
═══════════════════════════════════════ */

let _modalCallback = null;

function openModal({ icon, title, body, onConfirm }) {
  _modalCallback = onConfirm;
  document.getElementById('modalIcon').textContent  = icon;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML    = body;
  document.getElementById('modalConfirm').onclick   = () => { if (_modalCallback) _modalCallback(); };
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  _modalCallback = null;
}

/* ═══════════════════════════════════════
   TOAST NOTIFICATIONS
═══════════════════════════════════════ */

/** Muestra un toast de notificación temporal */
function showToast(mensaje, tipo = 'info') {
  const iconos = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const container = document.getElementById('toastContainer');

  const toast = document.createElement('div');
  toast.className = `toast ${tipo}`;
  toast.innerHTML = `<span>${iconos[tipo] || 'ℹ'}</span><span>${escHtml(mensaje)}</span>`;
  container.appendChild(toast);

  // Auto-eliminar después de 4 segundos
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    toast.style.transition = 'opacity .3s, transform .3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/* ═══════════════════════════════════════
   SIDEBAR TOGGLE
═══════════════════════════════════════ */
document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

/* ═══════════════════════════════════════
   FUNCIONES UTILITARIAS
═══════════════════════════════════════ */

/** Genera un ID único para cada registro */
function generarId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Establece el texto de un elemento por ID */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/** Escapa HTML para prevenir XSS */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Formatea un número como kg con 2 decimales */
function formatKg(val) {
  const n = Number(val) || 0;
  return n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kg';
}

/** Formatea un datetime-local ISO a formato legible */
function formatDatetime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${padTwo(d.getDate())}/${padTwo(d.getMonth() + 1)} ${padTwo(d.getHours())}:${padTwo(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/** Rellena con cero a la izquierda para 2 dígitos */
function padTwo(n) {
  return String(n).padStart(2, '0');
}
