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
  inicio: "Resumen", alertas: "Pendientes", movimientos: "Movimientos",
  ingresos: "Ingreso a caja", personas: "Contactos", prestamos: "Préstamos", sabado: "Cerrar sábado"
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
  syncing: false, actionBusy: false, refreshAt: null, menuOpen: false,
  selectedPersonId: null, personSearch: "", selectedStatementMonth: "", statementPersonId: null, selectedLoanForPayment: null,
  showMovementForm: false, loanPersonChoice: "", contactPhones: {}
};

const DB_NAME = "mi-caja-offline-v1";
const DB_VERSION = 2;
let dbPromise;
let refreshPromise;
let cancellingTransaction = false;

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

function isDefinitiveServerRejection(error) {
  const code = String(error?.code || "");
  const status = Number(error?.status || error?.statusCode || 0);
  return /^[A-Z0-9]{5}$/.test(code) || (status >= 400 && status < 500);
}

function friendlyError(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  if (lower.includes("p_id ya fue usado")) return "Este folio ya se usó con otros datos. El movimiento original se conserva para evitar duplicarlo.";
  if (lower.includes("no autenticado") || lower.includes("jwt expired")) return "Tu sesión terminó. Vuelve a entrar para continuar.";
  if (lower.includes("debe ser sabado") || lower.includes("debe ser sábado")) return "Elige un sábado para la fecha del movimiento.";
  if (lower.includes("no se permiten operaciones futuras") || lower.includes("sabado futuro") || lower.includes("sábado futuro")) return "No puedes registrar una fecha futura.";
  if (lower.includes("fecha queda fuera del ciclo") || lower.includes("fuera del ciclo")) return "La fecha debe quedar dentro de la caja abierta.";
  if (lower.includes("periodo ya fue cerrado") || lower.includes("período ya fue cerrado")) return "Ese sábado ya se cerró. Elige una fecha que siga abierta.";
  if (lower.includes("arqueo debe ser secuencial") || lower.includes("arqueo debe ser secuencial")) return "Debes cerrar los sábados en orden. Revisa cuál fecha sigue.";
  if (lower.includes("requiere nota de ajuste")) return "La diferencia supera $10. Escribe una explicación de al menos cinco caracteres.";
  if (lower.includes("excede el saldo pendiente")) return "El abono es mayor que lo que falta por pagar.";
  if (lower.includes("saldo negativo") || lower.includes("saldos no pueden ser negativos")) return "Este movimiento dejaría el dinero disponible por debajo de cero.";
  if (lower.includes("el monto debe ser mayor") || lower.includes("maximo dos decimales") || lower.includes("máximo dos decimales")) return "Revisa que el monto sea mayor que cero y tenga máximo dos decimales.";
  if (lower.includes("metodo de pago invalido") || lower.includes("método de pago inválido")) return "Elige efectivo o transferencia como forma de pago.";
  if (lower.includes("vencimiento excede") || lower.includes("fecha final del ciclo")) return "El pago de este préstamo quedaría después de la entrega de la caja. Elige otra fecha.";
  if (lower.includes("limite de credito") || lower.includes("límite de crédito")) return "El préstamo supera el límite de crédito de esta persona.";
  if (lower.includes("vulneraria reserva") || lower.includes("vulneraría reserva")) return "El préstamo dejaría menos dinero que la reserva mínima.";
  if (lower.includes("solo participantes activos")) return "Solo las personas activas pueden recibir un préstamo.";
  if (lower.includes("no se cierra el ciclo con prestamos") || lower.includes("préstamos cuyo saldo")) return "Aún quedan préstamos por cobrar. Registra los abonos antes de entregar la caja.";
  if (lower.includes("ultimo sabado del ciclo") || lower.includes("último sábado del ciclo")) return "Primero debes cerrar el último sábado de la temporada.";
  if (lower.includes("no hay ahorro positivo")) return "Aún no hay aportaciones para calcular las ganancias de esta temporada.";
  if (lower.includes("duplicate key") || lower.includes("ex_ciclos_sin_traslape")) return "Ese período se cruza con otra caja que ya existe.";
  if (lower.includes("permission denied") || lower.includes("row-level security") || lower.includes("rls")) return "Esta cuenta no tiene permiso para ese cambio. Vuelve a entrar con la cuenta administradora.";
  if (lower.includes("foreign key") || lower.includes("violates check") || lower.includes("not-null") || lower.includes("null value")) return "Algún dato no coincide con las reglas de la caja. Revisa la persona, el préstamo y la fecha.";
  if (isNetworkError(error)) return "No hay conexión con internet. El movimiento se quedará guardado para sincronizarse.";
  return "No se pudo guardar. Revisa que los datos estén completos, que la caja siga abierta y vuelve a intentar.";
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
        if (!database.objectStoreNames.contains("contact_phones")) database.createObjectStore("contact_phones", { keyPath: "key" });
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

function phoneKey(personId) { return `${state.user?.id || "signed-out"}:${personId}`; }

async function saveContactPhone(personId, phone) {
  const clean = String(phone || "").replace(/\D/g, "");
  if (!clean) return;
  await storePut("contact_phones", { key: phoneKey(personId), phone: clean });
  state.contactPhones[personId] = clean;
}

async function loadContactPhones() {
  try {
    const prefix = `${state.user?.id || "signed-out"}:`;
    state.contactPhones = Object.fromEntries((await storeGetAll("contact_phones"))
      .filter((row) => row.key.startsWith(prefix)).map((row) => [row.key.slice(prefix.length), row.phone]));
  } catch { state.contactPhones = {}; }
}

async function getContactPhone(personId) {
  try {
    const database = await db();
    return await new Promise((resolve, reject) => {
      const request = database.transaction("contact_phones", "readonly").objectStore("contact_phones").get(phoneKey(personId));
      request.onsuccess = () => resolve(request.result?.phone || "");
      request.onerror = () => reject(request.error);
    });
  } catch { return ""; }
}

function firstName(user = state.user) {
  const fromMetadata = String(user?.user_metadata?.full_name || user?.user_metadata?.name || "").trim();
  const fromEmail = String(user?.email?.split("@")[0] || "").replace(/\d.*$/, "");
  const first = (fromMetadata || fromEmail).split(/[\s._-]+/)[0] || "";
  return first ? first[0].toLocaleUpperCase("es") + first.slice(1) : "";
}

function loanInterestBalance(loan) {
  const paid = state.transactions.filter((tx) => tx.prestamo_id === loan.id && tx.tipo_movimiento === "abono_prestamo" && !tx.anulado)
    .reduce((sum, tx) => sum + Number(tx.interes_aplicado || 0), 0);
  return Math.max(0, Number(loan.interes_total || 0) - paid);
}

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
      .sort((a, b) => String(queuedDate(a)).localeCompare(String(queuedDate(b))) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
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
          <div><h1 class="text-2xl font-extrabold text-ink">Mi Caja</h1></div>
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
        <div class="mb-8 flex items-center gap-3"><img src="./icon.svg" class="h-12 w-12 rounded-2xl" alt="" /><div><h1 class="text-2xl font-extrabold">Mi Caja</h1></div></div>
        <div class="card p-6 sm:p-8">
          <span class="badge badge-amber">Paso necesario</span>
          <h2 class="mt-4 text-2xl font-extrabold">Crea tu contraseña personal</h2>
          <p class="mt-2 text-sm leading-6 text-slate-500">Antes de entrar, cambia la contraseña temporal por una que solo tú conozcas.</p>
          ${message ? `<div class="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">${h(message)}</div>` : ""}
          <form id="password-form" class="mt-6 space-y-4">
            <label class="field-label">Contraseña temporal actual<input class="field" name="current" type="password" autocomplete="current-password" required /></label>
            <label class="field-label">Nueva contraseña<input class="field" name="password" type="password" autocomplete="new-password" minlength="10" required placeholder="Al menos 10 caracteres" /></label>
            <label class="field-label">Repite la contraseña nueva<input class="field" name="confirm" type="password" autocomplete="new-password" minlength="10" required /></label>
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
    message: '<path d="M21 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20l1.1-4.2A8.5 8.5 0 1 1 21 11.5Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.home}</svg>`;
}

function selectedCycle() {
  const available = state.cycles.filter((cycle) => cycle.activo);
  return available.find((cycle) => cycle.id === state.selectedCycleId) || available[0] || state.cycles[0] || null;
}

function cycleName(cycle) { return cycle?.nombre || "Sin caja"; }
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

function queueErrorText(item) {
  if (/p_id ya fue usado/i.test(String(item.last_error || ""))) return "El servidor ya tiene este folio con otros datos. No lo reenvíes ni lo quites del teléfono; revisa el historial antes de continuar.";
  if (item.status !== "blocked" && item.last_error) return "No se confirmó el resultado por la conexión. Se reintentará con el mismo folio y los mismos datos para evitar duplicados.";
  return friendlyError(item.last_error);
}

function renderQueueEntry(item) {
  const payload = item.payload;
  const blocked = item.status === "blocked";
  const conflict = /p_id ya fue usado/i.test(String(item.last_error || ""));
  const cycleLoans = state.loans.filter((loan) => loan.ciclo_id === payload.p_ciclo_id);
  const selectedLoan = cycleLoans.find((loan) => loan.id === payload.p_prestamo_id);
  const loanOptions = cycleLoans.map((loan) => `<option value="${h(loan.id)}" data-person="${h(loan.participante_id)}" ${loan.id === payload.p_prestamo_id ? "selected" : ""}>${h(participantName(loan.participante_id))} · ${money(loanBalance(loan))} pendiente</option>`).join("");
  const selectedPerson = state.people.find((person) => person.id === payload.p_participante_id) || state.people.find((person) => person.id === selectedLoan?.participante_id);
  const peopleOptions = activePeople().map((person) => `<option value="${h(person.id)}" ${person.id === selectedPerson?.id ? "selected" : ""}>${h(person.nombre)} · ${person.tipo === "socio" ? "socio" : "externo"}</option>`).join("");
  const movementOptions = ["ahorro_semanal", "abono_prestamo", "pago_multa", "retiro_caja", "gasto", "ajuste_ingreso", "ajuste_egreso"].map((kind) => `<option value="${kind}" ${kind === payload.p_tipo_movimiento ? "selected" : ""}>${movementLabels[kind]}</option>`).join("");
  const correction = !blocked || conflict ? "" : item.action === "loan" ? `
    <details class="mt-3 rounded-xl bg-slate-50 p-3"><summary class="cursor-pointer text-sm font-bold text-teal-800">Corregir datos y reenviar</summary>
      <form class="mt-3 grid gap-3" data-queue-correction="${h(item.id)}">
        <label class="field-label">Persona<select class="field" name="participant_id" required>${peopleOptions}</select></label>
        <label class="field-label">Capital<input class="field" name="capital" type="number" inputmode="decimal" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" value="${h(payload.p_capital)}" required /></label>
        <label class="field-label">Fecha de entrega<input class="field" name="date" type="date" max="${todayMx()}" value="${h(payload.p_fecha_desembolso)}" required /></label>
        <label class="field-label">Forma de pago<select class="field" name="method" required><option value="efectivo" ${payload.p_metodo_pago === "efectivo" ? "selected" : ""}>Efectivo</option><option value="transferencia" ${payload.p_metodo_pago === "transferencia" ? "selected" : ""}>Transferencia</option></select></label>
        <label class="field-label">Nota<input class="field" name="note" maxlength="1000" value="${h(payload.p_nota || "")}" /></label>
        <p class="text-xs leading-5 text-slate-500">El pago debe quedar liquidado antes de entregar la caja. El folio se conservará.</p>
        <button class="btn-primary w-full" type="submit">Guardar corrección y reenviar</button>
      </form>
    </details>` : `
    <details class="mt-3 rounded-xl bg-slate-50 p-3"><summary class="cursor-pointer text-sm font-bold text-teal-800">Corregir datos y reenviar</summary>
      <form class="mt-3 grid gap-3" data-queue-correction="${h(item.id)}">
        <label class="field-label">Tipo de movimiento<select class="field" name="kind" required>${movementOptions}</select></label>
        <label class="field-label">Persona<select class="field" name="participant_id"><option value="">No aplica</option>${peopleOptions}</select></label>
        <label class="field-label">Préstamo relacionado<select class="field" name="loan_id"><option value="">No aplica</option>${loanOptions}</select></label>
        <label class="field-label">Monto<input class="field" name="amount" type="number" inputmode="decimal" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" value="${h(payload.p_monto)}" required /></label>
        <label class="field-label">Fecha<input class="field" name="date" type="date" max="${todayMx()}" value="${h(payload.p_fecha_operacion)}" required /></label>
        <label class="field-label">Forma de pago<select class="field" name="method" required><option value="efectivo" ${payload.p_metodo_pago === "efectivo" ? "selected" : ""}>Efectivo</option><option value="transferencia" ${payload.p_metodo_pago === "transferencia" ? "selected" : ""}>Transferencia</option></select></label>
        <label class="field-label">Nota<input class="field" name="note" maxlength="1000" value="${h(payload.p_nota || "")}" /></label>
        <p class="text-xs leading-5 text-slate-500">El folio se conservará. Si eliges un abono, selecciona también el préstamo correcto. Los datos se vuelven a validar antes de enviarse.</p>
        <button class="btn-primary w-full" type="submit">Guardar corrección y reenviar</button>
      </form>
    </details>`;
  const actions = blocked ? `<div class="mt-2 flex flex-wrap gap-2">${conflict ? "" : `<button class="btn-quiet px-2 py-1 text-xs" data-action="retry-queue" data-id="${h(item.id)}">Reintentar igual</button><button class="btn-quiet px-2 py-1 text-xs text-rose-700" data-action="discard-queue" data-id="${h(item.id)}">Descartar del teléfono</button>`}</div>${correction}` : `<p class="mt-2 text-xs text-slate-500">Se volverá a enviar automáticamente al recuperar conexión.</p>`;
  return `<article class="rounded-xl border ${blocked ? "border-rose-200 bg-rose-50/40" : "border-slate-100"} p-3"><div class="flex items-start justify-between gap-2"><div><p class="text-sm font-bold">${h(queuedLabel(item))}</p><p class="text-xs text-slate-500">${dateText(queuedDate(item))} · ${money(queuedAmount(item))}</p><p class="mt-1 text-[11px] text-slate-400">Folio: ${h(payload.p_id)}</p></div><span class="badge ${blocked ? "badge-red" : "badge-amber"}">${blocked ? "Falló · requiere revisión" : "En espera"}</span></div>${item.last_error ? `<p class="mt-2 text-sm ${blocked ? "font-semibold text-rose-800" : "text-amber-800"}">${h(queueErrorText(item))}</p>` : ""}${actions}</article>`;
}

function renderShell() {
  if (!state.session || !state.user) return;
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  const cycleOptions = state.cycles.filter((cycle) => cycle.activo).map((cycle) => `<option value="${h(cycle.id)}" ${cycle.id === selectedCycle()?.id ? "selected" : ""}>${h(cycle.nombre)}</option>`).join("");
  const icons = { inicio: "home", alertas: "calendar", movimientos: "list", ingresos: "plus", personas: "people", prestamos: "wallet", sabado: "calendar" };
  const nav = Object.entries(viewNames).map(([key, label]) => `<button class="nav-item ${state.view === key ? "active" : ""}" data-action="navigate" data-view="${key}">${icon(icons[key])}<span>${label}</span></button>`).join("");
  const networkStatus = isOnline() ? `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">${icon("wifi", 16)} Con internet</span>` : `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">${icon("wifi", 16)} Sin internet</span>`;
  const pending = queueCount();
  const greeting = `Hola, ${h(firstName())}, bienvenido, ¿qué quieres hacer hoy?`;
  const top = `
    <header class="sticky top-0 z-30 border-b border-slate-100 bg-sand-50/95 backdrop-blur safe-top">
      <div class="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div class="flex items-center gap-2.5"><button class="btn-quiet -ml-2" data-action="toggle-menu" aria-label="Abrir menú">${icon("menu", 21)}</button><img src="./icon.svg" class="h-10 w-10 rounded-xl" alt="" /><p class="text-lg font-extrabold leading-5">Mi Caja</p></div>
        <div class="flex items-center gap-3">
          <div class="hidden items-center gap-3 sm:flex">${networkStatus}${pending ? `<span class="badge badge-amber">${pending} pendiente${pending === 1 ? "" : "s"}</span>` : ""}</div>
          <button data-action="sync" class="btn-quiet" aria-label="Sincronizar pendientes" ${!isOnline() || state.syncing ? "disabled" : ""}>${icon("refresh", 17)}</button>
        </div>
      </div>
    </header>`;
  const drawer = state.menuOpen ? `<div class="fixed inset-0 z-50 bg-slate-900/30" data-drawer-backdrop><aside class="safe-top safe-bottom h-full w-[min(88vw,390px)] overflow-y-auto bg-white p-5 shadow-2xl" data-drawer="true">
    <div class="flex items-center justify-between"><h2 class="text-xl font-extrabold">Menú</h2><button class="btn-quiet" data-action="close-menu" aria-label="Cerrar menú">Cerrar</button></div>
    <p class="mt-1 break-all text-sm text-slate-500">${h(state.user.email || "Cuenta activa")}</p>
    <div class="mt-4 rounded-xl bg-slate-50 p-3"><label class="field-label" for="cycle-picker">Temporada abierta</label><select id="cycle-picker" class="field" ${!cycleOptions ? "disabled" : ""}>${cycleOptions || '<option>Sin temporada abierta</option>'}</select></div>
    <nav class="mt-4 space-y-1">${nav}</nav>
    <section class="mt-5 rounded-2xl border border-slate-100 p-4"><h3 class="font-extrabold">Tu cuenta</h3><form id="profile-password-form" class="mt-3 space-y-3"><label class="field-label">Contraseña actual<input class="field" name="current" type="password" autocomplete="current-password" required /></label><label class="field-label">Nueva contraseña<input class="field" name="password" type="password" autocomplete="new-password" minlength="10" required /></label><label class="field-label">Repite la nueva contraseña<input class="field" name="confirm" type="password" autocomplete="new-password" minlength="10" required /></label><button class="btn-secondary w-full" type="submit">Cambiar contraseña</button></form><button data-action="logout" class="btn-quiet mt-2 w-full text-rose-700">${icon("logout", 17)} Cerrar sesión</button></section>
    ${renderYearHistory()}
    <button class="btn-quiet mt-3 w-full" data-action="close-menu">Cerrar menú</button>
  </aside></div>` : "";
  const page = `
    <div class="mx-auto min-h-[calc(100vh-66px)] max-w-7xl">
      <main class="min-w-0 px-4 pb-28 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pb-10">
        <div class="mb-5 flex flex-wrap items-start justify-between gap-3"><div><p class="text-sm text-slate-500">${greeting}</p><h1 class="mt-1 text-xl font-extrabold sm:text-2xl">${viewNames[state.view]}</h1></div>${networkStatus}</div>
        ${!isOnline() && state.view !== "inicio" ? `<div class="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Estás sin internet. Puedes anotar ahorros y abonos; se enviarán en el mismo orden cuando vuelva la conexión.</div>` : ""}
      ${pending && state.view !== "inicio" ? `<div class="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"><p class="text-sm text-amber-900"><strong>${pending} registro${pending === 1 ? "" : "s"}</strong> ${state.pending.some((row) => row.status === "blocked") ? "esperando revisión" : "guardado"} en este dispositivo.</p><button data-action="sync" class="btn-secondary px-3 py-2" ${!isOnline() || state.syncing ? "disabled" : ""}>${icon("refresh", 16)} Enviar</button></div>` : ""}
        <section id="view-content">${renderView()}</section>
      </main>
      <nav class="safe-bottom fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-slate-100 bg-white/95 px-1 pt-2 backdrop-blur lg:hidden">${["inicio", "alertas", "personas", "prestamos"].map((key) => `<button data-action="navigate" data-view="${key}" class="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-xs font-bold ${state.view === key ? "text-teal-700" : "text-slate-500"}">${icon(icons[key],19)}<span>${viewNames[key]}</span></button>`).join("")}<button data-action="toggle-menu" class="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-xs font-bold text-slate-500">${icon("menu",19)}<span>Más</span></button></nav>
    </div>`;
  appScreen.innerHTML = `${top}${page}${drawer}`;
}

function renderYearHistory() {
  const groups = new Map();
  for (const cycle of state.cycles) {
    const year = String(cycle.fecha_inicio || "").slice(0, 4) || "Otros";
    const gain = Number(state.gains.find((row) => row.ciclo_id === cycle.id)?.utilidad_neta || 0);
    const group = groups.get(year) || { count: 0, gains: 0, entries: [] };
    group.count += 1; group.gains += gain; group.entries.push({ cycle, gain }); groups.set(year, group);
  }
  const ascending = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const previousGains = new Map();
  ascending.forEach(([year, group], index) => previousGains.set(year, index ? group.gains - ascending[index - 1][1].gains : null));
  const years = ascending.reverse();
  const totalCount = state.cycles.length;
  return `<section class="mt-5 rounded-2xl border border-slate-100 p-4"><h3 class="font-extrabold">Historial de tus cajas</h3><p class="mt-1 text-sm text-slate-500">${totalCount} caja${totalCount === 1 ? "" : "s"} en total</p>${years.length ? years.map(([year, group]) => { const change = previousGains.get(year); const trend = change === null ? "" : change > 0 ? ` · subieron ${money(change)} vs. la caja anterior` : change < 0 ? ` · bajaron ${money(Math.abs(change))} vs. la caja anterior` : " · igual que la caja anterior"; return `<div class="mt-3 border-t border-slate-100 pt-3"><div class="flex justify-between gap-3"><p class="font-semibold">${h(year)} · ${group.count} caja${group.count === 1 ? "" : "s"}</p><p class="font-bold">${money(group.gains)}</p></div><p class="mt-1 text-xs text-slate-500">Ganancias ${trend}</p>${group.entries.map(({ cycle, gain }) => `<p class="mt-1 text-xs text-slate-500">${h(cycle.nombre)} · ${money(gain)} ganancias · ${cycle.activo ? "abierta" : "entregada"}</p>`).join("")}</div>`; }).join("") : `<p class="mt-2 text-sm text-slate-500">Tus temporadas cerradas aparecerán aquí.</p>`}<button class="btn-secondary mt-4 w-full" data-action="navigate" data-view="sabado">Cerrar / entregar temporada</button></section>`;
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
  const loaned = liveLoans.reduce((sum, loan) => sum + loanCapitalBalance(loan), 0);
  const interestLeft = liveLoans.reduce((sum, loan) => sum + loanInterestBalance(loan), 0);
  const available = Number(state.liquidity?.liquidez_total || 0);
  const generalTotal = available + loaned;
  const loanPercent = generalTotal > 0 ? (loaned / generalTotal) * 100 : 0;
  const gainsValue = Number(gains?.utilidad_neta || 0);
  const estimate = gainsValue + interestLeft;
  return `${!cycle ? `<section class="card"><p class="font-bold">Aún no tienes una caja abierta</p><p class="mt-1 text-sm text-slate-500">Crea una temporada para empezar a registrar movimientos.</p><button class="btn-primary mt-4" data-action="navigate" data-view="sabado">Preparar caja</button></section>` : ""}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      ${statCard("Saldo actual", state.liquidity ? money(available) : "—", state.liquidity ? `Caja y banco · ${dateText(state.liquidity.fecha)}` : "Se actualiza al conectar", "wallet")}
      ${statCard("Dinero total general", money(generalTotal), "Dinero disponible y capital prestado", "list", "blue")}
      <article class="card"><div class="flex items-start justify-between gap-3"><div><p class="text-sm font-semibold text-slate-500">En préstamo</p><p class="mt-2 text-2xl font-extrabold">${money(loaned)}</p><p class="mt-1 text-xs text-slate-400">${loanPercent.toFixed(1)}% del total general</p></div><span class="rounded-xl bg-blue-50 p-3 text-blue-700">${icon("wallet",21)}</span></div><details class="mt-3 border-t border-slate-100 pt-3"><summary class="cursor-pointer text-sm font-bold text-teal-700">Ver intereses pendientes</summary><p class="mt-2 text-lg font-extrabold">${money(interestLeft)}</p><p class="text-xs text-slate-500">Intereses restantes de préstamos activos</p></details></article>
      ${statCard("Ganancias", money(gainsValue), "Intereses y multas, menos gastos", "plus", "amber")}
      ${statCard("Estimado", money(estimate), `Ganancias más ${money(interestLeft)} de interés pendiente`, "calendar", "blue")}
    </div>
    <div class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-white p-5"><div><h2 class="font-extrabold">Estado de cuenta</h2><p class="mt-1 text-sm text-slate-500">Consulta todos los movimientos por fecha o por mes.</p></div><button class="btn-primary" data-action="navigate" data-view="movimientos">Ver movimientos</button></div>`;
}

function renderAlerts() {
  const cycle = selectedCycle();
  const active = state.loans.filter((loan) => loan.ciclo_id === cycle?.id && loan.estado === "activo" && loanBalance(loan) > 0.01);
  const today = todayMx();
  const dueLoans = active.map((loan) => ({ loan, days: Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${loan.fecha_vencimiento}T00:00:00Z`)) / 86400000) }))
    .filter(({ loan, days }) => days >= 0 || addDays(today, 7) >= loan.fecha_vencimiento)
    .sort((a, b) => a.loan.fecha_vencimiento.localeCompare(b.loan.fecha_vencimiento));
  const saturday = cycle ? expectedSaturday(cycle) : null;
  const missingSavings = saturday && saturday <= today ? activePeople().filter((person) => person.tipo === "socio" && !state.transactions.some((tx) => tx.ciclo_id === cycle.id && tx.participante_id === person.id && tx.tipo_movimiento === "ahorro_semanal" && tx.fecha_operacion === saturday && !tx.anulado)) : [];
  return `<div class="space-y-5"><section class="card"><h2 class="text-lg font-extrabold">Por cobrar</h2><p class="mt-1 text-sm text-slate-500">Préstamos pendientes, días de retraso y pagos próximos.</p>${dueLoans.length ? `<div class="mt-4 space-y-3">${dueLoans.map(({ loan, days }) => { const person = state.people.find((row) => row.id === loan.participante_id); const late = days > 0; const label = late ? `${days} día${days === 1 ? "" : "s"} de retraso` : days === 0 ? "Vence hoy" : `Vence en ${Math.abs(days)} día${Math.abs(days) === 1 ? "" : "s"}`; return `<article class="rounded-2xl border ${late ? "border-rose-200 bg-rose-50/40" : "border-slate-100"} p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-extrabold">${h(person?.nombre || "Contacto")}</h3><p class="mt-1 text-sm text-slate-600">Falta ${money(loanBalance(loan))} · ${label}</p><p class="mt-1 text-xs text-slate-500">Fecha acordada: ${dateText(loan.fecha_vencimiento)}</p></div><span class="badge ${late ? "badge-red" : "badge-amber"}">${late ? "Atrasado" : "Próximo"}</span></div><div class="mt-3 flex flex-wrap gap-2"><button class="btn-secondary" data-action="whatsapp" data-person="${h(person?.id)}" data-amount="${loanBalance(loan)}">Recordar</button><button class="btn-primary" data-action="collect-loan" data-id="${h(loan.id)}">Cobrar</button></div></article>`; }).join("")}</div>` : emptyState("No hay préstamos próximos ni atrasados.")}</section>
    <section class="card"><h2 class="text-lg font-extrabold">Ahorros por anotar</h2>${missingSavings.length ? `<p class="mt-1 text-sm text-slate-600">Para el sábado ${dateText(saturday)} falta revisar el ahorro de ${missingSavings.length} socio${missingSavings.length === 1 ? "" : "s"}.</p><div class="mt-3 flex flex-wrap gap-2">${missingSavings.map((person) => `<button class="btn-quiet rounded-full bg-slate-50" data-action="start-savings" data-person="${h(person.id)}">${h(person.nombre)}</button>`).join("")}</div>` : `<p class="mt-1 text-sm text-slate-500">No hay aportaciones pendientes de anotar para este sábado.</p>`}</section>
    ${state.pending.some((item) => item.status === "blocked") ? `<section class="card border-rose-200"><h2 class="font-extrabold text-rose-800">Registros que necesitan atención</h2><p class="mt-1 text-sm text-slate-600">${state.pending.filter((item) => item.status === "blocked").length} movimiento(s) fueron rechazados y pueden corregirse o quitarse del teléfono.</p><button class="btn-secondary mt-3" data-action="navigate" data-view="movimientos">Revisar movimientos</button></section>` : ""}</div>`;
}

function participantOptions(filter = "all", selected = "", onlyActive = false) {
  return activePeople().filter((person) => (!onlyActive || person.estatus === "activo") && (filter === "all" || person.tipo === filter)).map((person) => `<option value="${h(person.id)}" ${person.id === selected ? "selected" : ""}>${h(person.nombre)}${person.tipo === "externo" ? " · No participa en caja" : " · Socio"}${person.estatus === "cartera_vencida" ? " · con pagos pendientes" : ""}</option>`).join("");
}

function openLoans(cycleId = selectedCycle()?.id) {
  return state.loans.filter((loan) => loan.ciclo_id === cycleId && loan.estado === "activo" && loanBalance(loan) > 0.01);
}

function renderMovementForm() {
  const cycle = selectedCycle();
  if (!state.showMovementForm) return renderStatement(cycle);
  const choices = ["ahorro_semanal", "abono_prestamo", "pago_multa", "retiro_caja", "gasto", "ajuste_ingreso", "ajuste_egreso"];
  const loanChoices = openLoans().map((loan) => `<option value="${h(loan.id)}" data-person="${h(loan.participante_id)}">${h(participantName(loan.participante_id))} · pendiente ${money(loanBalance(loan))}</option>`).join("");
  return `
    <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section class="card">
        <p class="text-xs font-bold uppercase tracking-wide text-teal-700">Guardar movimiento</p><h2 class="mt-1 text-xl font-extrabold">Anotar ahorro o movimiento</h2><p class="mt-2 text-sm leading-6 text-slate-500">Si no tienes internet, el movimiento se guarda en este dispositivo y se manda después con el mismo folio.</p>
        <form id="movement-form" class="mt-6 grid gap-4 sm:grid-cols-2">
          <label class="field-label sm:col-span-2">¿Qué quieres anotar?<select class="field" name="kind" id="movement-kind" required>${choices.map((kind) => `<option value="${kind}">${movementLabels[kind]}</option>`).join("")}</select></label>
        <label class="field-label sm:col-span-2" id="movement-person-wrap">Persona<select class="field" name="participant_id" id="movement-person"><option value="">Elige a un socio</option>${participantOptions("socio", state.selectedPersonId || "")}</select></label>
          <label class="field-label hidden sm:col-span-2" id="movement-loan-wrap">Préstamo<select class="field" name="loan_id" id="movement-loan"><option value="">Elige un préstamo</option>${loanChoices}</select></label>
          <label class="field-label">Monto<input class="field" name="amount" inputmode="decimal" type="number" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" required placeholder="0.00" /></label>
          <label class="field-label">Forma de pago<select class="field" name="method" required><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
          <label class="field-label">Fecha (sábado)<input class="field" name="date" type="date" max="${todayMx()}" value="${lastSaturdayOnOrBefore()}" required /></label>
          <label class="field-label">Nota (opcional)<input class="field" name="note" maxlength="1000" placeholder="Un detalle breve" /></label>
          <div class="sm:col-span-2"><p id="movement-hint" class="text-xs leading-5 text-slate-500">${cycle ? `Caja: ${h(cycle.nombre)}. El registro debe quedar en un sábado abierto.` : "Prepara una caja y agrega un contacto antes de anotar movimientos."}</p><button class="btn-primary mt-4 w-full sm:w-auto" type="submit" ${!cycle || !activePeople().length || state.syncing ? "disabled" : ""}>Guardar movimiento</button><button class="btn-quiet mt-4 sm:ml-2" type="button" data-action="show-statement">Volver al estado de cuenta</button></div>
        </form>
      </section>
      <aside class="space-y-5">
        <section class="card"><h3 class="font-extrabold">Pendientes guardados</h3><p class="mt-1 text-sm text-slate-500">Se envían en orden de fecha. Si uno falla, verás el motivo y podrás corregirlo o descartarlo; los demás también se intentarán enviar.</p>${state.pending.length ? `<div class="mt-4 space-y-3">${state.pending.map(renderQueueEntry).join("")}</div>` : `<p class="mt-4 text-sm text-slate-400">No hay pendientes guardados.</p>`}</section>
        <section class="rounded-2xl border border-blue-100 bg-blue-50 p-5"><h3 class="font-extrabold text-blue-900">Un folio por movimiento</h3><p class="mt-2 text-sm leading-6 text-blue-800">Si la señal falla al enviar, volveremos a intentar el mismo folio y los mismos datos para que no se duplique.</p></section>
      </aside>
    </div>
    <section class="card mt-5"><div class="mb-4"><h2 class="text-lg font-extrabold">Historial de movimientos</h2><p class="text-sm text-slate-500">Anula un registro incorrecto con una explicación.</p></div>${renderTransactionsTable(state.transactions.filter((tx) => tx.ciclo_id === cycle?.id), true)}</section>`;
}

function renderStatement(cycle) {
  const allRows = state.transactions.filter((tx) => tx.ciclo_id === cycle?.id && (!state.statementPersonId || tx.participante_id === state.statementPersonId));
  const month = state.selectedStatementMonth;
  const rows = month ? allRows.filter((tx) => String(tx.fecha_operacion).startsWith(month)) : allRows;
  const savings = rows.filter((tx) => tx.tipo_movimiento === "ahorro_semanal" && !tx.anulado).reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
  const loansGiven = rows.filter((tx) => tx.tipo_movimiento === "desembolso_prestamo" && !tx.anulado).reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
  const payments = rows.filter((tx) => tx.tipo_movimiento === "abono_prestamo" && !tx.anulado).reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
  const months = [...new Set(allRows.map((tx) => String(tx.fecha_operacion).slice(0, 7)))].sort().reverse();
  return `<div class="space-y-5"><section class="card"><div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-lg font-extrabold">Estado de cuenta</h2><p class="mt-1 text-sm text-slate-500">${state.statementPersonId ? `Movimientos de ${h(participantName(state.statementPersonId))}.` : "Movimientos más recientes primero."}</p></div><div class="flex flex-wrap gap-2">${state.statementPersonId ? '<button class="btn-secondary" data-action="clear-person-statement">Ver todos</button>' : ""}<button class="btn-primary" data-action="new-movement">Anotar movimiento</button></div></div><div class="mt-4 grid gap-3 sm:grid-cols-3"><div class="rounded-xl bg-teal-50 p-3"><p class="text-sm text-slate-600">Ahorros recibidos</p><p class="mt-1 text-lg font-extrabold">${money(savings)}</p></div><div class="rounded-xl bg-blue-50 p-3"><p class="text-sm text-slate-600">Préstamos entregados</p><p class="mt-1 text-lg font-extrabold">${money(loansGiven)}</p></div><div class="rounded-xl bg-slate-50 p-3"><p class="text-sm text-slate-600">Abonos cobrados</p><p class="mt-1 text-lg font-extrabold">${money(payments)}</p></div></div><div class="mt-4 flex flex-wrap items-end gap-3"><label class="field-label min-w-[180px]">Consultar por mes<select id="statement-month" class="field"><option value="">Todos los meses</option>${months.map((value) => `<option value="${value}" ${value === month ? "selected" : ""}>${new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T12:00:00Z`))}</option>`).join("")}</select></label><p class="pb-3 text-sm text-slate-500">${month ? `Total registrado: <strong class="text-ink">${money(rows.reduce((sum, tx) => sum + Number(tx.monto || 0), 0))}</strong>` : `${rows.length} movimiento${rows.length === 1 ? "" : "s"}`}</p></div></section><section class="card">${renderTransactionsTable(rows, true)}</section>${state.pending.length ? `<section class="card"><div class="flex items-center justify-between gap-3"><div><h2 class="font-extrabold">Pendientes guardados</h2><p class="mt-1 text-sm text-slate-500">Si uno se rechaza, los demás se sincronizan por separado.</p></div><button class="btn-secondary" data-action="sync" ${!isOnline() || state.syncing ? "disabled" : ""}>Sincronizar</button></div><div class="mt-4 space-y-3">${state.pending.map(renderQueueEntry).join("")}</div></section>` : ""}<section class="card"><h3 class="font-extrabold">Otros registros</h3><div class="mt-3 grid gap-3 sm:grid-cols-2"><button class="btn-secondary" data-action="navigate" data-view="ingresos">Ingreso a caja</button><button class="btn-secondary" data-action="navigate" data-view="sabado">Cerrar sábado</button></div></section></div>`;
}

function renderTransactionsTable(rows, allowCancel = false) {
  if (!rows.length) return emptyState("No hay movimientos en esta caja.");
  const sorted = [...rows].sort((a, b) => String(b.fecha_operacion).localeCompare(String(a.fecha_operacion)) || String(b.creado_at).localeCompare(String(a.creado_at)));
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Movimiento</th><th>Persona</th><th>Forma de pago</th><th>Monto</th>${allowCancel ? "<th></th>" : ""}</tr></thead><tbody>${sorted.map((tx) => `<tr><td>${dateText(tx.fecha_operacion)}</td><td>${h(movementLabels[tx.tipo_movimiento] || tx.tipo_movimiento)}${tx.anulado ? ` <span class="badge badge-red">Anulado</span>` : ""}</td><td>${h(participantName(tx.participante_id))}</td><td>${h(paymentLabels[tx.metodo_pago] || tx.metodo_pago)}</td><td class="font-bold">${money(tx.monto)}</td>${allowCancel ? `<td>${!tx.anulado ? `<button class="btn-quiet text-rose-700" data-action="cancel-tx" data-id="${h(tx.id)}">Anular</button>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

function whatsappLink(person, amount) {
  let phone = state.contactPhones[person.id] || "";
  if (!phone) {
    const phoneInput = window.prompt(`Escribe el número de WhatsApp de ${person.nombre}, con lada de país (solo números). Se guardará solo en este teléfono.`);
    if (!phoneInput) return;
    phone = phoneInput.replace(/\D/g, "");
    if (phone.length < 10 || phone.length > 15) { toast("Escribe un número con lada de país, por ejemplo 5215512345678.", "error"); return; }
    saveContactPhone(person.id, phone).then(() => toast("Teléfono guardado en este dispositivo.", "success"));
  }
  const message = `Hola ${person.nombre}, te recordamos que tienes un saldo pendiente de ${money(amount)} en la caja de ahorro. Si ya realizaste tu pago, puedes ignorar este mensaje. Gracias.`;
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
}

function renderPeople() {
  const cycleId = selectedCycle()?.id;
  const people = state.people.filter((person) => person.nombre.toLocaleLowerCase("es").includes(state.personSearch.toLocaleLowerCase("es")));
  const personRows = people.map((person) => {
    const loans = state.loans.filter((loan) => loan.participante_id === person.id && loan.ciclo_id === cycleId && loan.estado === "activo");
    const balance = loans.reduce((sum, loan) => sum + loanBalance(loan), 0);
    const transactions = state.transactions.filter((tx) => tx.participante_id === person.id).sort((a, b) => String(b.fecha_operacion).localeCompare(String(a.fecha_operacion)) || String(b.creado_at).localeCompare(String(a.creado_at)));
    const selected = state.selectedPersonId === person.id;
    const phone = state.contactPhones[person.id];
    return `<article class="overflow-hidden rounded-2xl border ${person.tipo === "externo" ? "border-amber-200" : "border-slate-100"} bg-white"><button class="flex w-full items-center justify-between gap-3 p-4 text-left" data-action="toggle-person" data-id="${h(person.id)}"><span><strong class="block">${h(person.nombre)}</strong><span class="mt-1 inline-flex items-center gap-2 text-xs text-slate-500">${person.tipo === "externo" ? '<span class="badge badge-amber">No participa en caja</span>' : '<span class="badge badge-green">Socio</span>'}<span>${h(phone || "Sin teléfono")}</span></span></span><span class="text-right"><strong class="block">${money(balance)}</strong><span class="text-xs text-slate-500">por cobrar</span></span></button>${selected ? `<div class="border-t border-slate-100 bg-slate-50/70 p-4"><div class="flex flex-wrap gap-2"><button class="btn-secondary" data-action="whatsapp" data-person="${h(person.id)}" data-amount="${balance}">${icon("message",16)} Recordar</button>${loans.filter((loan) => loanBalance(loan) > 0.01).map((loan) => `<button class="btn-primary" data-action="collect-loan" data-id="${h(loan.id)}">Registrar pago</button>`).join("")}<button class="btn-quiet" data-action="person-movements" data-id="${h(person.id)}">Ver movimientos</button></div><h3 class="mt-4 font-bold">Movimientos de ${h(person.nombre)}</h3>${transactions.length ? `<div class="mt-2 space-y-2">${transactions.map((tx) => `<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-3"><div><p class="text-sm font-semibold">${h(movementLabels[tx.tipo_movimiento] || tx.tipo_movimiento)}${tx.anulado ? ' · Anulado' : ''}</p><p class="text-xs text-slate-500">${dateText(tx.fecha_operacion)} · ${h(paymentLabels[tx.metodo_pago] || tx.metodo_pago)}</p></div><strong>${money(tx.monto)}</strong></div>`).join("")}</div>` : `<p class="mt-2 text-sm text-slate-500">Todavía no tiene movimientos.</p>`}</div>` : ""}</article>`;
  }).join("");
  return `<div class="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
    <section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Agregar contacto</p><h2 class="mt-1 text-xl font-extrabold">Nuevo socio</h2><p class="mt-2 text-sm text-slate-500">Al agregarlo, participa en la caja. El teléfono queda guardado en este dispositivo para los recordatorios.</p>
      <form id="person-form" class="mt-5 space-y-4">
        <label class="field-label">Nombre completo<input class="field" name="name" maxlength="200" required placeholder="Nombre de la persona" /></label>
        <label class="field-label">Teléfono de WhatsApp<input class="field" name="phone" type="tel" inputmode="tel" maxlength="20" required placeholder="Con lada de país" /></label>
        <button class="btn-primary w-full" type="submit" ${!isOnline() || state.syncing ? "disabled" : ""}>+ Agregar socio</button>
      </form>
    </section>
    <section class="card"><div class="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 class="text-lg font-extrabold">Contactos conectados</h2><p class="text-sm text-slate-500">Toca un contacto para ver todos sus movimientos.</p></div><button class="btn-quiet" data-action="general-movements">Movimientos generales</button></div><form id="search-person-form" class="mb-4 flex gap-2"><input class="field mt-0" name="query" type="search" value="${h(state.personSearch)}" placeholder="Buscar por nombre" aria-label="Buscar contacto" /><button class="btn-secondary shrink-0" type="submit" aria-label="Buscar">${icon("search",18)}</button></form><div class="space-y-3">${personRows || emptyState("No encontramos contactos con ese nombre.")}</div></section>
  </div>`;
}

function renderLoans() {
  const cycle = selectedCycle();
  const hasLoanPending = state.pending.some((item) => item.action === "loan" && item.payload.p_ciclo_id === cycle?.id);
  const loans = state.loans.filter((loan) => loan.ciclo_id === cycle?.id).sort((a, b) => String(b.fecha_desembolso).localeCompare(String(a.fecha_desembolso)));
  const open = loans.filter((loan) => loanBalance(loan) > 0.01);
  const rows = open.map((loan) => `<article class="rounded-2xl border border-slate-100 bg-white p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-extrabold">${h(participantName(loan.participante_id))}</h3><p class="mt-1 text-sm text-slate-500">Entregado ${dateText(loan.fecha_desembolso)} · interés fijo 5%</p></div><span class="badge badge-amber">Activo</span></div><div class="mt-3 grid gap-3 sm:grid-cols-3"><div><p class="text-xs text-slate-500">Capital</p><p class="font-bold">${money(loan.capital_original)}</p></div><div><p class="text-xs text-slate-500">Interés</p><p class="font-bold">${money(loan.interes_total)}</p></div><div><p class="text-xs text-slate-500">Falta por pagar</p><p class="font-extrabold">${money(loanBalance(loan))}</p></div></div><div class="mt-3 flex flex-wrap gap-2"><button class="btn-primary" data-action="collect-loan" data-id="${h(loan.id)}">Registrar pago</button><button class="btn-secondary" data-action="whatsapp" data-person="${h(loan.participante_id)}" data-amount="${loanBalance(loan)}">Recordar</button></div></article>`).join("");
  const newContact = state.loanPersonChoice === "__new__";
  return `<div class="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
    <section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Nuevo préstamo</p><h2 class="mt-1 text-xl font-extrabold">Prestar dinero</h2><p class="mt-2 text-sm leading-6 text-slate-500">El interés es fijo: 5% del capital. El préstamo debe quedar pagado antes de entregar la caja; no hace falta definir un plazo.</p>
      <form id="loan-form" class="mt-5 space-y-4">
        <label class="field-label">¿A quién se lo prestas?<select class="field" name="person_choice" id="loan-person-choice" required><option value="">Elige un contacto</option>${participantOptions("all", "", true)}<option value="__new__" ${newContact ? "selected" : ""}>Agregar contacto externo</option></select></label>
        <div id="loan-new-contact" class="space-y-4 ${newContact ? "" : "hidden"}"><p class="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Se agregará con la etiqueta “No participa en caja”.</p><label class="field-label">Nombre<input class="field" name="new_name" maxlength="200" ${newContact ? "required" : ""} placeholder="Nombre del contacto" /></label><label class="field-label">Teléfono de WhatsApp<input class="field" name="new_phone" type="tel" inputmode="tel" maxlength="20" placeholder="Con lada de país" /></label></div>
        <label class="field-label">Cantidad a prestar<input class="field" name="capital" type="number" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" required inputmode="decimal" placeholder="0.00" /></label>
        <label class="field-label">Fecha de entrega (sábado)<input class="field" name="date" type="date" value="${lastSaturdayOnOrBefore()}" min="${cycle?.fecha_inicio || ""}" max="${todayMx()}" required /></label>
        <label class="field-label">Forma de entrega<select class="field" name="method"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
        <label class="field-label">Nota (opcional)<input class="field" name="note" maxlength="1000" placeholder="Detalle breve" /></label>
        <button class="btn-primary w-full" type="submit" ${!cycle || !isOnline() || state.syncing || hasLoanPending ? "disabled" : ""}>Confirmar préstamo</button>
        ${hasLoanPending ? `<p class="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">Hay un préstamo pendiente de confirmar. Espera a que sincronice o revisa el folio guardado antes de intentar otro.</p>` : ""}
      </form>
    </section>
    <section class="card"><div class="mb-4"><h2 class="text-lg font-extrabold">Ver préstamos activos</h2><p class="text-sm text-slate-500">Consulta lo que falta por pagar y registra cada abono.</p></div>${rows ? `<div class="space-y-3">${rows}</div>` : emptyState("No hay préstamos por cobrar.")}${loans.some((loan) => loanBalance(loan) <= 0.01) ? `<details class="mt-5"><summary class="cursor-pointer text-sm font-bold text-slate-600">Préstamos pagados (${loans.filter((loan) => loanBalance(loan) <= 0.01).length})</summary><div class="mt-3 space-y-2">${loans.filter((loan) => loanBalance(loan) <= 0.01).map((loan) => `<p class="rounded-xl bg-slate-50 p-3 text-sm">${h(participantName(loan.participante_id))} · ${dateText(loan.fecha_desembolso)} · ${money(loan.capital_original + loan.interes_total)}</p>`).join("")}</div></details>` : ""}</section>
  </div>`;
}

function expectedSaturday(cycle) {
  if (!cycle) return null;
  const entries = state.arqueos.filter((row) => row.ciclo_id === cycle.id).sort((a, b) => String(a.fecha_sabado).localeCompare(String(b.fecha_sabado)));
  return entries.length ? addDays(entries[entries.length - 1].fecha_sabado, 7) : cycle.fecha_inicio;
}

function renderCycleForm() {
  const nextStartYear = Number(todayMx().slice(0, 4));
  const start = firstSaturdayOfDecember(nextStartYear);
  const end = lastSaturdayOfNovember(nextStartYear + 1);
  return `<section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Preparar la siguiente caja</p><h2 class="mt-1 text-xl font-extrabold">Temporada de diciembre a noviembre</h2><p class="mt-2 text-sm text-slate-500">El inicio y la entrega se registran en sábado. Elige las fechas de esta temporada.</p><form id="cycle-form" class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
    <label class="field-label sm:col-span-2 xl:col-span-1">Nombre de la caja<input class="field" name="name" maxlength="200" required value="Caja ${nextStartYear}–${nextStartYear + 1}" /></label>
    <label class="field-label">Primer sábado (diciembre)<input class="field" name="start" type="date" value="${start}" required /></label>
    <label class="field-label">Último sábado (noviembre)<input class="field" name="end" type="date" value="${end}" required /></label>
    <label class="field-label">Dinero inicial en caja<input class="field" name="cash" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" value="0.00" required /></label>
    <label class="field-label">Dinero inicial en banco<input class="field" name="bank" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" value="0.00" required /></label>
    <label class="field-label">Reserva mínima<input class="field" name="reserve" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" value="0.00" required /></label>
    <div class="sm:col-span-2 xl:col-span-3"><button class="btn-primary" type="submit" ${!isOnline() || state.syncing ? "disabled" : ""}>Abrir caja</button></div>
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
      <div class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Revisión de la semana</p><h2 class="mt-1 text-xl font-extrabold">Cerrar sábado</h2><p class="mt-2 text-sm leading-6 text-slate-500">Cierra los sábados en orden. Si la diferencia entre lo esperado y lo contado pasa de $10, agrega una nota breve.</p>
        <div class="mt-5 grid gap-3 sm:grid-cols-3"><div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Sábado que sigue</p><p class="mt-1 font-bold">${saturday ? dateText(saturday) : "—"}</p></div><div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Efectivo esperado</p><p class="mt-1 font-bold">${expected ? money(expected.efectivo) : "—"}</p></div><div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Banco esperado</p><p class="mt-1 font-bold">${expected ? money(expected.transferencias) : "—"}</p></div></div>
        ${canCloseSaturday ? `<form id="close-week-form" class="mt-5 grid gap-4 sm:grid-cols-2"><label class="field-label">Efectivo contado<input class="field" name="cash" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" required inputmode="decimal" /></label><label class="field-label">Saldo bancario real<input class="field" name="bank" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" required inputmode="decimal" /></label><label class="field-label sm:col-span-2">Nota si hay una diferencia mayor a $10<input class="field" name="note" maxlength="1000" placeholder="Explica brevemente la diferencia" /></label><div class="sm:col-span-2"><button class="btn-primary" type="submit" ${state.syncing ? "disabled" : ""}>Guardar cierre del sábado</button></div></form>` : `<div class="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">${alreadyClosed ? "Esta caja ya se entregó." : !isOnline() ? "Conéctate a internet para cerrar el sábado." : saturday > todayMx() ? "El sábado que sigue todavía no llega." : saturday > cycle.fecha_fin ? "Ya se cerraron todos los sábados de esta temporada." : "Selecciona una caja abierta para continuar."}</div>`}
      </div>
      <aside class="card"><h3 class="font-extrabold">Último sábado cerrado</h3>${lastWeek ? `<p class="mt-3 text-sm text-slate-500">${dateText(lastWeek.fecha_sabado)}</p><p class="mt-1 text-sm">Efectivo contado: <strong>${money(lastWeek.efectivo_fisico_real)}</strong></p><p class="mt-1 text-sm">Saldo bancario: <strong>${money(lastWeek.saldo_banco_real)}</strong></p><p class="mt-3"><span class="badge ${lastWeek.estatus_cierre === "cerrado" ? "badge-green" : "badge-amber"}">${lastWeek.estatus_cierre === "cerrado" ? "Diferencia dentro de $10" : "Cerrado con diferencia"}</span></p>` : `<p class="mt-2 text-sm text-slate-500">Aún no se ha cerrado un sábado.</p>`}<div class="mt-5 border-t border-slate-100 pt-4"><p class="text-sm font-semibold text-slate-500">Ganancias hasta ahora</p><p class="mt-1 text-xl font-extrabold">${money(gain?.utilidad_neta || 0)}</p><p class="mt-1 text-xs text-slate-400">El reparto se calcula al entregar la caja.</p></div></aside>
    </section>` : ""}
    ${cycle && !cycle.activo && alreadyClosed ? `<section class="card"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Caja entregada</p><h2 class="mt-1 text-xl font-extrabold">Ganancias repartidas</h2><p class="mt-1 text-sm text-slate-500">${h(cycle.nombre)} · total ${money(alreadyClosed.utilidad_neta)}</p></div><span class="badge badge-green">Guardada en el historial</span></div>${shareRows ? `<div class="table-wrap mt-5"><table class="table"><thead><tr><th>Socio</th><th>Ahorro acumulado</th><th>Parte</th><th>Ganancias recibidas</th></tr></thead><tbody>${shareRows}</tbody></table></div>` : emptyState("No encontramos el detalle del reparto.")}</section>` : ""}
    ${cycle?.activo ? `<section class="card"><h2 class="text-lg font-extrabold">Entregar temporada y repartir ganancias</h2><p class="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Antes de terminar, se revisará el último sábado, los préstamos por cobrar y el ahorro acumulado. El reparto es proporcional y esta entrega no se puede deshacer.</p><div class="mt-4 flex flex-wrap items-center gap-4"><p class="text-sm">Último sábado ${cycle.fecha_fin ? dateText(cycle.fecha_fin) : "—"}: <strong>${lastWeek?.fecha_sabado === cycle.fecha_fin ? "cerrado" : "pendiente"}</strong></p><button class="btn-primary" data-action="close-cycle" ${!isOnline() || state.syncing || state.actionBusy ? "disabled" : ""}>Entregar y guardar en historial</button></div></section>` : ""}
    ${state.cycles.length ? `<section class="card"><h2 class="text-lg font-extrabold">Cajas de otros años</h2><div class="mt-4 table-wrap"><table class="table"><thead><tr><th>Nombre</th><th>Fechas</th><th>Estado</th><th></th></tr></thead><tbody>${state.cycles.map((row) => `<tr><td class="font-semibold">${h(row.nombre)}</td><td>${dateText(row.fecha_inicio)} – ${dateText(row.fecha_fin)}</td><td><span class="badge ${row.activo ? "badge-green" : "badge-gray"}">${row.activo ? "Abierta" : "Entregada"}</span></td><td>${row.activo ? `<button data-action="select-cycle" data-id="${h(row.id)}" class="btn-quiet">Ver caja</button>` : ""}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
  </div>`;
}

function renderView() {
  if (state.loading && !state.cycles.length && !state.people.length) return `<div class="card py-12 text-center text-slate-500">Cargando la información de tu caja…</div>`;
  switch (state.view) {
    case "movimientos": return renderMovementForm();
    case "alertas": return renderAlerts();
    case "ingresos": return renderIncomeEntry();
    case "personas": return renderPeople();
    case "prestamos": return renderLoans();
    case "sabado": return renderClosure();
    default: return renderDashboard();
  }
}

function renderIncomeEntry() {
  const cycle = selectedCycle();
  return `<div class="grid gap-5 xl:grid-cols-[minmax(0,560px)_1fr]"><section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Entradas de dinero</p><h2 class="mt-1 text-xl font-extrabold">Ingreso a caja</h2><p class="mt-2 text-sm leading-6 text-slate-500">Anota quién aportó, cuánto y cómo lo entregó. Las aportaciones se registran aparte de los abonos de préstamos.</p><form id="income-form" class="mt-5 space-y-4"><label class="field-label">¿Quién aportó?<select class="field" name="participant_id" required><option value="">Elige a un socio</option>${participantOptions("socio", state.selectedPersonId || "", true)}</select></label><label class="field-label">Cantidad<input class="field" name="amount" type="number" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" inputmode="decimal" required placeholder="0.00" /></label><label class="field-label">Fecha de aportación<input class="field" name="date" type="date" min="${cycle?.fecha_inicio || ""}" max="${todayMx()}" required value="${lastSaturdayOnOrBefore()}" /></label><label class="field-label">Forma de entrega<select class="field" name="method"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label><label class="field-label">Nota (opcional)<input class="field" name="note" maxlength="1000" placeholder="Detalle breve" /></label><button class="btn-primary w-full" type="submit" ${!cycle || state.syncing ? "disabled" : ""}>Guardar ingreso${!isOnline() ? " en este teléfono" : ""}</button></form><p class="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900">La base de datos actualmente acepta movimientos con fecha de sábado. Las aportaciones de otro día requieren actualizar esa regla en Supabase para poder guardarse.</p></section><section class="card"><h2 class="text-lg font-extrabold">Aportaciones recientes</h2><div class="mt-4">${renderTransactionsTable(state.transactions.filter((tx) => tx.ciclo_id === cycle?.id && tx.tipo_movimiento === "ahorro_semanal"), false)}</div></section></div>`;
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
    state.view = "inicio"; state.menuOpen = false; state.showMovementForm = false; state.selectedPersonId = null; state.statementPersonId = null;
    resetData(); state.pending = []; state.selectedCycleId = null;
    renderLogin();
    return;
  }
  if (session.user.user_metadata?.must_change_password === true) {
    renderPasswordChange();
    return;
  }
  requestPersistentStorage();
  appScreen.classList.remove("hidden");
  authScreen.classList.add("hidden");
  await loadCachedData();
  await loadContactPhones();
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
  const current = String(data.get("current") || "");
  const password = String(data.get("password") || "");
  const confirm = String(data.get("confirm") || "");
  if (!current) { renderPasswordChange("Escribe tu contraseña temporal actual para confirmar tu identidad."); return; }
  if (password.length < 10) { renderPasswordChange("La contraseña debe tener al menos 10 caracteres."); return; }
  if (password !== confirm) { renderPasswordChange("Las contraseñas no coinciden."); return; }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Guardando…";
  const verified = await verifyCurrentPassword(current);
  if (!verified) { renderPasswordChange("La contraseña actual no es correcta. Intenta de nuevo."); return; }
  const metadata = state.user?.user_metadata || {};
  const { data: result, error } = await supabase.auth.updateUser({ password, data: { ...metadata, must_change_password: false } });
  if (error) { renderPasswordChange(friendlyError(error)); return; }
  state.user = result.user;
  state.session = { ...state.session, user: result.user };
  toast("Contraseña guardada. Ya puedes usar la aplicación.", "success");
  await startSession(state.session);
}

async function verifyCurrentPassword(password) {
  if (!state.user?.email) return false;
  const { data, error } = await supabase.auth.signInWithPassword({ email: state.user.email, password });
  if (error || data.user?.id !== state.user.id) return false;
  state.session = data.session;
  state.user = data.user;
  return true;
}

async function changeProfilePassword(form) {
  const data = new FormData(form);
  const current = String(data.get("current") || "");
  const password = String(data.get("password") || "");
  const confirm = String(data.get("confirm") || "");
  if (password.length < 10) { toast("La nueva contraseña debe tener al menos 10 caracteres.", "error"); return; }
  if (current === password) { toast("Elige una contraseña diferente de la actual.", "error"); return; }
  if (password !== confirm) { toast("Las contraseñas nuevas no coinciden.", "error"); return; }
  if (!await verifyCurrentPassword(current)) { toast("La contraseña actual no es correcta. No se hizo ningún cambio.", "error"); return; }
  const { data: result, error } = await supabase.auth.updateUser({ password, data: state.user?.user_metadata || {} });
  if (error) { toast(friendlyError(error), "error"); return; }
  state.user = result.user;
  state.session = { ...state.session, user: result.user };
  state.menuOpen = false;
  toast("Contraseña actualizada.", "success");
  renderShell();
}

function validateSaturdayAndCycle(date, cycle, label = "La fecha") {
  if (!cycle) return "Primero prepara o elige una caja abierta.";
  if (!date || !isSaturday(date)) return `${label} debe ser sábado.`;
  if (date > todayMx()) return `${label} no puede estar en el futuro.`;
  if (date < cycle.fecha_inicio || date > cycle.fecha_fin) return `${label} debe quedar dentro de la caja abierta.`;
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
  let rejectedCount = 0;
  let firstRejected = "";
  try {
    let rows = (await storeGetAll("queue")).filter((item) => item.owner_id === state.user.id).sort((a,b) => String(queuedDate(a)).localeCompare(String(queuedDate(b))) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const item of rows) {
      if (item.status === "blocked") continue;
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
        if (!isDefinitiveServerRejection(error)) {
          await storePut("queue", { ...item, status: "pending", last_error: error.message || String(error) });
          break;
        }
        await storePut("queue", { ...item, status: "blocked", last_error: error.message || String(error) });
        rejectedCount += 1;
        if (!firstRejected) firstRejected = `${queuedLabel(item)} del ${dateText(queuedDate(item))}: ${queueErrorText({ ...item, last_error: error.message || String(error) })}`;
      }
    }
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    state.syncing = false;
    await refreshPending();
    if (syncedCount) toast(`${syncedCount} registro${syncedCount === 1 ? "" : "s"} sincronizado${syncedCount === 1 ? "" : "s"} correctamente.`, "success");
    if (rejectedCount) toast(`${rejectedCount} movimiento${rejectedCount === 1 ? "" : "s"} requiere${rejectedCount === 1 ? "" : "n"} revisión. ${firstRejected} Los otros pendientes también se intentaron enviar.`, "error");
    if (isOnline()) await refreshData();
  }
}

async function correctQueuedItem(form) {
  const rows = await storeGetAll("queue");
  const item = rows.find((row) => row.id === form.dataset.queueCorrection && row.owner_id === state.user?.id);
  if (!item || item.status !== "blocked") { toast("Ese pendiente ya no está disponible para corregir.", "error"); return; }
  if (/p_id ya fue usado/i.test(String(item.last_error || ""))) { toast(queueErrorText(item), "error"); return; }
  const data = new FormData(form);
  const payload = { ...item.payload };
  const cycle = state.cycles.find((row) => row.id === payload.p_ciclo_id);
  if (!cycle) { toast("No aparece la caja de este movimiento. Conéctate para actualizar la información y vuelve a intentar.", "error"); return; }
  const note = String(data.get("note") || "").trim() || null;
  if (note && note.length > 1000) { toast("La nota no puede tener más de 1,000 caracteres.", "error"); return; }
  if (item.action === "loan") {
    const participantId = String(data.get("participant_id") || "");
    const participant = state.people.find((person) => person.id === participantId);
    const capital = Number(data.get("capital"));
    const date = String(data.get("date") || "");
    const weeks = Math.floor((Date.parse(`${cycle.fecha_fin}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / (7 * 86400000));
    const method = String(data.get("method") || "");
    const validation = validateSaturdayAndCycle(date, cycle, "La fecha de entrega");
    if (validation) { toast(validation, "error"); return; }
    if (!participant || participant.estatus !== "activo") { toast("Elige a una persona activa para este préstamo.", "error"); return; }
    if (!Number.isFinite(capital) || capital <= 0 || capital > MAX_DB_AMOUNT || Math.round(capital * 100) !== capital * 100) { toast("El capital debe ser mayor que cero y tener máximo dos decimales.", "error"); return; }
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52 || addDays(date, weeks * 7) > cycle.fecha_fin) { toast("El préstamo debe entregarse antes del último sábado para que haya tiempo de liquidarlo.", "error"); return; }
    if (!["efectivo", "transferencia"].includes(method)) { toast("Elige efectivo o transferencia como forma de pago.", "error"); return; }
    if (participant.tipo === "externo") {
      const outstanding = state.loans.filter((loan) => loan.participante_id === participant.id && loan.estado === "activo").reduce((sum, loan) => sum + loanCapitalBalance(loan), 0);
      if (outstanding + capital > Number(participant.limite_credito || 0)) { toast(`El préstamo superaría el límite de crédito de ${money(participant.limite_credito)}.`, "error"); return; }
    }
    payload.p_participante_id = participantId;
    payload.p_capital = Number(capital.toFixed(2));
    payload.p_plazo_semanas = weeks;
    payload.p_fecha_desembolso = date;
    payload.p_metodo_pago = method;
    payload.p_nota = note;
    if (!window.confirm(`Se corregirá el préstamo de ${participant.nombre} por ${money(capital)}. Se conservará el mismo folio y se volverán a revisar las reglas de la caja. ¿Continuar?`)) return;
  } else {
    const kind = String(data.get("kind") || "");
    const participantId = String(data.get("participant_id") || "") || null;
    const loanId = String(data.get("loan_id") || "") || null;
    const date = String(data.get("date") || "");
    const amount = Number(data.get("amount"));
    const method = String(data.get("method") || "");
    const validation = validateSaturdayAndCycle(date, cycle, "La fecha del movimiento");
    if (validation) { toast(validation, "error"); return; }
    if (!["ahorro_semanal", "abono_prestamo", "pago_multa", "retiro_caja", "gasto", "ajuste_ingreso", "ajuste_egreso"].includes(kind)) { toast("Elige un tipo de movimiento válido.", "error"); return; }
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DB_AMOUNT || Math.round(amount * 100) !== amount * 100) { toast("El monto debe ser mayor que cero y tener máximo dos decimales.", "error"); return; }
    if (!["efectivo", "transferencia"].includes(method)) { toast("Elige efectivo o transferencia como forma de pago.", "error"); return; }
    const needsPerson = ["ahorro_semanal", "abono_prestamo", "pago_multa"].includes(kind);
    let participant = state.people.find((person) => person.id === participantId);
    if (kind === "abono_prestamo") {
      const loan = state.loans.find((row) => row.id === loanId && row.ciclo_id === cycle.id);
      if (!loan) { toast("Elige un préstamo de esta caja para registrar el abono.", "error"); return; }
      if (amount > loanBalance(loan) + 0.001) { toast("El abono supera lo que queda por pagar en ese préstamo.", "error"); return; }
      participant = state.people.find((person) => person.id === loan.participante_id);
      payload.p_prestamo_id = loan.id;
      payload.p_participante_id = loan.participante_id;
    } else {
      if (kind !== "abono_prestamo" && loanId) { toast("Quita el préstamo relacionado porque este movimiento no es un abono.", "error"); return; }
      payload.p_prestamo_id = null;
      payload.p_participante_id = needsPerson ? participantId : null;
    }
    if (needsPerson && !participant) { toast("Elige a una persona relacionada con este movimiento.", "error"); return; }
    if (kind === "ahorro_semanal" && participant?.tipo !== "socio") { toast("El ahorro semanal solo se registra para socios.", "error"); return; }
    payload.p_tipo_movimiento = kind;
    payload.p_monto = Number(amount.toFixed(2));
    payload.p_fecha_operacion = date;
    payload.p_metodo_pago = method;
    payload.p_nota = note;
    const personName = participant?.nombre || "No aplica";
    if (!window.confirm(`Se corregirá ${movementLabels[kind]} por ${money(amount)} para ${personName}, el ${dateText(date)}. Se conservará el mismo folio (${payload.p_id}) y se volverán a revisar las reglas de la caja. ¿Continuar?`)) return;
  }
  await storePut("queue", { ...item, payload, status: "pending", last_error: null });
  await refreshPending();
  toast(isOnline() ? "Corrección guardada. Se intentará enviar ahora con el mismo folio." : "Corrección guardada en este teléfono; se enviará cuando vuelva internet.", "success");
  if (isOnline()) await syncQueue();
}

async function createPerson(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const phone = String(data.get("phone") || "").replace(/\D/g, "");
  if (!name) { toast("Escribe el nombre de la persona.", "error"); return; }
  if (phone && (phone.length < 10 || phone.length > 15)) { toast("Revisa el teléfono e incluye la lada del país. Usa solo entre 10 y 15 dígitos.", "error"); return; }
  if (!isOnline()) { toast("Conéctate para guardar una persona.", "error"); return; }
  const { data: person, error } = await supabase.from("socios_y_clientes").insert({ nombre: name, tipo: "socio", limite_credito: 0 }).select().single();
  if (error) { toast(friendlyError(error), "error"); return; }
  if (phone) await saveContactPhone(person.id, phone);
  toast("Socio agregado a la caja.", "success"); form.reset();
  await refreshData();
}

async function saveIncome(form) {
  const data = new FormData(form);
  const cycle = selectedCycle();
  const date = String(data.get("date") || "");
  const amount = Number(data.get("amount"));
  const participantId = String(data.get("participant_id") || "");
  const method = String(data.get("method") || "");
  const note = String(data.get("note") || "").trim() || null;
  const validation = validateSaturdayAndCycle(date, cycle, "La fecha de la aportación");
  if (validation) { toast(validation.includes("sábado") ? "La base de datos solo acepta aportaciones con fecha de sábado. Para capturar cualquier día hace falta habilitar esa regla en Supabase." : validation, "error"); return; }
  const person = state.people.find((row) => row.id === participantId && row.tipo === "socio" && row.estatus === "activo");
  if (!person) { toast("Elige un socio activo de la caja.", "error"); return; }
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DB_AMOUNT || Math.round(amount * 100) !== amount * 100) { toast("Escribe una cantidad mayor a cero y con máximo dos decimales.", "error"); return; }
  if (note && note.length > 1000) { toast("La nota no puede tener más de 1,000 caracteres.", "error"); return; }
  if (!["efectivo", "transferencia"].includes(method)) { toast("Elige efectivo o transferencia como forma de entrega.", "error"); return; }
  if (!window.confirm(`Confirma el ingreso a caja:\n\n${person.nombre}\n${money(amount)}\n${dateText(date)} · ${paymentLabels[method]}\n\n¿Guardar?`)) return;
  const payload = { p_ciclo_id: cycle.id, p_tipo_movimiento: "ahorro_semanal", p_monto: Number(amount.toFixed(2)), p_metodo_pago: method, p_fecha_operacion: date, p_participante_id: person.id, p_prestamo_id: null, p_nota: note, p_id: crypto.randomUUID() };
  const record = { id: payload.p_id, action: "movement", owner_id: state.user.id, payload, created_at: nextQueuedAt(), status: "pending", last_error: null };
  try { await storePut("queue", record); } catch (error) { toast(friendlyError(error), "error"); return; }
  await refreshPending();
  if (isOnline()) await syncQueue();
  else toast("El ingreso quedó en este teléfono y se enviará al volver la conexión.", "success");
}

async function createCycle(form) {
  if (!isOnline()) { toast("Conéctate para abrir la siguiente caja.", "error"); return; }
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const start = String(data.get("start"));
  const end = String(data.get("end"));
  const cash = Number(data.get("cash"));
  const bank = Number(data.get("bank"));
  const reserve = Number(data.get("reserve"));
  if (!name) { toast("Escribe un nombre para la caja.", "error"); return; }
  if (state.cycles.some((cycle) => cycle.activo)) { toast("Primero entrega la caja actual antes de abrir otra.", "error"); return; }
  if (!isSaturday(start) || !isSaturday(end)) { toast("El inicio y la entrega de la temporada deben ser sábados.", "error"); return; }
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (startDate.getUTCMonth() !== 11 || endDate.getUTCMonth() !== 10 || endDate.getUTCFullYear() !== startDate.getUTCFullYear() + 1) { toast("La temporada debe comenzar en diciembre y terminar en noviembre del año siguiente.", "error"); return; }
  if (end < start) { toast("La fecha final debe ser posterior a la inicial.", "error"); return; }
  if ([cash, bank, reserve].some((value) => !Number.isFinite(value) || value < 0 || value > MAX_DB_AMOUNT || Math.round(value * 100) !== value * 100)) { toast("Los saldos iniciales y la reserva deben estar dentro del límite permitido y tener hasta dos decimales.", "error"); return; }
  const largeNote = Math.max(cash, bank, reserve) >= LARGE_AMOUNT_CONFIRMATION ? "\n\nHay un saldo alto. Revisa que las cifras estén bien capturadas." : "";
  if (!window.confirm(`Vas a abrir ${name} del ${dateText(start)} al ${dateText(end)}.\n\nInicio en caja: ${money(cash)}\nInicio en banco: ${money(bank)}\nReserva mínima: ${money(reserve)}${largeNote}\n\n¿Los datos son correctos?`)) return;
  const { data: created, error } = await supabase.from("ciclos").insert({ nombre: name, fecha_inicio: start, fecha_fin: end, saldo_inicial_efectivo: cash, saldo_inicial_transferencias: bank, reserva_minima: reserve }).select().single();
  if (error) { toast(friendlyError(error), "error"); return; }
  state.selectedCycleId = created.id; state.view = "inicio";
  toast("La caja está lista.", "success");
  await refreshData();
}

async function createLoan(form) {
  if (!isOnline()) { toast("Conéctate para confirmar el préstamo. No se guarda sin internet.", "error"); return; }
  const cycle = selectedCycle();
  const data = new FormData(form);
  const choice = String(data.get("person_choice") || "");
  let participantId = choice === "__new__" ? "" : choice;
  const newName = String(data.get("new_name") || "").trim();
  const newPhone = String(data.get("new_phone") || "").replace(/\D/g, "");
  const capital = Number(data.get("capital"));
  const date = String(data.get("date"));
  const method = String(data.get("method"));
  const note = String(data.get("note") || "").trim() || null;
  const validation = validateSaturdayAndCycle(date, cycle, "La fecha de entrega");
  if (validation) { toast(validation, "error"); return; }
  if (!choice) { toast("Elige un contacto o agrega uno nuevo.", "error"); return; }
  if (choice === "__new__" && !newName) { toast("Escribe el nombre del nuevo contacto.", "error"); return; }
  if (newPhone && (newPhone.length < 10 || newPhone.length > 15)) { toast("Revisa el teléfono e incluye la lada del país.", "error"); return; }
  if (!Number.isFinite(capital) || capital <= 0 || capital > MAX_DB_AMOUNT || Math.round(capital * 100) !== capital * 100) { toast("El capital debe estar dentro del límite permitido y tener hasta dos decimales.", "error"); return; }
  const weeks = Math.floor((Date.parse(`${cycle.fecha_fin}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / (7 * 86400000));
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) { toast("El préstamo debe entregarse antes del último sábado para que haya tiempo de liquidarlo.", "error"); return; }
  if (note && note.length > 1000) { toast("La nota no puede tener más de 1,000 caracteres.", "error"); return; }
  if (!window.confirm(`Confirma el préstamo:\n\nContacto: ${choice === "__new__" ? newName : participantName(participantId)}\nCapital: ${money(capital)}\nInterés fijo 5%: ${money(Math.round(capital * 0.05 * 100) / 100)}\nTotal a devolver: ${money(capital + Math.round(capital * 0.05 * 100) / 100)}\nEntrega: ${dateText(date)}\n\nDebe quedar pagado antes de entregar la caja. ¿Continuar?`)) return;
  if (choice === "__new__") {
    const existing = state.people.find((person) => person.tipo === "externo" && person.nombre.trim().toLocaleLowerCase("es") === newName.toLocaleLowerCase("es"));
    let person = existing || null;
    if (!person) {
      const { data: created, error } = await supabase.from("socios_y_clientes").insert({ nombre: newName, tipo: "externo", limite_credito: Number(capital.toFixed(2)) }).select().single();
      if (error) {
        await refreshData();
        person = state.people.find((row) => row.tipo === "externo" && row.nombre.trim().toLocaleLowerCase("es") === newName.toLocaleLowerCase("es")) || null;
        if (!person) { toast(friendlyError(error), "error"); return; }
      } else person = created;
    }
    participantId = person.id;
    if (newPhone) await saveContactPhone(person.id, newPhone);
    await refreshData();
  }
  const participant = state.people.find((person) => person.id === participantId);
  if (!participant || participant.estatus !== "activo") { toast("Ese contacto no está disponible. Actualiza la información e intenta de nuevo.", "error"); return; }
  if (participant.tipo === "externo") {
    const outstandingCapital = state.loans.filter((loan) => loan.participante_id === participant.id && loan.estado === "activo").reduce((sum, loan) => sum + loanCapitalBalance(loan), 0);
    if (outstandingCapital + capital > Number(participant.limite_credito || 0)) { toast(`Este préstamo rebasaría el límite de ${money(participant.limite_credito)} para esta persona.`, "error"); return; }
  }
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
  const record = { id: payload.p_id, action: "loan", owner_id: state.user.id, payload, created_at: nextQueuedAt(), status: "pending", last_error: null };
  try { await storePut("queue", record); } catch (error) { toast(friendlyError(error), "error"); return; }
  await refreshPending();
  await syncQueue();
  if (state.pending.some((item) => item.id === payload.p_id && item.status === "pending")) toast("No se confirmó la respuesta de la red. El préstamo quedó guardado con el mismo folio para volver a intentar.", "info");
}

async function cancelTransaction(id, button) {
  if (cancellingTransaction) return;
  if (!isOnline()) { toast("Conéctate para anular un movimiento y guardar la explicación.", "error"); return; }
  const transaction = state.transactions.find((row) => row.id === id);
  if (!transaction || transaction.anulado) return;
  const reason = window.prompt("¿Por qué se anula este movimiento? Escribe al menos cinco caracteres.");
  if (reason === null) return;
  if (reason.trim().length < 5) { toast("La explicación debe tener al menos cinco caracteres.", "error"); return; }
  if (!window.confirm(`Se anulará este movimiento y se guardará la explicación en la bitácora. No se puede borrar después.\n\nMotivo: ${reason.trim()}\n\n¿Confirmas la anulación?`)) return;
  cancellingTransaction = true;
  if (button) { button.disabled = true; button.textContent = "Anulando…"; }
  try {
    const { error } = await supabase.rpc("anular_transaccion", { p_transaccion_id: id, p_motivo: reason.trim() });
    if (error) { toast(friendlyError(error), "error"); return; }
    toast("Movimiento anulado y guardado en la bitácora.", "success");
    await refreshData();
  } catch (error) {
    if (isNetworkError(error)) {
      await refreshData();
      const latest = state.transactions.find((row) => row.id === id);
      toast(latest?.anulado
        ? "La anulación sí quedó guardada. El historial ya está actualizado."
        : "Se perdió la conexión mientras se anulaba. Revisa el historial antes de volver a intentarlo.", latest?.anulado ? "success" : "error");
    } else {
      toast(friendlyError(error), "error");
    }
  } finally {
    cancellingTransaction = false;
    if (button?.isConnected) { button.disabled = false; button.textContent = "Anular"; }
  }
}

async function closeSaturday(form) {
  if (!isOnline()) { toast("Conéctate para guardar el cierre del sábado.", "error"); return; }
  const cycle = selectedCycle();
  const saturday = expectedSaturday(cycle);
  const data = new FormData(form);
  const cash = Number(data.get("cash"));
  const bank = Number(data.get("bank"));
  const note = String(data.get("note") || "").trim() || null;
  if (!cycle?.activo || !saturday) { toast("Elige una caja abierta.", "error"); return; }
  if (saturday > todayMx()) { toast("El sábado que sigue todavía no llega.", "error"); return; }
  if (!isSaturday(saturday) || saturday < cycle.fecha_inicio || saturday > cycle.fecha_fin) { toast("Revisa las fechas y el orden de la temporada.", "error"); return; }
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
  if (!isOnline()) { toast("Conéctate para entregar la caja.", "error"); return; }
  const pendingForCycle = state.pending.filter((item) => item.payload.p_ciclo_id === cycle.id);
  if (pendingForCycle.length) { toast(`Hay ${pendingForCycle.length} registro${pendingForCycle.length === 1 ? "" : "s"} pendiente${pendingForCycle.length === 1 ? "" : "s"} en este dispositivo. Sincroniza o revisa eso antes de entregar la caja.`, "error"); state.view = "movimientos"; renderShell(); return; }
  const lastArqueo = state.arqueos.filter((row) => row.ciclo_id === cycle.id).sort((a,b) => String(b.fecha_sabado).localeCompare(String(a.fecha_sabado)))[0];
  if (lastArqueo?.fecha_sabado !== cycle.fecha_fin) { toast("Antes de entregar la caja, cierra el último sábado de la temporada.", "error"); state.view = "sabado"; renderShell(); return; }
  const unpaidLoans = state.loans.filter((loan) => loan.ciclo_id === cycle.id && loan.estado === "activo" && loanBalance(loan) > 0.01);
  if (unpaidLoans.length) { toast(`Quedan ${unpaidLoans.length} préstamo${unpaidLoans.length === 1 ? "" : "s"} por cobrar. Registra los abonos antes del cierre.`, "error"); state.view = "prestamos"; renderShell(); return; }
  const savings = state.transactions.filter((tx) => tx.ciclo_id === cycle.id && tx.tipo_movimiento === "ahorro_semanal" && !tx.anulado).reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
  if (savings <= 0) { toast("Esta caja no tiene aportaciones para calcular el reparto.", "error"); return; }
  if (!window.confirm(`Vas a entregar “${cycle.nombre}” y calcular el reparto proporcional de ganancias. Esta acción no se puede deshacer. ¿Continuar?`)) return;
  const { error } = await supabase.rpc("cerrar_ciclo", { p_ciclo_id: cycle.id });
  if (error) { toast(friendlyError(error), "error"); return; }
  toast("Caja entregada y reparto guardado en el historial.", "success");
  await refreshData();
  state.view = "sabado"; renderShell();
  } finally {
    state.actionBusy = false;
    if (state.session) renderShell();
  }
}

async function logout() {
  if (queueCount() && !window.confirm(`Hay ${queueCount()} registro${queueCount() === 1 ? "" : "s"} sin enviar. Seguirán guardados en este teléfono; vuelve a entrar con la misma cuenta para sincronizarlos. ¿Quieres salir?`)) return;
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) { toast("No se pudo cerrar la sesión en este dispositivo. Intenta otra vez.", "error"); return; }
    await startSession(null);
  } catch (error) {
    toast(friendlyError(error), "error");
  }
}

function handleClick(event) {
  if (event.target.matches("[data-drawer-backdrop]")) { state.menuOpen = false; renderShell(); return; }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "toggle-menu") { state.menuOpen = !state.menuOpen; renderShell(); return; }
  if (action === "close-menu") { state.menuOpen = false; renderShell(); return; }
  if (action === "navigate") { state.view = button.dataset.view || "inicio"; state.menuOpen = false; if (state.view === "movimientos") state.statementPersonId = null; else state.showMovementForm = false; renderShell(); if (state.view === "sabado") refreshExpectedAndFlow().then(renderShell); return; }
  if (action === "general-movements") { state.statementPersonId = null; state.view = "movimientos"; state.showMovementForm = false; renderShell(); return; }
  if (action === "clear-person-statement") { state.statementPersonId = null; renderShell(); return; }
  if (action === "new-movement") { state.showMovementForm = true; state.selectedPersonId = null; renderShell(); return; }
  if (action === "show-statement") { state.showMovementForm = false; state.selectedPersonId = null; renderShell(); return; }
  if (action === "logout") { logout(); return; }
  if (action === "sync") { syncQueue(); return; }
  if (action === "cancel-tx") { cancelTransaction(button.dataset.id, button); return; }
  if (action === "close-cycle") { closeCycle().catch((error) => toast(friendlyError(error), "error")); return; }
  if (action === "whatsapp") { const person = state.people.find((row) => row.id === button.dataset.person); if (person) whatsappLink(person, Number(button.dataset.amount)); return; }
  if (action === "toggle-person") { state.selectedPersonId = state.selectedPersonId === button.dataset.id ? null : button.dataset.id; renderShell(); return; }
  if (action === "person-movements") { state.selectedPersonId = button.dataset.id; state.statementPersonId = button.dataset.id; state.view = "movimientos"; state.showMovementForm = false; renderShell(); return; }
  if (action === "collect-loan") {
    const loan = state.loans.find((row) => row.id === button.dataset.id);
    if (!loan) { toast("No encontramos ese préstamo. Actualiza la información e intenta de nuevo.", "error"); return; }
    state.selectedLoanForPayment = loan.id; state.selectedPersonId = loan.participante_id; state.statementPersonId = null; state.showMovementForm = true; state.view = "movimientos"; state.menuOpen = false; renderShell();
    const kind = document.querySelector("#movement-kind");
    if (kind) { kind.value = "abono_prestamo"; personForKind("abono_prestamo"); }
    const loanSelect = document.querySelector("#movement-loan");
    if (loanSelect) { loanSelect.value = loan.id; loanSelect.dispatchEvent(new Event("change", { bubbles: true })); }
    return;
  }
  if (action === "start-savings") { state.selectedPersonId = button.dataset.person; state.view = "ingresos"; renderShell(); return; }
  if (action === "select-cycle") { state.selectedCycleId = button.dataset.id; state.view = "inicio"; renderShell(); if (isOnline()) refreshData(); return; }
  if (action === "discard-queue") {
    const item = state.pending.find((row) => row.id === button.dataset.id);
    if (!item || item.status !== "blocked" || /p_id ya fue usado/i.test(String(item.last_error || ""))) { toast("Solo puedes descartar un movimiento que el servidor rechazó. Revisa el folio si el mensaje indica que ya fue usado.", "error"); return; }
    if (!window.confirm("¿Quitar este movimiento guardado de este dispositivo? No se enviará al servidor.")) return;
    storeDelete("queue", button.dataset.id).then(refreshPending).catch((error) => toast(friendlyError(error), "error")); return;
  }
  if (action === "retry-queue") {
    const item = state.pending.find((row) => row.id === button.dataset.id);
    if (!item || item.status !== "blocked" || /p_id ya fue usado/i.test(String(item.last_error || ""))) { toast("Este folio necesita revisarse antes de volver a enviarse.", "error"); return; }
    storePut("queue", { ...item, status: "pending", last_error: null }).then(refreshPending).then(syncQueue).catch((error) => toast(friendlyError(error), "error")); return;
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.dataset.busy === "true") return;
  if (state.syncing && !["login-form", "password-form", "profile-password-form"].includes(form.id)) { toast("Espera a que termine la sincronización antes de guardar otra cosa.", "info"); return; }
  form.dataset.busy = "true";
  const button = form.querySelector("button[type=submit]");
  const oldLabel = button?.textContent || "Guardar";
  const busyLabel = form.id === "login-form" ? "Entrando…" : form.id === "loan-form" ? "Confirmando préstamo…" : form.id === "close-week-form" ? "Guardando cierre…" : "Guardando…";
  if (button) { button.disabled = true; button.textContent = busyLabel; }
  try {
    if (form.id === "login-form") await submitLogin(form);
    else if (form.id === "password-form") await submitPasswordChange(form);
    else if (form.id === "profile-password-form") await changeProfilePassword(form);
    else if (form.id === "movement-form") await saveMovement(form);
    else if (form.id === "person-form") await createPerson(form);
    else if (form.id === "income-form") await saveIncome(form);
    else if (form.id === "cycle-form") await createCycle(form);
    else if (form.id === "loan-form") await createLoan(form);
    else if (form.id === "close-week-form") await closeSaturday(form);
    else if (form.id === "search-person-form") { state.personSearch = String(new FormData(form).get("query") || "").trim(); renderShell(); }
    else if (form.dataset.queueCorrection) await correctQueuedItem(form);
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
  if (event.target.matches("#loan-person-choice")) {
    state.loanPersonChoice = event.target.value;
    const block = document.querySelector("#loan-new-contact");
    const name = document.querySelector('[name="new_name"]');
    block?.classList.toggle("hidden", state.loanPersonChoice !== "__new__");
    if (name) name.required = state.loanPersonChoice === "__new__";
  }
  if (event.target.matches("#statement-month")) { state.selectedStatementMonth = event.target.value; renderShell(); }
  if (event.target.matches("#movement-loan")) {
    const chosen = event.target.selectedOptions[0]?.dataset.person;
    const person = document.querySelector("#movement-person");
    if (person && chosen) person.value = chosen;
  }
  if (event.target.matches("#cycle-picker, #cycle-picker-mobile")) { state.selectedCycleId = event.target.value; renderShell(); refreshData(); }
});

window.addEventListener("online", () => { renderShell(); if (state.user) syncQueue(); });
window.addEventListener("offline", () => renderShell());
window.addEventListener("focus", () => { verifyAccessOnReturn(); if (state.user && isOnline()) refreshData(); });
window.addEventListener("pageshow", () => verifyAccessOnReturn());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") verifyAccessOnReturn(); });
window.addEventListener("storage", () => { if (state.user) refreshPending(); });

supabase.auth.onAuthStateChange((_event, session) => {
  queueMicrotask(() => {
    if (session?.user?.user_metadata?.must_change_password === true || session?.user?.id !== state.user?.id || !session) startSession(session);
    else { state.session = session; state.user = session.user; }
  });
});

async function verifyAccessOnReturn() {
  if (!state.user || document.visibilityState === "hidden") return;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return;
    if (!data.user) { await startSession(null); return; }
    state.user = data.user;
    state.session = { ...state.session, user: data.user };
    if (data.user.user_metadata?.must_change_password === true) renderPasswordChange();
    else if (!authScreen.classList.contains("hidden")) await startSession(state.session);
  } catch { /* El inicio ya consultó la sesión; sin red conservamos la pantalla segura actual. */ }
}

async function initialize() {
  const { data: initial } = await supabase.auth.getSession();
  await startSession(initial.session);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

initialize();

async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* El navegador conserva el almacenamiento como mejor esfuerzo. */ }
}
