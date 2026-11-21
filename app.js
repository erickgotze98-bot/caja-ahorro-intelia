import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://gxqcybqrxvpqwrfsswae.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_xxiM51iKXpbYCdxOe_vj-g_C6Mr4CyS";
const MAX_DB_AMOUNT = 9999999999.99;
const LARGE_AMOUNT_CONFIRMATION = 100000;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const authScreen = document.querySelector("#auth-screen");
const appScreen = document.querySelector("#app-screen");
const toastRegion = document.querySelector("#toast-region");
const viewNames = {
  inicio: "Resumen", movimientos: "Movimientos", personas: "Personas",
  prestamos: "Préstamos", sabado: "Cerrar sábado"
};
const movementLabels = {
  ahorro_semanal: "Ahorro semanal", abono_prestamo: "Abono a préstamo",
  pago_multa: "Pago de multa", retiro_caja: "Retiro de caja", gasto: "Gasto",
  ajuste_ingreso: "Entrada de dinero", ajuste_egreso: "Salida de dinero",
  desembolso_prestamo: "Préstamo entregado"
};
const paymentLabels = { efectivo: "Efectivo", transferencia: "Transferencia" };
const state = {
  session: null, user: null, view: "inicio", cycles: [], people: [], loans: [],
  transactions: [], arqueos: [], gains: [], closures: [], shares: [], liquidity: null,
  expectedBalances: null, flow: [], pending: [], selectedCycleId: null, loading: false,
  syncing: false, actionBusy: false, refreshAt: null
};

const DB_NAME = "mi-caja-offline-v1";
const DB_VERSION = 1;
let dbPromise;
let refreshPromise;

function h(value = "") {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function money(value = 0) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function dateText(value) {
  if (!value) return "—";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function todayMx() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function lastSaturdayOnOrBefore(value = todayMx()) {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return addDays(value, -((weekday + 1) % 7));
}

function isSaturday(value) {
  if (!value) return false;
  return new Date(`${value}T00:00:00Z`).getUTCDay() === 6;
}

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isOnline() { return navigator.onLine; }

function toast(message, type = "info") {
  const color = type === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-teal-100 bg-white text-ink";
  const node = document.createElement("div");
  node.className = `pointer-events-auto rounded-xl border px-4 py-3 text-sm font-semibold shadow-soft ${color}`;
  node.textContent = message;
  toastRegion.append(node);
  window.setTimeout(() => node.remove(), 5000);
}

function isNetworkError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return !isOnline() || error?.name === "TypeError" || message.includes("fetch") || message.includes("network") || message.includes("failed to send") || message.includes("load failed");
}

function friendlyError(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  if (lower.includes("p_id ya fue usado")) return "Este folio ya se usó con otros datos. El movimiento original se conserva para evitar duplicarlo.";
  if (lower.includes("no autenticado") || lower.includes("jwt expired")) return "Tu sesión terminó. Vuelve a entrar para continuar.";
  if (lower.includes("debe ser sabado") || lower.includes("debe ser sábado")) return "Elige un sábado para la fecha del movimiento.";
  if (lower.includes("no se permiten operaciones futuras") || lower.includes("sabado futuro") || lower.includes("sábado futuro")) return "No puedes registrar una fecha futura.";
  if (lower.includes("fecha queda fuera del ciclo") || lower.includes("fuera del ciclo")) return "La fecha debe quedar dentro del ciclo abierto.";
  if (lower.includes("periodo ya fue cerrado") || lower.includes("período ya fue cerrado")) return "Ese sábado ya se cerró. Elige un período que siga abierto.";
  if (lower.includes("arqueo debe ser secuencial") || lower.includes("arqueo debe ser secuencial")) return "Debes cerrar los sábados en orden. Revisa cuál fecha sigue.";
  if (lower.includes("requiere nota de ajuste")) return "La diferencia supera $10. Escribe una explicación de al menos cinco caracteres.";
  if (lower.includes("excede el saldo pendiente")) return "El abono es mayor que lo que falta por pagar.";
  if (lower.includes("saldo negativo") || lower.includes("saldos no pueden ser negativos")) return "Este movimiento dejaría el dinero disponible por debajo de cero.";
  if (lower.includes("limite de credito") || lower.includes("límite de crédito")) return "El préstamo supera el límite de crédito de esta persona.";
  if (lower.includes("vulneraria reserva") || lower.includes("vulneraría reserva")) return "El préstamo dejaría menos dinero que la reserva mínima.";
  if (lower.includes("solo participantes activos")) return "Solo las personas activas pueden recibir un préstamo.";
  if (lower.includes("no se cierra el ciclo con prestamos") || lower.includes("préstamos cuyo saldo")) return "Aún quedan préstamos por cobrar. Registra los abonos pendientes antes de cerrar el ciclo.";
  if (lower.includes("ultimo sabado del ciclo") || lower.includes("último sábado del ciclo")) return "Primero debes cerrar el último sábado del ciclo.";
  if (lower.includes("no hay ahorro positivo")) return "Este ciclo no tiene ahorros para calcular el reparto de utilidades.";
  if (lower.includes("duplicate key") || lower.includes("ex_ciclos_sin_traslape")) return "Ese período se cruza con otro ciclo que ya existe.";
  if (lower.includes("permission denied") || lower.includes("row-level security") || lower.includes("rls")) return "Esta cuenta no tiene permiso para ese cambio. Vuelve a entrar con la cuenta administradora.";
  if (lower.includes("foreign key") || lower.includes("violates check") || lower.includes("not-null") || lower.includes("null value")) return "Algún dato no coincide con las reglas del ciclo. Revisa la persona, el préstamo y la fecha.";
  if (isNetworkError(error)) return "No hay conexión con internet. El movimiento se quedará guardado para sincronizarse.";
  return "No se pudo guardar. Revisa que los datos estén completos, que el ciclo siga abierto y vuelve a intentar.";
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("Este navegador no permite guardar datos sin conexión.")); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("queue")) {
          const queue = database.createObjectStore("queue", { keyPath: "id" });
          queue.createIndex("owner_id", "owner_id", { unique: false });
        }
        if (!database.objectStoreNames.contains("cache")) database.createObjectStore("cache", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento local."));
    });
  }
  return dbPromise;
}

async function storeGetAll(storeName) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function storePut(storeName, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readwrite").objectStore(storeName).put(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeDelete(storeName, key) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readwrite").objectStore(storeName).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function cacheKey(name) { return `${state.user?.id || "signed-out"}:${name}`; }

async function cacheWrite(name, value) {
  try { await storePut("cache", { key: cacheKey(name), value, updated_at: new Date().toISOString() }); } catch { /* cache is a convenience; auth/RLS still protect server data */ }
}

async function cacheRead(name) {
  try {
    const database = await db();
    return await new Promise((resolve, reject) => {
      const request = database.transaction("cache", "readonly").objectStore("cache").get(cacheKey(name));
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}

async function refreshPending() {
  try {
    state.pending = (await storeGetAll("queue"))
      .filter((item) => item.owner_id === state.user?.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  } catch { state.pending = []; }
  if (state.session) renderShell();
}

function resetData() {
  state.cycles = []; state.people = []; state.loans = []; state.transactions = [];
  state.arqueos = []; state.gains = []; state.closures = []; state.shares = [];
  state.liquidity = null; state.expectedBalances = null; state.flow = [];
}

function renderLogin(message = "") {
  appScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");
  authScreen.innerHTML = `
    <main class="safe-top safe-bottom flex min-h-screen items-center justify-center px-4 py-10">
      <section class="w-full max-w-md">
        <div class="mb-8 flex items-center gap-3">
          <img src="./icon.svg" class="h-12 w-12 rounded-2xl" alt="" />
          <div><p class="text-xs font-bold uppercase tracking-[.18em] text-teal-700">Intelia</p><h1 class="text-2xl font-extrabold text-ink">Mi Caja</h1></div>
        </div>
        <div class="card p-6 sm:p-8">
          <p class="text-sm font-semibold text-teal-700">Bienvenido</p>
          <h2 class="mt-1 text-2xl font-extrabold">Inicia sesión</h2>
          <p class="mt-2 text-sm leading-6 text-slate-500">Entra con tu correo y contraseña para ver la información de tu caja.</p>
          ${message ? `<div class="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">${h(message)}</div>` : ""}
          <form id="login-form" class="mt-6 space-y-4">
            <label class="field-label">Correo electrónico<input class="field" name="email" type="email" autocomplete="username" required value="${h(state.user?.email || "")}" placeholder="tu@correo.com" /></label>
            <label class="field-label">Contraseña<input class="field" name="password" type="password" autocomplete="current-password" required /></label>
            <button class="btn-primary w-full" type="submit">Entrar a Mi Caja</button>
          </form>
          <p class="mt-5 text-center text-xs leading-5 text-slate-400">Solo las personas autorizadas pueden entrar. Tus datos se consultan con tu sesión personal.</p>
        </div>
      </section>
    </main>`;
}

function renderPasswordChange(message = "") {
  appScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");
  authScreen.innerHTML = `
    <main class="safe-top safe-bottom flex min-h-screen items-center justify-center px-4 py-10">
      <section class="w-full max-w-md">
        <div class="mb-8 flex items-center gap-3"><img src="./icon.svg" class="h-12 w-12 rounded-2xl" alt="" /><div><p class="text-xs font-bold uppercase tracking-[.18em] text-teal-700">Intelia</p><h1 class="text-2xl font-extrabold">Mi Caja</h1></div></div>
        <div class="card p-6 sm:p-8">
          <span class="badge badge-amber">Paso necesario</span>
          <h2 class="mt-4 text-2xl font-extrabold">Crea tu contraseña personal</h2>
          <p class="mt-2 text-sm leading-6 text-slate-500">Antes de entrar, cambia la contraseña temporal por una que solo tú conozcas.</p>
          ${message ? `<div class="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">${h(message)}</div>` : ""}
          <form id="password-form" class="mt-6 space-y-4">
            <label class="field-label">Nueva contraseña<input class="field" name="password" type="password" autocomplete="new-password" minlength="10" required placeholder="Al menos 10 caracteres" /></label>
            <label class="field-label">Repite la contraseña<input class="field" name="confirm" type="password" autocomplete="new-password" minlength="10" required placeholder="Escríbela otra vez" /></label>
            <button class="btn-primary w-full" type="submit">Guardar y continuar</button>
          </form>
          <button data-action="logout" class="btn-quiet mt-4 w-full">Salir de esta cuenta</button>
        </div>
      </section>
    </main>`;
}

function icon(name, size = 20) {
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 8v6M23 11h-6"/>',
    wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 15h2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 12-2L20 12M4 12l2.4 5a7 7 0 0 0 12-2"/>',
    wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
    logout: '<path d="M10 17l5-5-5-5M15 12H3M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
    message: '<path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20l1.1-4.2A8.5 8.5 0 1 1 21 11.5Z"/>'
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.home}</svg>`;
}

function selectedCycle() {
  const available = state.cycles.filter((cycle) => cycle.activo);
  return available.find((cycle) => cycle.id === state.selectedCycleId) || available[0] || state.cycles[0] || null;
}

function cycleName(cycle) { return cycle?.nombre || "Sin ciclo"; }
function participantName(id) { return state.people.find((person) => person.id === id)?.nombre || "Sin persona"; }
function activePeople() { return state.people.filter((person) => person.estatus !== "inactivo"); }
function loanBalance(loan) {
  const payments = state.transactions.filter((transaction) => transaction.prestamo_id === loan.id && transaction.tipo_movimiento === "abono_prestamo" && !transaction.anulado);
  const paidCapital = payments.reduce((total, payment) => total + Number(payment.capital_aplicado || 0), 0);
  const paidInterest = payments.reduce((total, payment) => total + Number(payment.interes_aplicado || 0), 0);
  return Math.max(0, Number(loan.capital_original || 0) + Number(loan.interes_total || 0) - paidCapital - paidInterest);
}

function loanCapitalBalance(loan) {
  const paidCapital = state.transactions.filter((transaction) => transaction.prestamo_id === loan.id && transaction.tipo_movimiento === "abono_prestamo" && !transaction.anulado).reduce((total, payment) => total + Number(payment.capital_aplicado || 0), 0);
  return Math.max(0, Number(loan.capital_original || 0) - paidCapital);
}

function queueCount() { return state.pending.filter((item) => item.status === "pending" || item.status === "blocked").length; }
function queuedLabel(item) { return item.action === "loan" ? "Préstamo" : (movementLabels[item.payload.p_tipo_movimiento] || item.payload.p_tipo_movimiento); }
function queuedAmount(item) { return item.action === "loan" ? item.payload.p_capital : item.payload.p_monto; }
function queuedDate(item) { return item.action === "loan" ? item.payload.p_fecha_desembolso : item.payload.p_fecha_operacion; }
function nextQueuedAt() {
  const previous = state.pending.reduce((latest, item) => Math.max(latest, Date.parse(item.created_at) || 0), 0);
  return new Date(Math.max(Date.now(), previous + 1)).toISOString();
}

function renderShell() {
  if (!state.session || !state.user) return;
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  const cycleOptions = state.cycles.filter((cycle) => cycle.activo).map((cycle) => `<option value="${h(cycle.id)}" ${cycle.id === selectedCycle()?.id ? "selected" : ""}>${h(cycle.nombre)}</option>`).join("");
  const nav = Object.entries(viewNames).map(([key, label]) => `<button class="nav-item ${state.view === key ? "active" : ""}" data-action="navigate" data-view="${key}">${icon(({ inicio: "home", movimientos: "list", personas: "people", prestamos: "wallet", sabado: "calendar" })[key])}<span>${label}</span></button>`).join("");
  const networkStatus = isOnline() ? `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">${icon("wifi", 16)} Con internet</span>` : `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">${icon("wifi", 16)} Sin internet</span>`;
  const pending = queueCount();
  const top = `
    <header class="sticky top-0 z-30 border-b border-slate-100 bg-sand-50/95 backdrop-blur safe-top">
      <div class="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div class="flex items-center gap-2.5"><img src="./icon.svg" class="h-10 w-10 rounded-xl" alt="" /><div><p class="text-[10px] font-extrabold uppercase tracking-[.17em] text-teal-700">Intelia</p><p class="text-lg font-extrabold leading-5">Mi Caja</p></div></div>
        <div class="flex items-center gap-3">
          <div class="hidden items-center gap-3 sm:flex">${networkStatus}${pending ? `<span class="badge badge-amber">${pending} pendiente${pending === 1 ? "" : "s"}</span>` : ""}<button data-action="sync" class="btn-quiet" ${!isOnline() || state.syncing ? "disabled" : ""}>${icon("refresh", 16)} Sincronizar</button></div>
          <button data-action="logout" class="btn-quiet" aria-label="Salir">${icon("logout", 17)}<span class="hidden sm:inline">Salir</span></button>
        </div>
      </div>
    </header>`;
  const page = `
    <div class="mx-auto grid min-h-[calc(100vh-66px)] max-w-7xl grid-cols-1 lg:grid-cols-[225px_minmax(0,1fr)]">
      <aside class="hidden border-r border-slate-100 px-4 py-6 lg:block">
        <div class="mb-5 rounded-xl bg-white p-3"><label class="text-[11px] font-bold uppercase tracking-wide text-slate-400" for="cycle-picker">Ciclo</label><select id="cycle-picker" class="mt-1 w-full bg-transparent text-sm font-bold outline-none" ${!cycleOptions ? "disabled" : ""}>${cycleOptions || '<option>Sin ciclos</option>'}</select></div>
        <nav class="space-y-1">${nav}</nav>
        <div class="mt-7 rounded-xl bg-teal-50 p-3 text-xs leading-5 text-teal-800"><strong>Tu cuenta</strong><br/>${h(state.user.email || "Sesión activa")}</div>
      </aside>
      <main class="min-w-0 px-4 pb-28 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pb-10">
        <div class="mb-5 flex flex-wrap items-center justify-between gap-3 lg:hidden">
          <div><p class="text-xs text-slate-500">Hola${state.user.email ? `, ${h(state.user.email)}` : ""}</p><h1 class="text-xl font-extrabold">${viewNames[state.view]}</h1></div>
          <select id="cycle-picker-mobile" class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold" ${!cycleOptions ? "disabled" : ""}>${cycleOptions || '<option>Sin ciclos</option>'}</select>
        </div>
        <div class="mb-5 hidden items-center justify-between lg:flex"><div><p class="text-sm text-slate-500">Hola${state.user.email ? `, ${h(state.user.email)}` : ""}</p><h1 class="mt-1 text-2xl font-extrabold">${viewNames[state.view]}</h1></div><div>${networkStatus}</div></div>
        ${!isOnline() ? `<div class="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Estás sin internet. Puedes anotar ahorros y abonos; se enviarán en el mismo orden cuando vuelva la conexión.</div>` : ""}
      ${pending ? `<div class="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"><p class="text-sm text-amber-900"><strong>${pending} registro${pending === 1 ? "" : "s"}</strong> ${state.pending.some((row) => row.status === "blocked") ? "esperando revisión" : "guardado"} en este dispositivo.</p><button data-action="sync" class="btn-secondary px-3 py-2" ${!isOnline() || state.syncing ? "disabled" : ""}>${icon("refresh", 16)} Enviar</button></div>` : ""}
        <section id="view-content">${renderView()}</section>
      </main>
      <nav class="safe-bottom fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-slate-100 bg-white/95 px-1 pt-2 backdrop-blur lg:hidden">${Object.entries(viewNames).map(([key,label]) => `<button data-action="navigate" data-view="${key}" class="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[10px] font-bold ${state.view === key ? "text-teal-700" : "text-slate-500"}">${icon(({inicio:"home",movimientos:"list",personas:"people",prestamos:"wallet",sabado:"calendar"})[key],19)}<span>${label}</span></button>`).join("")}</nav>
    </div>`;
  appScreen.innerHTML = `${top}${page}`;
}

function emptyState(message) { return `<div class="empty">${h(message)}</div>`; }

function statCard(title, value, hint, iconName, tone = "teal") {
  const color = tone === "blue" ? "bg-blue-50 text-blue-700" : tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700";
  return `<article class="card"><div class="flex items-start justify-between gap-3"><div><p class="text-sm font-semibold text-slate-500">${title}</p><p class="mt-2 text-2xl font-extrabold tracking-tight">${value}</p><p class="mt-1 text-xs text-slate-400">${hint}</p></div><span class="rounded-xl ${color} p-3">${icon(iconName,21)}</span></div></article>`;
}

function renderDashboard() {
  const cycle = selectedCycle();
  const gains = state.gains.find((item) => item.ciclo_id === cycle?.id);
  const liveLoans = state.loans.filter((loan) => loan.ciclo_id === cycle?.id && loan.estado === "activo");
  const outstanding = liveLoans.reduce((sum, loan) => sum + loanBalance(loan), 0);
  const latest = state.transactions.filter((tx) => tx.ciclo_id === cycle?.id).slice(0, 5);
  const cash = state.liquidity;
  const due = cash ? money(cash.liquidez_total) : "—";
  return `
    ${!state.cycles.length ? `<div class="mb-5 rounded-2xl border border-teal-100 bg-teal-50 p-5"><p class="font-bold">Empieza creando tu ciclo</p><p class="mt-1 text-sm text-slate-600">Después podrás agregar personas y registrar ahorros o préstamos.</p><button class="btn-primary mt-4" data-action="navigate" data-view="sabado">Crear ciclo${icon("arrow", 17)}</button></div>` : ""}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      ${statCard("Dinero disponible", due, cash ? `En caja y banco · ${dateText(cash.fecha)}` : "Consulta cuando haya conexión", "wallet")}
      ${statCard("Préstamos por cobrar", money(outstanding), `${liveLoans.length} préstamo${liveLoans.length === 1 ? "" : "s"} activo${liveLoans.length === 1 ? "" : "s"}`, "list", "blue")}
      ${statCard("Utilidad del ciclo", money(gains?.utilidad_neta || 0), "Intereses y multas, menos gastos", "plus", "amber")}
      ${statCard("Personas", String(state.people.filter((p) => p.estatus !== "inactivo").length), "Socios y clientes activos", "people")}
    </div>
    <div class="mt-5 grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
      <div class="space-y-5">
        <section class="card">
          <div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Semana a semana</p><h2 class="mt-1 text-lg font-extrabold">${cycle ? h(cycle.nombre) : "Todavía no hay ciclo"}</h2><p class="mt-1 text-sm text-slate-500">${cycle ? `${dateText(cycle.fecha_inicio)} al ${dateText(cycle.fecha_fin)}` : "Crea un ciclo de diciembre a noviembre."}</p></div>${cycle ? `<span class="badge ${cycle.activo ? "badge-green" : "badge-gray"}">${cycle.activo ? "Abierto" : "Cerrado"}</span>` : ""}</div>
          <div class="mt-5 grid gap-3 sm:grid-cols-3">
            <button class="btn-secondary justify-between" data-action="navigate" data-view="movimientos">Anotar movimiento ${icon("arrow",16)}</button>
            <button class="btn-secondary justify-between" data-action="navigate" data-view="prestamos">Prestar dinero ${icon("arrow",16)}</button>
            <button class="btn-secondary justify-between" data-action="navigate" data-view="sabado">Cerrar sábado ${icon("arrow",16)}</button>
          </div>
        </section>
        <section class="card">
          <div class="mb-4 flex items-center justify-between"><div><h2 class="text-lg font-extrabold">Últimos movimientos</h2><p class="text-sm text-slate-500">Actividad del ciclo seleccionado</p></div><button data-action="navigate" data-view="movimientos" class="btn-quiet">Ver todos ${icon("arrow",16)}</button></div>
          ${latest.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Detalle</th><th>Persona</th><th>Monto</th></tr></thead><tbody>${latest.map((tx) => `<tr><td>${dateText(tx.fecha_operacion)}</td><td>${h(movementLabels[tx.tipo_movimiento] || tx.tipo_movimiento)}${tx.anulado ? ` <span class="badge badge-red">Anulado</span>` : ""}</td><td>${h(participantName(tx.participante_id))}</td><td class="font-bold">${money(tx.monto)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("Todavía no hay movimientos en este ciclo.")}
        </section>
      </div>
      <div class="space-y-5">
        <section class="card"><div class="flex items-center justify-between"><div><h2 class="text-lg font-extrabold">Tu semana</h2><p class="text-sm text-slate-500">Ahorro y flujo por sábado</p></div>${icon("calendar",22)}</div>
          ${state.flow.length ? `<div class="mt-4 space-y-3">${state.flow.slice(-4).reverse().map((row) => `<div class="flex items-center justify-between border-b border-slate-100 pb-3 last:border-0"><div><p class="font-semibold">${dateText(row.semana_sabado)}</p><p class="text-xs text-slate-400">Ahorro ${money(row.ahorro)}</p></div><div class="text-right"><p class="font-bold ${Number(row.flujo_neto) < 0 ? "text-rose-700" : "text-ink"}">${money(row.flujo_neto)}</p><p class="text-xs text-slate-400">${row.estatus_cierre === "cerrado" ? "Sábado cerrado" : row.estatus_cierre === "cerrado_con_discrepancia" ? "Cerrado con diferencia" : "Sin cierre"}</p></div></div>`).join("")}</div>` : emptyState("El resumen aparecerá cuando haya actividad.")}
        </section>
        <section class="rounded-2xl bg-ink p-5 text-white"><p class="text-sm font-semibold text-teal-100">Recuerda</p><h2 class="mt-1 text-lg font-extrabold">Cierra cada sábado en orden</h2><p class="mt-2 text-sm leading-6 text-slate-300">Compara el dinero contado y el saldo bancario. Si la diferencia supera $10, agrega una nota.</p><button class="mt-4 inline-flex items-center gap-2 font-bold text-teal-100" data-action="navigate" data-view="sabado">Ir a Cerrar sábado ${icon("arrow",16)}</button></section>
      </div>
    </div>`;
}

function participantOptions(filter = "all", selected = "", onlyActive = false) {
  return activePeople().filter((person) => (!onlyActive || person.estatus === "activo") && (filter === "all" || person.tipo === filter)).map((person) => `<option value="${h(person.id)}" ${person.id === selected ? "selected" : ""}>${h(person.nombre)}${person.tipo === "externo" ? " · externo" : " · socio"}${person.estatus === "cartera_vencida" ? " · pagos pendientes" : ""}</option>`).join("");
}

function openLoans(cycleId = selectedCycle()?.id) {
  return state.loans.filter((loan) => loan.ciclo_id === cycleId && loan.estado === "activo" && loanBalance(loan) > 0.01);
}

function renderMovementForm() {
  const cycle = selectedCycle();
  const choices = ["ahorro_semanal", "abono_prestamo", "pago_multa", "retiro_caja", "gasto", "ajuste_ingreso", "ajuste_egreso"];
  const loanChoices = openLoans().map((loan) => `<option value="${h(loan.id)}" data-person="${h(loan.participante_id)}">${h(participantName(loan.participante_id))} · pendiente ${money(loanBalance(loan))}</option>`).join("");
  return `
    <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section class="card">
        <p class="text-xs font-bold uppercase tracking-wide text-teal-700">Guardar movimiento</p><h2 class="mt-1 text-xl font-extrabold">Anotar ahorro o movimiento</h2><p class="mt-2 text-sm leading-6 text-slate-500">Si no tienes internet, el movimiento se guarda en este dispositivo y se manda después con el mismo folio.</p>
        <form id="movement-form" class="mt-6 grid gap-4 sm:grid-cols-2">
          <label class="field-label sm:col-span-2">¿Qué quieres anotar?<select class="field" name="kind" id="movement-kind" required>${choices.map((kind) => `<option value="${kind}">${movementLabels[kind]}</option>`).join("")}</select></label>
          <label class="field-label sm:col-span-2" id="movement-person-wrap">Persona<select class="field" name="participant_id" id="movement-person"><option value="">Elige a un socio</option>${participantOptions("socio")}</select></label>
          <label class="field-label hidden sm:col-span-2" id="movement-loan-wrap">Préstamo<select class="field" name="loan_id" id="movement-loan"><option value="">Elige un préstamo</option>${loanChoices}</select></label>
          <label class="field-label">Monto<input class="field" name="amount" inputmode="decimal" type="number" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" required placeholder="0.00" /></label>
          <label class="field-label">Forma de pago<select class="field" name="method" required><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
          <label class="field-label">Fecha (debe ser sábado)<input class="field" name="date" type="date" max="${todayMx()}" value="${lastSaturdayOnOrBefore()}" required /></label>
          <label class="field-label">Nota (opcional)<input class="field" name="note" maxlength="1000" placeholder="Un detalle breve" /></label>
          <div class="sm:col-span-2"><p id="movement-hint" class="text-xs leading-5 text-slate-500">${cycle ? `Ciclo: ${h(cycle.nombre)}. El backend revisa que el sábado siga abierto.` : "Crea un ciclo y una persona antes de anotar movimientos."}</p><button class="btn-primary mt-4 w-full sm:w-auto" type="submit" ${!cycle || !activePeople().length || state.syncing ? "disabled" : ""}>Guardar movimiento</button></div>
        </form>
      </section>
      <aside class="space-y-5">
        <section class="card"><h3 class="font-extrabold">Pendientes guardados</h3><p class="mt-1 text-sm text-slate-500">Se envían en orden cuando vuelve internet.</p>${state.pending.length ? `<div class="mt-4 space-y-3">${state.pending.map((item) => `<div class="rounded-xl border border-slate-100 p-3"><div class="flex items-start justify-between gap-2"><div><p class="text-sm font-bold">${h(queuedLabel(item))}</p><p class="text-xs text-slate-500">${dateText(queuedDate(item))} · ${money(queuedAmount(item))}</p><p class="mt-1 text-[11px] text-slate-400">Folio: ${h(item.payload.p_id)}</p></div><span class="badge ${item.status === "blocked" ? "badge-red" : "badge-amber"}">${item.status === "blocked" ? "Revisar" : "En espera"}</span></div>${item.last_error ? `<p class="mt-2 text-xs text-rose-700">${h(friendlyError(item.last_error))}</p>` : ""}<div class="mt-2 flex gap-2">${item.status === "blocked" ? `<button class="btn-quiet px-2 py-1 text-xs" data-action="retry-queue" data-id="${h(item.id)}">Reintentar</button>` : ""}<button class="btn-quiet px-2 py-1 text-xs text-rose-700" data-action="discard-queue" data-id="${h(item.id)}">Quitar del dispositivo</button></div></div>`).join("")}</div>` : `<p class="mt-4 text-sm text-slate-400">No hay pendientes guardados.</p>`}</section>
        <section class="rounded-2xl border border-blue-100 bg-blue-50 p-5"><h3 class="font-extrabold text-blue-900">Un folio por movimiento</h3><p class="mt-2 text-sm leading-6 text-blue-800">Si la señal falla al enviar, volveremos a intentar el mismo folio y los mismos datos para que no se duplique.</p></section>
      </aside>
    </div>
    <section class="card mt-5"><div class="mb-4"><h2 class="text-lg font-extrabold">Historial del ciclo</h2><p class="text-sm text-slate-500">Anula un registro incorrecto con una explicación.</p></div>${renderTransactionsTable(state.transactions.filter((tx) => tx.ciclo_id === cycle?.id), true)}</section>`;
}

function renderTransactionsTable(rows, allowCancel = false) {
  if (!rows.length) return emptyState("No hay movimientos en este ciclo.");
  const sorted = [...rows].sort((a, b) => String(b.fecha_operacion).localeCompare(String(a.fecha_operacion)) || String(b.creado_at).localeCompare(String(a.creado_at)));
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Movimiento</th><th>Persona</th><th>Forma de pago</th><th>Monto</th>${allowCancel ? "<th></th>" : ""}</tr></thead><tbody>${sorted.map((tx) => `<tr><td>${dateText(tx.fecha_operacion)}</td><td>${h(movementLabels[tx.tipo_movimiento] || tx.tipo_movimiento)}${tx.anulado ? ` <span class="badge badge-red">Anulado</span>` : ""}</td><td>${h(participantName(tx.participante_id))}</td><td>${h(paymentLabels[tx.metodo_pago] || tx.metodo_pago)}</td><td class="font-bold">${money(tx.monto)}</td>${allowCancel ? `<td>${!tx.anulado ? `<button class="btn-quiet text-rose-700" data-action="cancel-tx" data-id="${h(tx.id)}">Anular</button>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

function whatsappLink(person, amount) {
  const phoneInput = window.prompt(`Escribe el número de WhatsApp de ${person.nombre}, con lada de país (solo números). No se guardará en la app.`);
  if (!phoneInput) return;
  const phone = phoneInput.replace(/\D/g, "");
  if (phone.length < 10 || phone.length > 15) { toast("Escribe un número con lada de país, por ejemplo 5215512345678.", "error"); return; }
  const message = `Hola ${person.nombre}, te recordamos que tienes un saldo pendiente de ${money(amount)} en la caja de ahorro. Si ya realizaste tu pago, puedes ignorar este mensaje. Gracias.`;
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
}

function renderPeople() {
  const cycleId = selectedCycle()?.id;
  const personRows = state.people.map((person) => {
    const loans = state.loans.filter((loan) => loan.participante_id === person.id && loan.ciclo_id === cycleId && loan.estado === "activo");
    const balance = loans.reduce((sum, loan) => sum + loanBalance(loan), 0);
    return `<tr><td class="font-semibold">${h(person.nombre)}</td><td>${person.tipo === "socio" ? "Socio" : "Externo"}</td><td>${h(({ activo: "Activo", cartera_vencida: "Con pagos pendientes", inactivo: "Inactivo" })[person.estatus] || person.estatus)}</td><td>${money(person.limite_credito)}</td><td>${money(balance)}</td><td>${balance > 0 ? `<button class="btn-quiet text-teal-700" data-action="whatsapp" data-person="${h(person.id)}" data-amount="${balance}">${icon("message",16)} Recordar</button>` : "—"}</td></tr>`;
  }).join("");
  return `<div class="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
    <section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Agregar persona</p><h2 class="mt-1 text-xl font-extrabold">Socio o cliente</h2><p class="mt-2 text-sm text-slate-500">El teléfono se pide solo al preparar un recordatorio de WhatsApp.</p>
      <form id="person-form" class="mt-5 space-y-4">
        <label class="field-label">Nombre completo<input class="field" name="name" maxlength="200" required placeholder="Nombre de la persona" /></label>
        <label class="field-label">Tipo<select class="field" name="type"><option value="socio">Socio</option><option value="externo">Externo</option></select></label>
        <label class="field-label">Límite para préstamos (externos)<input class="field" name="limit" inputmode="decimal" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" value="0.00" /></label>
        <button class="btn-primary w-full" type="submit" ${!isOnline() || state.syncing ? "disabled" : ""}>Guardar persona</button>
      </form>
    </section>
    <section class="card"><div class="mb-4"><h2 class="text-lg font-extrabold">Personas registradas</h2><p class="text-sm text-slate-500">Solo tú puedes ver esta lista.</p></div>${personRows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Nombre</th><th>Tipo</th><th>Estado</th><th>Límite</th><th>Préstamos pendientes</th><th></th></tr></thead><tbody>${personRows}</tbody></table></div>` : emptyState("Agrega la primera persona para empezar.")}</section>
  </div>`;
}

function renderLoans() {
  const cycle = selectedCycle();
  const hasLoanPending = state.pending.some((item) => item.action === "loan" && item.payload.p_ciclo_id === cycle?.id);
  const loans = state.loans.filter((loan) => loan.ciclo_id === cycle?.id).sort((a, b) => String(b.fecha_desembolso).localeCompare(String(a.fecha_desembolso)));
  const rows = loans.map((loan) => `<tr><td>${dateText(loan.fecha_desembolso)}</td><td class="font-semibold">${h(participantName(loan.participante_id))}</td><td>${money(loan.capital_original)}</td><td>${money(loan.interes_total)} <span class="text-xs text-slate-400">(5%)</span></td><td class="font-bold">${money(loanBalance(loan))}</td><td>${loan.plazo_semanas} sem.</td><td><span class="badge ${loanBalance(loan) > 0.01 ? "badge-amber" : "badge-green"}">${loanBalance(loan) > 0.01 ? "Pendiente" : "Pagado"}</span></td></tr>`).join("");
  return `<div class="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
    <section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Nuevo préstamo</p><h2 class="mt-1 text-xl font-extrabold">Prestar dinero</h2><p class="mt-2 text-sm leading-6 text-slate-500">El interés es fijo: 5% del capital para socios y externos. Se necesita internet para confirmar el préstamo.</p>
      <form id="loan-form" class="mt-5 space-y-4">
        <label class="field-label">Persona<select class="field" name="participant_id" required><option value="">Elige a una persona</option>${participantOptions("all", "", true)}</select></label>
        <label class="field-label">Cantidad a prestar<input class="field" name="capital" type="number" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" required inputmode="decimal" placeholder="0.00" /></label>
        <label class="field-label">Plazo (semanas)<input class="field" name="weeks" type="number" min="1" step="1" required value="8" /></label>
        <label class="field-label">Fecha de entrega (sábado)<input class="field" name="date" type="date" value="${lastSaturdayOnOrBefore()}" max="${todayMx()}" required /></label>
        <label class="field-label">Forma de entrega<select class="field" name="method"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
        <label class="field-label">Nota (opcional)<input class="field" name="note" maxlength="1000" placeholder="Detalle breve" /></label>
        <button class="btn-primary w-full" type="submit" ${!cycle || !activePeople().length || !isOnline() || state.syncing || hasLoanPending ? "disabled" : ""}>Confirmar préstamo</button>
        ${hasLoanPending ? `<p class="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">Hay un préstamo pendiente de confirmar. Espera a que sincronice o revisa el folio guardado antes de intentar otro.</p>` : ""}
      </form>
    </section>
    <section class="card"><div class="mb-4"><h2 class="text-lg font-extrabold">Préstamos del ciclo</h2><p class="text-sm text-slate-500">El monto pendiente incluye capital e interés menos los abonos recibidos.</p></div>${rows ? `<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Persona</th><th>Capital</th><th>Interés</th><th>Pendiente</th><th>Plazo</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState("Aún no hay préstamos en este ciclo.")}</section>
  </div>`;
}

function expectedSaturday(cycle) {
  if (!cycle) return null;
  const entries = state.arqueos.filter((row) => row.ciclo_id === cycle.id).sort((a, b) => String(a.fecha_sabado).localeCompare(String(b.fecha_sabado)));
  return entries.length ? addDays(entries[entries.length - 1].fecha_sabado, 7) : cycle.fecha_inicio;
}

function renderCycleForm() {
  const nextStartYear = Number(todayMx().slice(0, 4)) + (Number(todayMx().slice(5, 7)) === 12 ? 0 : 0);
  const start = firstSaturdayOfDecember(nextStartYear);
  const end = lastSaturdayOfNovember(nextStartYear + 1);
  return `<section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Abrir un ciclo</p><h2 class="mt-1 text-xl font-extrabold">Ciclo de diciembre a noviembre</h2><p class="mt-2 text-sm text-slate-500">Las fechas de inicio y fin deben caer en sábado. El ciclo puede comenzar más adelante.</p><form id="cycle-form" class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
    <label class="field-label sm:col-span-2 xl:col-span-1">Nombre del ciclo<input class="field" name="name" maxlength="200" required value="Caja ${nextStartYear}–${nextStartYear + 1}" /></label>
    <label class="field-label">Primer sábado (diciembre)<input class="field" name="start" type="date" value="${start}" required /></label>
    <label class="field-label">Último sábado (noviembre)<input class="field" name="end" type="date" value="${end}" required /></label>
    <label class="field-label">Dinero inicial en caja<input class="field" name="cash" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" value="0.00" required /></label>
    <label class="field-label">Dinero inicial en banco<input class="field" name="bank" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" value="0.00" required /></label>
    <label class="field-label">Reserva mínima<input class="field" name="reserve" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" value="0.00" required /></label>
    <div class="sm:col-span-2 xl:col-span-3"><button class="btn-primary" type="submit" ${!isOnline() || state.syncing ? "disabled" : ""}>Crear ciclo</button></div>
  </form></section>`;
}

function firstSaturdayOfDecember(year) {
  const d = new Date(Date.UTC(year, 11, 1));
  return addDays(d.toISOString().slice(0, 10), (6 - d.getUTCDay() + 7) % 7);
}

function lastSaturdayOfNovember(year) {
  const d = new Date(Date.UTC(year, 11, 0));
  return addDays(d.toISOString().slice(0, 10), -((d.getUTCDay() + 1) % 7));
}

function renderClosure() {
  const cycle = selectedCycle();
  const saturday = expectedSaturday(cycle);
  const alreadyClosed = state.closures.find((item) => item.ciclo_id === cycle?.id);
  const expected = state.expectedBalances;
  const canCloseSaturday = cycle?.activo && saturday && saturday <= todayMx() && saturday <= cycle.fecha_fin && isOnline();
  const gain = state.gains.find((item) => item.ciclo_id === cycle?.id);
  const shareRows = alreadyClosed ? state.shares.filter((share) => share.cierre_id === alreadyClosed.id).map((share) => `<tr><td>${h(participantName(share.participante_id))}</td><td>${money(share.ahorro_base)}</td><td>${Number(share.porcentaje).toFixed(4)}%</td><td class="font-bold">${money(share.monto_utilidad)}</td></tr>`).join("") : "";
  const lastWeek = cycle ? state.arqueos.filter((row) => row.ciclo_id === cycle.id).sort((a,b) => String(b.fecha_sabado).localeCompare(String(a.fecha_sabado)))[0] : null;
  return `<div class="space-y-5">
    ${!cycle || !state.cycles.some((row) => row.activo) ? renderCycleForm() : ""}
    ${cycle ? `<section class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Cierre semanal</p><h2 class="mt-1 text-xl font-extrabold">Cerrar sábado</h2><p class="mt-2 text-sm leading-6 text-slate-500">Cierra los sábados en orden. Si la diferencia entre el saldo esperado y el real pasa de $10, agrega una nota breve.</p>
        <div class="mt-5 grid gap-3 sm:grid-cols-3"><div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Sábado que sigue</p><p class="mt-1 font-bold">${saturday ? dateText(saturday) : "—"}</p></div><div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Efectivo esperado</p><p class="mt-1 font-bold">${expected ? money(expected.efectivo) : "—"}</p></div><div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Banco esperado</p><p class="mt-1 font-bold">${expected ? money(expected.transferencias) : "—"}</p></div></div>
        ${canCloseSaturday ? `<form id="close-week-form" class="mt-5 grid gap-4 sm:grid-cols-2"><label class="field-label">Efectivo contado<input class="field" name="cash" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" required inputmode="decimal" /></label><label class="field-label">Saldo bancario real<input class="field" name="bank" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" required inputmode="decimal" /></label><label class="field-label sm:col-span-2">Nota si hay una diferencia mayor a $10<input class="field" name="note" maxlength="1000" placeholder="Explica brevemente la diferencia" /></label><div class="sm:col-span-2"><button class="btn-primary" type="submit" ${state.syncing ? "disabled" : ""}>Guardar cierre del sábado</button></div></form>` : `<div class="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">${alreadyClosed ? "Este ciclo ya se cerró." : !isOnline() ? "Conéctate a internet para cerrar el sábado." : saturday > todayMx() ? "El sábado que sigue todavía no llega." : saturday > cycle.fecha_fin ? "Ya se cerraron todos los sábados de este ciclo." : "Selecciona un ciclo abierto para continuar."}</div>`}
      </div>
      <aside class="card"><h3 class="font-extrabold">Último cierre</h3>${lastWeek ? `<p class="mt-3 text-sm text-slate-500">${dateText(lastWeek.fecha_sabado)}</p><p class="mt-1 text-sm">Efectivo contado: <strong>${money(lastWeek.efectivo_fisico_real)}</strong></p><p class="mt-1 text-sm">Saldo bancario: <strong>${money(lastWeek.saldo_banco_real)}</strong></p><p class="mt-3"><span class="badge ${lastWeek.estatus_cierre === "cerrado" ? "badge-green" : "badge-amber"}">${lastWeek.estatus_cierre === "cerrado" ? "Sin diferencias mayores a $10" : "Cerrado con diferencia"}</span></p>` : `<p class="mt-2 text-sm text-slate-500">Aún no se ha cerrado un sábado.</p>`}<div class="mt-5 border-t border-slate-100 pt-4"><p class="text-sm font-semibold text-slate-500">Utilidad hasta ahora</p><p class="mt-1 text-xl font-extrabold">${money(gain?.utilidad_neta || 0)}</p><p class="mt-1 text-xs text-slate-400">El reparto final se calcula al cerrar el ciclo.</p></div></aside>
    </section>` : ""}
    ${cycle && !cycle.activo && alreadyClosed ? `<section class="card"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Ciclo concluido</p><h2 class="mt-1 text-xl font-extrabold">Utilidades repartidas</h2><p class="mt-1 text-sm text-slate-500">${h(cycle.nombre)} · total ${money(alreadyClosed.utilidad_neta)}</p></div><span class="badge badge-green">Cerrado</span></div>${shareRows ? `<div class="table-wrap mt-5"><table class="table"><thead><tr><th>Socio</th><th>Ahorro acumulado</th><th>Porcentaje</th><th>Utilidad recibida</th></tr></thead><tbody>${shareRows}</tbody></table></div>` : emptyState("No se encontraron filas del reparto.")}</section>` : ""}
    ${cycle?.activo ? `<section class="card"><h2 class="text-lg font-extrabold">Cerrar ciclo y repartir utilidades</h2><p class="mt-2 max-w-3xl text-sm leading-6 text-slate-500">El sistema revisará que se haya cerrado el último sábado, que no queden préstamos pendientes y que haya ahorro para calcular un reparto proporcional. Esta acción no se puede deshacer.</p><div class="mt-4 flex flex-wrap items-center gap-4"><p class="text-sm">Último sábado ${cycle.fecha_fin ? dateText(cycle.fecha_fin) : "—"}: <strong>${lastWeek?.fecha_sabado === cycle.fecha_fin ? "cerrado" : "pendiente"}</strong></p><button class="btn-primary" data-action="close-cycle" ${!isOnline() || state.syncing || state.actionBusy ? "disabled" : ""}>Cerrar ciclo y calcular reparto</button></div></section>` : ""}
    ${state.cycles.length ? `<section class="card"><h2 class="text-lg font-extrabold">Tus ciclos</h2><div class="mt-4 table-wrap"><table class="table"><thead><tr><th>Nombre</th><th>Fechas</th><th>Estado</th><th></th></tr></thead><tbody>${state.cycles.map((row) => `<tr><td class="font-semibold">${h(row.nombre)}</td><td>${dateText(row.fecha_inicio)} – ${dateText(row.fecha_fin)}</td><td><span class="badge ${row.activo ? "badge-green" : "badge-gray"}">${row.activo ? "Abierto" : "Cerrado"}</span></td><td>${row.activo ? `<button data-action="select-cycle" data-id="${h(row.id)}" class="btn-quiet">Ver ciclo</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
  </div>`;
}

function renderView() {
  if (state.loading && !state.cycles.length && !state.people.length) return `<div class="card py-12 text-center text-slate-500">Cargando la información de tu caja…</div>`;
  switch (state.view) {
    case "movimientos": return renderMovementForm();
    case "personas": return renderPeople();
    case "prestamos": return renderLoans();
    case "sabado": return renderClosure();
    default: return renderDashboard();
  }
}

async function fetchAll(table, select = "*", orderColumn = "id") {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase.from(table).select(select);
    if (orderColumn) query = query.order(orderColumn, { ascending: true });
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

async function loadCachedData() {
  const [cycles, people, loans, transactions, arqueos, gains, closures, shares, flow] = await Promise.all([
    cacheRead("cycles"), cacheRead("people"), cacheRead("loans"), cacheRead("transactions"),
    cacheRead("arqueos"), cacheRead("gains"), cacheRead("closures"), cacheRead("shares"), cacheRead("flow")
  ]);
  if (cycles) state.cycles = cycles;
  if (people) state.people = people;
  if (loans) state.loans = loans;
  if (transactions) state.transactions = transactions;
  if (arqueos) state.arqueos = arqueos;
  if (gains) state.gains = gains;
  if (closures) state.closures = closures;
  if (shares) state.shares = shares;
  if (flow) state.flow = flow;
  if (!state.selectedCycleId && state.cycles.length) state.selectedCycleId = state.cycles.find((cycle) => cycle.activo)?.id || state.cycles[0].id;
}

async function refreshData() {
  if (refreshPromise) return refreshPromise;
  if (!state.user || !isOnline()) return;
  refreshPromise = (async () => {
    state.loading = true;
    renderShell();
    try {
      const [cycles, people, loans, transactions, arqueos, gains, closures, shares] = await Promise.all([
        fetchAll("ciclos"), fetchAll("socios_y_clientes"), fetchAll("prestamos"), fetchAll("transacciones"),
        fetchAll("arqueos_semanales"), fetchAll("v_ganancias", "*", "ciclo_id"), fetchAll("cierres_ciclo"), fetchAll("reparto_utilidades")
      ]);
      state.cycles = cycles.sort((a,b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)));
      state.people = people.sort((a,b) => a.nombre.localeCompare(b.nombre, "es"));
      state.loans = loans;
      state.transactions = transactions.sort((a,b) => String(b.fecha_operacion).localeCompare(String(a.fecha_operacion)));
      state.arqueos = arqueos.sort((a,b) => String(b.fecha_sabado).localeCompare(String(a.fecha_sabado)));
      state.gains = gains;
      state.closures = closures;
      state.shares = shares;
      if (!state.selectedCycleId || !state.cycles.some((cycle) => cycle.id === state.selectedCycleId)) {
        state.selectedCycleId = state.cycles.find((cycle) => cycle.activo)?.id || state.cycles[0]?.id || null;
      }
      const cycle = selectedCycle();
      state.liquidity = null;
      state.expectedBalances = null;
      state.flow = [];
      if (cycle) {
        const { data: liquidity, error: liquidityError } = await supabase.rpc("liquidez_actual", { p_ciclo_id: cycle.id });
        if (!liquidityError) state.liquidity = liquidity;
        const saturday = expectedSaturday(cycle);
        if (saturday && saturday <= todayMx() && saturday <= cycle.fecha_fin) {
          const [cash, bank] = await Promise.all([
            supabase.rpc("fn_efectivo_disponible", { p_ciclo_id: cycle.id, p_fecha: saturday }),
            supabase.rpc("fn_saldo_transferencias", { p_ciclo_id: cycle.id, p_fecha: saturday })
          ]);
          if (!cash.error && !bank.error) state.expectedBalances = { efectivo: Number(cash.data), transferencias: Number(bank.data) };
        }
        const { data: flow, error: flowError } = await supabase.from("v_flujo_semanal").select("*").eq("ciclo_id", cycle.id).order("semana_sabado", { ascending: true });
        if (!flowError) state.flow = flow || [];
      }
      await Promise.all([
        cacheWrite("cycles", state.cycles), cacheWrite("people", state.people), cacheWrite("loans", state.loans),
        cacheWrite("transactions", state.transactions), cacheWrite("arqueos", state.arqueos), cacheWrite("gains", state.gains),
        cacheWrite("closures", state.closures), cacheWrite("shares", state.shares), cacheWrite("flow", state.flow)
      ]);
      state.refreshAt = new Date().toISOString();
    } catch (error) {
      toast(friendlyError(error), "error");
    } finally {
      state.loading = false;
      renderShell();
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function refreshExpectedAndFlow() {
  const cycle = selectedCycle();
  if (!cycle || !isOnline()) return;
  const saturday = expectedSaturday(cycle);
  if (saturday && saturday <= todayMx() && saturday <= cycle.fecha_fin) {
    const [cash, bank] = await Promise.all([
      supabase.rpc("fn_efectivo_disponible", { p_ciclo_id: cycle.id, p_fecha: saturday }),
      supabase.rpc("fn_saldo_transferencias", { p_ciclo_id: cycle.id, p_fecha: saturday })
    ]);
    if (!cash.error && !bank.error) state.expectedBalances = { efectivo: Number(cash.data), transferencias: Number(bank.data) };
  }
}

async function startSession(session) {
  state.session = session || null;
  state.user = session?.user || null;
  if (!session?.user) {
    resetData(); state.pending = []; state.selectedCycleId = null;
    renderLogin();
    return;
  }
  if (session.user.user_metadata?.must_change_password === true) {
    renderPasswordChange();
    return;
  }
  appScreen.classList.remove("hidden");
  authScreen.classList.add("hidden");
  await loadCachedData();
  await refreshPending();
  renderShell();
  if (isOnline()) {
    await refreshData();
    await syncQueue();
  }
}

async function submitLogin(form) {
  const data = new FormData(form);
  const email = String(data.get("email") || "").trim();
  const password = String(data.get("password") || "");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Entrando…";
  const { data: result, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) { renderLogin(error.message.toLowerCase().includes("invalid login credentials") ? "El correo o la contraseña no son correctos." : friendlyError(error)); return; }
  await startSession(result.session);
}

async function submitPasswordChange(form) {
  const data = new FormData(form);
  const password = String(data.get("password") || "");
  const confirm = String(data.get("confirm") || "");
  if (password.length < 10) { renderPasswordChange("La contraseña debe tener al menos 10 caracteres."); return; }
  if (password !== confirm) { renderPasswordChange("Las contraseñas no coinciden."); return; }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Guardando…";
  const metadata = state.user?.user_metadata || {};
  const { data: result, error } = await supabase.auth.updateUser({ password, data: { ...metadata, must_change_password: false } });
  if (error) { renderPasswordChange(friendlyError(error)); return; }
  state.user = result.user;
  state.session = { ...state.session, user: result.user };
  toast("Contraseña guardada. Ya puedes usar la aplicación.", "success");
  await startSession(state.session);
}

function validateSaturdayAndCycle(date, cycle, label = "La fecha") {
  if (!cycle) return "Primero crea o elige un ciclo abierto.";
  if (!date || !isSaturday(date)) return `${label} debe ser sábado.`;
  if (date > todayMx()) return `${label} no puede estar en el futuro.`;
  if (date < cycle.fecha_inicio || date > cycle.fecha_fin) return `${label} debe quedar dentro del ciclo abierto.`;
  const lastArqueo = state.arqueos.filter((row) => row.ciclo_id === cycle.id).sort((a,b) => String(b.fecha_sabado).localeCompare(String(a.fecha_sabado)))[0];
  if (lastArqueo && date <= lastArqueo.fecha_sabado) return "Ese sábado ya se cerró. Elige un sábado posterior al último cierre.";
  return "";
}

function personForKind(kind) {
  const person = document.querySelector("#movement-person");
  const loan = document.querySelector("#movement-loan");
  const personWrap = document.querySelector("#movement-person-wrap");
  const loanWrap = document.querySelector("#movement-loan-wrap");
  const needsPerson = ["ahorro_semanal", "abono_prestamo", "pago_multa"].includes(kind);
  personWrap?.classList.toggle("hidden", !needsPerson);
  loanWrap?.classList.toggle("hidden", kind !== "abono_prestamo");
  if (!needsPerson && person) person.value = "";
  if (kind === "ahorro_semanal" && person) person.innerHTML = `<option value="">Elige a un socio</option>${participantOptions("socio", "", true)}`;
  else if (person) person.innerHTML = `<option value="">Elige a una persona</option>${participantOptions()}`;
  if (kind === "abono_prestamo" && loan) {
    loan.innerHTML = `<option value="">Elige un préstamo</option>${openLoans().map((row) => `<option value="${h(row.id)}" data-person="${h(row.participante_id)}">${h(participantName(row.participante_id))} · pendiente ${money(loanBalance(row))}</option>`).join("")}`;
  }
}

async function saveMovement(form) {
  const data = new FormData(form);
  const cycle = selectedCycle();
  const kind = String(data.get("kind"));
  const date = String(data.get("date"));
  const amount = Number(data.get("amount"));
  const method = String(data.get("method"));
  const note = String(data.get("note") || "").trim() || null;
  let participantId = String(data.get("participant_id") || "") || null;
  let loanId = String(data.get("loan_id") || "") || null;
  const validation = validateSaturdayAndCycle(date, cycle, "La fecha del movimiento");
  if (validation) { toast(validation, "error"); return; }
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DB_AMOUNT || Math.round(amount * 100) !== amount * 100) { toast("Escribe un monto mayor a cero, dentro del límite permitido y con máximo dos decimales.", "error"); return; }
  if (note && note.length > 1000) { toast("La nota no puede tener más de 1,000 caracteres.", "error"); return; }
  if (kind === "abono_prestamo") {
    const loan = state.loans.find((row) => row.id === loanId);
    if (!loan) { toast("Elige un préstamo activo para registrar el abono.", "error"); return; }
    participantId = loan.participante_id;
    if (amount > loanBalance(loan) + 0.001) { toast("El abono es mayor que el saldo pendiente del préstamo.", "error"); return; }
  }
  if (["ahorro_semanal", "abono_prestamo", "pago_multa"].includes(kind) && !participantId) { toast("Elige a la persona relacionada con este movimiento.", "error"); return; }
  const person = state.people.find((row) => row.id === participantId);
  if (kind === "ahorro_semanal" && person?.tipo !== "socio") { toast("El ahorro semanal se registra para socios.", "error"); return; }
  if (["abono_prestamo"].includes(kind) && !loanId) { toast("Elige el préstamo al que corresponde el abono.", "error"); return; }
  const payload = {
    p_ciclo_id: cycle.id,
    p_tipo_movimiento: kind,
    p_monto: Number(amount.toFixed(2)),
    p_metodo_pago: method,
    p_fecha_operacion: date,
    p_participante_id: participantId,
    p_prestamo_id: loanId,
    p_nota: note,
    p_id: crypto.randomUUID()
  };
  const largeNote = amount >= LARGE_AMOUNT_CONFIRMATION ? "\n\nEl monto es alto. Revisa que no tenga un cero de más." : "";
  const deliveryNote = isOnline() ? "Se enviará ahora." : "Se guardará en este teléfono y se enviará al volver internet.";
  if (!window.confirm(`Confirma el movimiento:\n\n${movementLabels[kind]}: ${money(amount)}\nPersona: ${person ? person.nombre : "No aplica"}\nFecha: ${dateText(date)}\nPago: ${paymentLabels[method]}\n\n${deliveryNote}${largeNote}`)) return;
  const record = { id: payload.p_id, action: "movement", owner_id: state.user.id, payload, created_at: nextQueuedAt(), status: "pending", last_error: null };
  try { await storePut("queue", record); } catch (error) { toast(friendlyError(error), "error"); return; }
  await refreshPending();
  if (isOnline()) {
    await syncQueue();
    if (state.pending.some((item) => item.id === payload.p_id && item.status === "pending")) toast("La conexión se interrumpió. El movimiento quedó guardado con el mismo folio para volver a intentar.", "info");
  }
  else toast("Quedó guardado en este dispositivo y se enviará cuando vuelva internet.", "success");
}

async function syncQueue() {
  if (state.syncing || !isOnline() || !state.user) return;
  state.syncing = true;
  renderShell();
  let syncedCount = 0;
  try {
    let rows = (await storeGetAll("queue")).filter((item) => item.owner_id === state.user.id).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const item of rows) {
      if (item.status === "blocked") break;
      try {
        const { error } = await supabase.rpc(item.action === "loan" ? "crear_prestamo" : "registrar_transaccion", item.payload);
        if (error) throw error;
        await storeDelete("queue", item.id);
        syncedCount += 1;
      } catch (error) {
        if (isNetworkError(error)) {
          await storePut("queue", { ...item, status: "pending", last_error: error.message || String(error) });
          break;
        }
        await storePut("queue", { ...item, status: "blocked", last_error: error.message || String(error) });
        toast(`Un registro necesita revisión: ${friendlyError(error)}`, "error");
        break;
      }
    }
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    state.syncing = false;
    await refreshPending();
    if (syncedCount) toast(`${syncedCount} registro${syncedCount === 1 ? "" : "s"} sincronizado${syncedCount === 1 ? "" : "s"} correctamente.`, "success");
    if (isOnline()) await refreshData();
  }
}

async function createPerson(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const type = String(data.get("type"));
  const limit = Number(data.get("limit") || 0);
  if (!name) { toast("Escribe el nombre de la persona.", "error"); return; }
  if (limit < 0 || limit > MAX_DB_AMOUNT || !Number.isFinite(limit) || Math.round(limit * 100) !== limit * 100) { toast("El límite debe estar dentro del máximo permitido y tener hasta dos decimales.", "error"); return; }
  if (type === "externo" && limit >= LARGE_AMOUNT_CONFIRMATION && !window.confirm(`El límite elegido es ${money(limit)}. Revisa que esté bien capturado. ¿Guardar este límite?`)) return;
  if (!isOnline()) { toast("Conéctate para guardar una persona.", "error"); return; }
  const { error } = await supabase.from("socios_y_clientes").insert({ nombre: name, tipo: type, limite_credito: type === "externo" ? limit : 0 });
  if (error) { toast(friendlyError(error), "error"); return; }
  toast("Persona guardada.", "success"); form.reset();
  await refreshData();
}

async function createCycle(form) {
  if (!isOnline()) { toast("Conéctate para guardar un ciclo.", "error"); return; }
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const start = String(data.get("start"));
  const end = String(data.get("end"));
  const cash = Number(data.get("cash"));
  const bank = Number(data.get("bank"));
  const reserve = Number(data.get("reserve"));
  if (!name) { toast("Escribe un nombre para el ciclo.", "error"); return; }
  if (state.cycles.some((cycle) => cycle.activo)) { toast("Primero cierra el ciclo actual antes de abrir otro.", "error"); return; }
  if (!isSaturday(start) || !isSaturday(end)) { toast("El inicio y el cierre del ciclo deben ser sábados.", "error"); return; }
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (startDate.getUTCMonth() !== 11 || endDate.getUTCMonth() !== 10 || endDate.getUTCFullYear() !== startDate.getUTCFullYear() + 1) { toast("El ciclo debe comenzar en diciembre y terminar en noviembre del año siguiente.", "error"); return; }
  if (end < start) { toast("La fecha final debe ser posterior a la inicial.", "error"); return; }
  if ([cash, bank, reserve].some((value) => !Number.isFinite(value) || value < 0 || value > MAX_DB_AMOUNT || Math.round(value * 100) !== value * 100)) { toast("Los saldos iniciales y la reserva deben estar dentro del límite permitido y tener hasta dos decimales.", "error"); return; }
  const largeNote = Math.max(cash, bank, reserve) >= LARGE_AMOUNT_CONFIRMATION ? "\n\nHay un saldo alto. Revisa que las cifras estén bien capturadas." : "";
  if (!window.confirm(`Vas a abrir ${name} del ${dateText(start)} al ${dateText(end)}.\n\nInicio en caja: ${money(cash)}\nInicio en banco: ${money(bank)}\nReserva mínima: ${money(reserve)}${largeNote}\n\n¿Los datos son correctos?`)) return;
  const { data: created, error } = await supabase.from("ciclos").insert({ nombre: name, fecha_inicio: start, fecha_fin: end, saldo_inicial_efectivo: cash, saldo_inicial_transferencias: bank, reserva_minima: reserve }).select().single();
  if (error) { toast(friendlyError(error), "error"); return; }
  state.selectedCycleId = created.id; state.view = "inicio";
  toast("Ciclo creado.", "success");
  await refreshData();
}

async function createLoan(form) {
  if (!isOnline()) { toast("Conéctate para confirmar el préstamo. No se guarda sin internet.", "error"); return; }
  const cycle = selectedCycle();
  const data = new FormData(form);
  const participantId = String(data.get("participant_id") || "");
  const capital = Number(data.get("capital"));
  const weeks = Number(data.get("weeks"));
  const date = String(data.get("date"));
  const method = String(data.get("method"));
  const note = String(data.get("note") || "").trim() || null;
  const validation = validateSaturdayAndCycle(date, cycle, "La fecha de entrega");
  if (validation) { toast(validation, "error"); return; }
  if (!participantId) { toast("Elige a la persona que recibirá el préstamo.", "error"); return; }
  const participant = state.people.find((person) => person.id === participantId);
  if (!participant || participant.estatus !== "activo") { toast("Solo las personas activas pueden recibir un préstamo.", "error"); return; }
  if (!Number.isFinite(capital) || capital <= 0 || capital > MAX_DB_AMOUNT || Math.round(capital * 100) !== capital * 100) { toast("El capital debe estar dentro del límite permitido y tener hasta dos decimales.", "error"); return; }
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) { toast("El plazo debe estar entre una y 52 semanas.", "error"); return; }
  if (addDays(date, weeks * 7) > cycle.fecha_fin) { toast(`Con ese plazo, el vencimiento quedaría después del cierre del ciclo (${dateText(cycle.fecha_fin)}). Reduce las semanas o elige otra fecha.`, "error"); return; }
  if (participant.tipo === "externo") {
    const outstandingCapital = state.loans.filter((loan) => loan.participante_id === participant.id && loan.estado === "activo").reduce((sum, loan) => sum + loanCapitalBalance(loan), 0);
    if (outstandingCapital + capital > Number(participant.limite_credito || 0)) { toast(`Este préstamo rebasaría el límite de ${money(participant.limite_credito)} para esta persona.`, "error"); return; }
  }
  if (note && note.length > 1000) { toast("La nota no puede tener más de 1,000 caracteres.", "error"); return; }
  const payload = {
    p_ciclo_id: cycle.id,
    p_participante_id: participantId,
    p_capital: Number(capital.toFixed(2)),
    p_plazo_semanas: weeks,
    p_fecha_desembolso: date,
    p_metodo_pago: method,
    p_id: crypto.randomUUID(),
    p_nota: note
  };
  const interest = Math.round(capital * 0.05 * 100) / 100;
  const largeNote = capital >= LARGE_AMOUNT_CONFIRMATION ? "\n\nEl capital es alto. Revisa que no tenga un cero de más." : "";
  if (!window.confirm(`Confirma el préstamo:\n\nPersona: ${participantName(participantId)}\nCapital: ${money(capital)}\nInterés fijo 5%: ${money(interest)}\nTotal a devolver: ${money(capital + interest)}\nPlazo: ${weeks} semanas\nEntrega: ${dateText(date)}\n\nEsta operación se confirmará en línea y conservará el mismo folio si falla la respuesta.${largeNote}`)) return;
  const record = { id: payload.p_id, action: "loan", owner_id: state.user.id, payload, created_at: nextQueuedAt(), status: "pending", last_error: null };
  try { await storePut("queue", record); } catch (error) { toast(friendlyError(error), "error"); return; }
  await refreshPending();
  await syncQueue();
  if (state.pending.some((item) => item.id === payload.p_id && item.status === "pending")) toast("No se confirmó la respuesta de la red. El préstamo quedó guardado con el mismo folio para volver a intentar.", "info");
}

async function cancelTransaction(id) {
  if (!isOnline()) { toast("Conéctate para anular un movimiento y guardar la explicación.", "error"); return; }
  const transaction = state.transactions.find((row) => row.id === id);
  if (!transaction || transaction.anulado) return;
  const reason = window.prompt("¿Por qué se anula este movimiento? Escribe al menos cinco caracteres.");
  if (reason === null) return;
  if (reason.trim().length < 5) { toast("La explicación debe tener al menos cinco caracteres.", "error"); return; }
  const { error } = await supabase.rpc("anular_transaccion", { p_transaccion_id: id, p_motivo: reason.trim() });
  if (error) { toast(friendlyError(error), "error"); return; }
  toast("Movimiento anulado y guardado en la bitácora.", "success");
  await refreshData();
}

async function closeSaturday(form) {
  if (!isOnline()) { toast("Conéctate para guardar el cierre del sábado.", "error"); return; }
  const cycle = selectedCycle();
  const saturday = expectedSaturday(cycle);
  const data = new FormData(form);
  const cash = Number(data.get("cash"));
  const bank = Number(data.get("bank"));
  const note = String(data.get("note") || "").trim() || null;
  if (!cycle?.activo || !saturday) { toast("Elige un ciclo abierto.", "error"); return; }
  if (saturday > todayMx()) { toast("El sábado que sigue todavía no llega.", "error"); return; }
  if (!isSaturday(saturday) || saturday < cycle.fecha_inicio || saturday > cycle.fecha_fin) { toast("Revisa las fechas y el orden del ciclo.", "error"); return; }
  const unsynced = state.pending.filter((item) => item.payload.p_ciclo_id === cycle.id && queuedDate(item) <= saturday);
  if (unsynced.length) { toast(`Hay ${unsynced.length} registro${unsynced.length === 1 ? "" : "s"} pendiente${unsynced.length === 1 ? "" : "s"} de enviar hasta este sábado. Sincronízalos o revísalos antes de cerrar.`, "error"); return; }
  if ([cash, bank].some((value) => !Number.isFinite(value) || value < 0 || value > MAX_DB_AMOUNT || Math.round(value * 100) !== value * 100)) { toast("Los saldos deben estar dentro del límite permitido y tener máximo dos decimales.", "error"); return; }
  if (note && note.length > 1000) { toast("La nota no puede tener más de 1,000 caracteres.", "error"); return; }
  const expected = state.expectedBalances;
  if (expected && (Math.abs(cash - expected.efectivo) > 10 || Math.abs(bank - expected.transferencias) > 10) && (!note || note.length < 5)) { toast("La diferencia supera $10. Escribe una explicación de al menos cinco caracteres.", "error"); return; }
  const largeNote = Math.max(cash, bank) >= LARGE_AMOUNT_CONFIRMATION ? "\n\nEl saldo es alto. Confirma que las cifras estén bien capturadas." : "";
  if (!window.confirm(`Vas a cerrar el sábado ${dateText(saturday)}.\n\nEfectivo contado: ${money(cash)}\nSaldo bancario real: ${money(bank)}${expected ? `\nEfectivo esperado: ${money(expected.efectivo)}\nBanco esperado: ${money(expected.transferencias)}` : ""}${note ? `\nNota: ${note}` : ""}\n\nEl cierre quedará registrado y no se puede borrar.${largeNote}\n\n¿Confirmas estos saldos?`)) return;
  const { error } = await supabase.rpc("cerrar_arqueo", { p_ciclo_id: cycle.id, p_fecha_sabado: saturday, p_efectivo_fisico_real: Number(cash.toFixed(2)), p_saldo_banco_real: Number(bank.toFixed(2)), p_nota_ajuste: note });
  if (error) { toast(friendlyError(error), "error"); return; }
  toast("Cierre del sábado guardado.", "success");
  await refreshData();
}

async function closeCycle() {
  if (state.actionBusy) return;
  state.actionBusy = true;
  try {
  const cycle = selectedCycle();
  if (!cycle?.activo) return;
  if (!isOnline()) { toast("Conéctate para cerrar el ciclo.", "error"); return; }
  const pendingForCycle = state.pending.filter((item) => item.payload.p_ciclo_id === cycle.id);
  if (pendingForCycle.length) { toast(`Hay ${pendingForCycle.length} registro${pendingForCycle.length === 1 ? "" : "s"} pendiente${pendingForCycle.length === 1 ? "" : "s"} en este dispositivo. Sincroniza o revisa eso antes de cerrar el ciclo.`, "error"); state.view = "movimientos"; renderShell(); return; }
  const lastArqueo = state.arqueos.filter((row) => row.ciclo_id === cycle.id).sort((a,b) => String(b.fecha_sabado).localeCompare(String(a.fecha_sabado)))[0];
  if (lastArqueo?.fecha_sabado !== cycle.fecha_fin) { toast("Antes de cerrar el ciclo, cierra el último sábado del período.", "error"); state.view = "sabado"; renderShell(); return; }
  const unpaidLoans = state.loans.filter((loan) => loan.ciclo_id === cycle.id && loan.estado === "activo" && loanBalance(loan) > 0.01);
  if (unpaidLoans.length) { toast(`Quedan ${unpaidLoans.length} préstamo${unpaidLoans.length === 1 ? "" : "s"} por cobrar. Registra los abonos antes del cierre.`, "error"); state.view = "prestamos"; renderShell(); return; }
  const savings = state.transactions.filter((tx) => tx.ciclo_id === cycle.id && tx.tipo_movimiento === "ahorro_semanal" && !tx.anulado).reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
  if (savings <= 0) { toast("Este ciclo no tiene ahorro positivo para calcular el reparto.", "error"); return; }
  if (!window.confirm(`Vas a cerrar “${cycle.nombre}” y calcular el reparto proporcional. Esta acción no se puede deshacer. ¿Continuar?`)) return;
  const { error } = await supabase.rpc("cerrar_ciclo", { p_ciclo_id: cycle.id });
  if (error) { toast(friendlyError(error), "error"); return; }
  toast("Ciclo cerrado y reparto calculado.", "success");
  await refreshData();
  state.view = "sabado"; renderShell();
  } finally {
    state.actionBusy = false;
    if (state.session) renderShell();
  }
}

async function logout() {
  if (queueCount() && !window.confirm(`Hay ${queueCount()} registro${queueCount() === 1 ? "" : "s"} sin enviar. Seguirán guardados en este teléfono; vuelve a entrar con la misma cuenta para sincronizarlos. ¿Quieres salir?`)) return;
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) { toast("No se pudo cerrar la sesión en este dispositivo. Intenta otra vez.", "error"); return; }
  await startSession(null);
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "navigate") { state.view = button.dataset.view || "inicio"; renderShell(); if (state.view === "sabado") refreshExpectedAndFlow().then(renderShell); return; }
  if (action === "logout") { logout(); return; }
  if (action === "sync") { syncQueue(); return; }
  if (action === "cancel-tx") { cancelTransaction(button.dataset.id); return; }
  if (action === "close-cycle") { closeCycle(); return; }
  if (action === "whatsapp") { const person = state.people.find((row) => row.id === button.dataset.person); if (person) whatsappLink(person, Number(button.dataset.amount)); return; }
  if (action === "select-cycle") { state.selectedCycleId = button.dataset.id; state.view = "inicio"; refreshData(); return; }
  if (action === "discard-queue") {
    if (!window.confirm("¿Quitar este movimiento guardado de este dispositivo? No se enviará al servidor.")) return;
    storeDelete("queue", button.dataset.id).then(refreshPending); return;
  }
  if (action === "retry-queue") {
    storeGetAll("queue").then((rows) => rows.find((row) => row.id === button.dataset.id)).then((row) => row && storePut("queue", { ...row, status: "pending", last_error: null })).then(syncQueue); return;
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.dataset.busy === "true") return;
  if (state.syncing && !["login-form", "password-form"].includes(form.id)) { toast("Espera a que termine la sincronización antes de guardar otra cosa.", "info"); return; }
  form.dataset.busy = "true";
  const button = form.querySelector("button[type=submit]");
  const oldLabel = button?.textContent || "Guardar";
  const busyLabel = form.id === "login-form" ? "Entrando…" : form.id === "loan-form" ? "Confirmando préstamo…" : form.id === "close-week-form" ? "Guardando cierre…" : "Guardando…";
  if (button) { button.disabled = true; button.textContent = busyLabel; }
  try {
    if (form.id === "login-form") await submitLogin(form);
    else if (form.id === "password-form") await submitPasswordChange(form);
    else if (form.id === "movement-form") await saveMovement(form);
    else if (form.id === "person-form") await createPerson(form);
    else if (form.id === "cycle-form") await createCycle(form);
    else if (form.id === "loan-form") await createLoan(form);
    else if (form.id === "close-week-form") await closeSaturday(form);
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    if (form.isConnected) {
      form.dataset.busy = "false";
      if (button?.isConnected) { button.disabled = false; button.textContent = oldLabel; }
    }
  }
}

appScreen.addEventListener("click", handleClick);
appScreen.addEventListener("submit", handleSubmit);
authScreen.addEventListener("click", handleClick);
authScreen.addEventListener("submit", handleSubmit);
appScreen.addEventListener("change", (event) => {
  if (event.target.matches("#movement-kind")) personForKind(event.target.value);
  if (event.target.matches("#movement-loan")) {
    const chosen = event.target.selectedOptions[0]?.dataset.person;
    const person = document.querySelector("#movement-person");
    if (person && chosen) person.value = chosen;
  }
  if (event.target.matches("#cycle-picker, #cycle-picker-mobile")) { state.selectedCycleId = event.target.value; refreshData(); }
});

window.addEventListener("online", () => { renderShell(); if (state.user) syncQueue(); });
window.addEventListener("offline", () => renderShell());
window.addEventListener("focus", () => { if (state.user && isOnline()) refreshData(); });
window.addEventListener("storage", () => { if (state.user) refreshPending(); });

supabase.auth.onAuthStateChange((_event, session) => {
  queueMicrotask(() => {
    if (session?.user?.id !== state.user?.id || !session) startSession(session);
    else { state.session = session; state.user = session.user; }
  });
});

async function initialize() {
  const { data: initial } = await supabase.auth.getSession();
  await startSession(initial.session);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

initialize();
