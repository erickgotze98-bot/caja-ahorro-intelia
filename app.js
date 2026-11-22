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
  inicio: "Resumen", prestamos: "Préstamos",
  personas: "Contactos", alertas: "Pendientes", movimientos: "Movimientos",
  cobrar: "Registrar pago", temporadas: "Historial de cajas", calendario: "Calendario"
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
  showMovementForm: false, showPersonForm: false, loanPersonChoice: "", contactPhones: {},
  collectionPersonId: null, collectionReturnView: "alertas", contactFrequency: {},
  calendarPersonId: null, calendarCycleId: null, calendarMonth: "", calendarWeek: "", collectionDate: null,
  personFilter: "all", missedWeeks: {}, isDemo: false
};

const DB_NAME = "mi-caja-offline-v1";
const DB_VERSION = 2;
let dbPromise;
let refreshPromise;
let cancellingTransaction = false;
let verifyingAccess = false;
let enteringDemo = false;

function h(value = "") {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function money(value = 0) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function moneyInputValue(value) {
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(/\$/g, "").replace(/,/g, "");
  if (!normalized || !/^-?\d*(?:\.\d*)?$/.test(normalized)) return 0;
  return Number(normalized) || 0;
}

function moneyField(name, id, { value = "", required = false, placeholder = "0.00", extra = "" } = {}) {
  return `<span class="money-input"><span aria-hidden="true">$</span><input class="field money-input-control" name="${h(name)}" ${id ? `id="${h(id)}"` : ""} type="text" inputmode="decimal" autocomplete="off" data-money-input ${required ? "required" : ""} value="${h(value)}" placeholder="${h(placeholder)}" ${extra} /></span>`;
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
  if (lower.includes("no se permite registrar un abono anterior")) return "Ese préstamo ya tiene un pago más reciente. Elige una fecha posterior para conservar el orden del cálculo.";
  if (lower.includes("saldo negativo") || lower.includes("saldos no pueden ser negativos")) return "Este movimiento dejaría el dinero disponible por debajo de cero.";
  if (lower.includes("el monto debe ser mayor") || lower.includes("maximo dos decimales") || lower.includes("máximo dos decimales")) return "Revisa que el monto sea mayor que cero y tenga máximo dos decimales.";
  if (lower.includes("asegurar_caja_automatica") || lower.includes("could not find the function") || lower.includes("function public.asegurar")) return "Falta activar la actualización de temporadas automáticas en Supabase. Aplica la migración del proyecto y vuelve a intentarlo.";
  if (lower.includes("ya existe una caja registrada para esta temporada")) return "Ya hay una caja guardada para estas fechas. Revisa el historial o contacta a quien administra la base.";
  if (lower.includes("la siguiente temporada comienza")) return "La temporada nueva todavía no empieza. Vuelve a registrar cuando llegue el primer sábado de diciembre.";
  if (lower.includes("metodo de pago invalido") || lower.includes("método de pago inválido")) return "Elige efectivo o transferencia como forma de pago.";
  if (lower.includes("vencimiento excede") || lower.includes("fecha final del ciclo")) return "El pago de este préstamo quedaría después de la entrega de la caja. Elige otra fecha.";
  if (lower.includes("limite de credito") || lower.includes("límite de crédito")) return "El préstamo supera el límite de crédito de esta persona.";
  if (lower.includes("vulneraria reserva") || lower.includes("vulneraría reserva")) return "El préstamo dejaría menos dinero que la reserva mínima.";
  if (lower.includes("solo participantes activos")) return "Solo las personas activas pueden recibir un préstamo.";
  if (lower.includes("no se cierra el ciclo con prestamos") || lower.includes("préstamos cuyo saldo")) return "Aún quedan préstamos por cobrar. Registra los abonos antes de entregar la caja.";
  if (lower.includes("ultimo sabado del ciclo") || lower.includes("último sábado del ciclo")) return "Primero realiza el conteo final de la temporada.";
  if (lower.includes("diferencia supera $10")) return "La diferencia supera $10. Escribe una explicación de al menos cinco caracteres.";
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

async function storeQueueRecords(records) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("queue", "readwrite");
    const store = transaction.objectStore("queue");
    for (const record of records) store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar el pago en este teléfono."));
    transaction.onabort = () => reject(transaction.error || new Error("No se pudo guardar el pago en este teléfono."));
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

function elapsedLoanPeriods(loan, asOf = todayMx()) {
  const elapsedDays = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${loan.fecha_desembolso}T00:00:00Z`)) / 86400000);
  return Number.isFinite(elapsedDays) ? Math.floor(Math.max(0, elapsedDays) / 15) : 0;
}

function accrueDemoLoanInterest(loan, asOf) {
  const newPeriods = Math.max(0, elapsedLoanPeriods(loan, asOf) - Number(loan.periodos_interes_calculados || 0));
  if (!newPeriods) return;
  const amount = Math.round(loanCapitalBalance(loan) * Number(loan.tasa_interes || 0.05) * newPeriods * 100) / 100;
  if (amount > 0) loan.interes_total = Number(loan.interes_total || 0) + amount;
  loan.periodos_interes_calculados = Number(loan.periodos_interes_calculados || 0) + newPeriods;
}

function loanInterestBalance(loan, asOf = todayMx()) {
  const paid = state.transactions.filter((tx) => tx.prestamo_id === loan.id && tx.tipo_movimiento === "abono_prestamo" && !tx.anulado)
    .reduce((sum, tx) => sum + Number(tx.interes_aplicado || 0), 0);
  const periodsElapsed = elapsedLoanPeriods(loan, asOf);
  const periodsNotPosted = Math.max(0, periodsElapsed - Number(loan.periodos_interes_calculados || 0));
  const unposted = Math.round(loanCapitalBalance(loan) * Number(loan.tasa_interes || 0.05) * periodsNotPosted * 100) / 100;
  return Math.max(0, Number(loan.interes_total || 0) + unposted - paid);
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
            <label class="field-label">Correo electrónico<input class="field" name="email" type="text" inputmode="email" autocomplete="username" required value="${h(state.user?.email || "")}" placeholder="tu@correo.com" /></label>
            <label class="field-label">Contraseña<input class="field" name="password" type="password" autocomplete="current-password" required /></label>
            <button class="btn-primary w-full" type="submit">Entrar a Mi Caja</button>
          </form>
          <p class="mt-5 text-center text-xs leading-5 text-slate-400">Solo las personas autorizadas pueden entrar. Tus datos se consultan con tu sesión personal.</p>
        </div>
      </section>
    </main>`;
}

function seedDemoData() {
  const cycleId = "demo-cycle-current";
  const personIds = { erick: "demo-person-erick", ana: "demo-person-ana", luisa: "demo-person-luisa", javier: "demo-person-javier" };
  const today = todayMx();
  const currentSaturday = lastSaturdayOnOrBefore(today);
  const previousSaturday = addDays(currentSaturday, -7);
  const fortnightSaturday = addDays(currentSaturday, -14);
  const olderSaturday = addDays(currentSaturday, -21);
  state.isDemo = true;
  state.user = { id: "demo-user-local-only", email: "admin@mi-caja-demo.local", user_metadata: { name: "Milo", must_change_password: false } };
  state.session = { user: state.user, demo: true };
  state.view = "inicio"; state.menuOpen = false; state.selectedCycleId = cycleId; state.selectedPersonId = null;
  state.collectionPersonId = null; state.collectionReturnView = "alertas"; state.pending = []; state.syncing = false; state.actionBusy = false;
  state.contactPhones = { [personIds.erick]: "5215550101001", [personIds.ana]: "5215550101002", [personIds.luisa]: "5215550101003", [personIds.javier]: "5215550101004" };
  state.contactFrequency = { [personIds.erick]: "fortnightly", [personIds.ana]: "weekly", [personIds.luisa]: "flexible" };
  state.missedWeeks = { [`${personIds.ana}:${currentSaturday}`]: true };
  const previousCycleId = "demo-cycle-previous";
  state.cycles = [
    { id: cycleId, owner_id: state.user.id, nombre: "Temporada 2025–2026", fecha_inicio: "2025-12-06", fecha_fin: "2026-11-28", activo: true, saldo_inicial_efectivo: 0, saldo_inicial_transferencias: 0, reserva_minima: 0 },
    { id: previousCycleId, owner_id: state.user.id, nombre: "Temporada 2024–2025", fecha_inicio: "2024-12-07", fecha_fin: "2025-11-29", activo: false, saldo_inicial_efectivo: 0, saldo_inicial_transferencias: 0, reserva_minima: 0 }
  ];
  state.people = [
    { id: personIds.erick, owner_id: state.user.id, nombre: "Erick Pardo", tipo: "socio", estatus: "activo", limite_credito: 0 },
    { id: personIds.ana, owner_id: state.user.id, nombre: "Ana Torres", tipo: "socio", estatus: "activo", limite_credito: 0 },
    { id: personIds.luisa, owner_id: state.user.id, nombre: "Luisa Gómez", tipo: "socio", estatus: "activo", limite_credito: 0 },
    { id: personIds.javier, owner_id: state.user.id, nombre: "Javier Cruz", tipo: "externo", estatus: "activo", limite_credito: 3000 }
  ];
  state.loans = [
    { id: "demo-loan-erick", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.erick, capital_original: 2000, tasa_interes: 0.05, interes_total: 100, periodos_interes_calculados: 1, estado: "activo", fecha_desembolso: "2026-10-24", fecha_vencimiento: currentSaturday, metodo_pago: "efectivo" },
    { id: "demo-loan-ana", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.ana, capital_original: 4000, tasa_interes: 0.05, interes_total: 400, periodos_interes_calculados: 2, estado: "activo", fecha_desembolso: "2026-10-10", fecha_vencimiento: olderSaturday, metodo_pago: "transferencia" },
    { id: "demo-loan-javier", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.javier, capital_original: 1500, tasa_interes: 0.05, interes_total: 0, periodos_interes_calculados: 0, estado: "activo", fecha_desembolso: "2026-11-07", fecha_vencimiento: "2026-11-28", metodo_pago: "efectivo" }
  ];
  state.transactions = [
    { id: "demo-tx-erick-savings", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.erick, tipo_movimiento: "ahorro_semanal", monto: 350, fecha_operacion: fortnightSaturday, metodo_pago: "efectivo", anulado: false, creado_at: `${fortnightSaturday}T12:00:00Z` },
    { id: "demo-tx-erick-loan", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.erick, prestamo_id: "demo-loan-erick", tipo_movimiento: "abono_prestamo", monto: 600, capital_aplicado: 500, interes_aplicado: 100, fecha_operacion: previousSaturday, metodo_pago: "transferencia", anulado: false, creado_at: `${previousSaturday}T12:00:00Z` },
    { id: "demo-tx-ana-old", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.ana, tipo_movimiento: "ahorro_semanal", monto: 250, fecha_operacion: olderSaturday, metodo_pago: "efectivo", anulado: false, creado_at: `${olderSaturday}T12:00:00Z` },
    { id: "demo-tx-ana-loan", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.ana, prestamo_id: "demo-loan-ana", tipo_movimiento: "abono_prestamo", monto: 400, capital_aplicado: 0, interes_aplicado: 400, fecha_operacion: previousSaturday, metodo_pago: "efectivo", anulado: false, creado_at: `${previousSaturday}T12:00:00Z` },
    { id: "demo-tx-luisa", owner_id: state.user.id, ciclo_id: cycleId, participante_id: personIds.luisa, tipo_movimiento: "ahorro_semanal", monto: 500, fecha_operacion: currentSaturday, metodo_pago: "transferencia", anulado: false, creado_at: `${currentSaturday}T12:00:00Z` }
  ];
  state.arqueos = []; state.gains = [{ ciclo_id: cycleId, utilidad_neta: 375 }, { ciclo_id: previousCycleId, utilidad_neta: 280 }];
  state.closures = [{ id: "demo-closure-previous", ciclo_id: previousCycleId, utilidad_neta: 280 }]; state.shares = [];
  state.liquidity = { liquidez_total: 5850, fecha: today }; state.expectedBalances = null; state.flow = []; state.refreshAt = new Date().toISOString();
  renderShell();
  toast("Modo de prueba activo. No se abrió ni modificó Supabase.", "success");
}

async function submitDemoLogin() {
  enteringDemo = true;
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) { renderLogin("No pudimos separar la sesión anterior para iniciar el modo de prueba."); return; }
    seedDemoData();
  } catch { renderLogin("No pudimos preparar el modo de prueba. Intenta otra vez."); }
  finally { enteringDemo = false; }
}

function resetDemoData() {
  if (!state.isDemo) return;
  seedDemoData();
  toast("Datos de prueba reiniciados.", "success");
}

function recordDemoCollection(items, person) {
  for (const item of items) {
    if (state.transactions.some((tx) => tx.id === item.id)) continue;
    const payload = item.payload;
    if (item.action === "income") {
      state.transactions.push({ id: item.id, ciclo_id: payload.p_ciclo_id, participante_id: person.id, tipo_movimiento: "ahorro_semanal", monto: payload.p_monto, fecha_operacion: payload.p_fecha_operacion, metodo_pago: payload.p_metodo_pago, anulado: false, creado_at: item.created_at });
      state.liquidity.liquidez_total = Number(state.liquidity.liquidez_total) + Number(payload.p_monto);
    } else {
      const loan = state.loans.find((row) => row.id === payload.p_prestamo_id);
      if (loan) accrueDemoLoanInterest(loan, payload.p_fecha_operacion);
      const interestPaid = Math.min(Number(payload.p_monto), loan ? loanInterestBalance(loan, payload.p_fecha_operacion) : 0);
      const capitalPaid = Math.max(0, Number(payload.p_monto) - interestPaid);
      state.transactions.push({ id: item.id, ciclo_id: payload.p_ciclo_id, participante_id: person.id, prestamo_id: payload.p_prestamo_id, tipo_movimiento: "abono_prestamo", monto: payload.p_monto, capital_aplicado: capitalPaid, interes_aplicado: interestPaid, fecha_operacion: payload.p_fecha_operacion, metodo_pago: payload.p_metodo_pago, anulado: false, creado_at: item.created_at });
      state.liquidity.liquidez_total = Number(state.liquidity.liquidez_total) + Number(payload.p_monto);
      const gain = state.gains.find((row) => row.ciclo_id === payload.p_ciclo_id);
      if (gain) gain.utilidad_neta = Number(gain.utilidad_neta) + interestPaid;
    }
  }
  state.transactions.sort((a, b) => String(b.fecha_operacion).localeCompare(String(a.fecha_operacion)));
  toast("Registro agregado a los datos de prueba. Supabase no recibió ningún cambio.", "success");
  renderShell();
}

function recordDemoLoan(payload, person) {
  if (state.loans.some((row) => row.id === payload.p_id)) return;
  state.loans.unshift({ id: payload.p_id, owner_id: state.user.id, ciclo_id: payload.p_ciclo_id, participante_id: person.id, capital_original: payload.p_capital, tasa_interes: 0.05, interes_total: 0, periodos_interes_calculados: 0, estado: "activo", fecha_desembolso: payload.p_fecha_desembolso, fecha_vencimiento: selectedCycle().fecha_fin, metodo_pago: payload.p_metodo_pago });
  state.transactions.unshift({ id: `demo-loan-tx-${payload.p_id}`, owner_id: state.user.id, ciclo_id: payload.p_ciclo_id, participante_id: person.id, tipo_movimiento: "desembolso_prestamo", monto: payload.p_capital, fecha_operacion: payload.p_fecha_desembolso, metodo_pago: payload.p_metodo_pago, anulado: false, creado_at: new Date().toISOString() });
  state.liquidity.liquidez_total = Math.max(0, Number(state.liquidity.liquidez_total) - Number(payload.p_capital));
  toast("Préstamo creado solo en los datos de prueba. Supabase no recibió cambios.", "success");
  renderShell();
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
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    hand: '<path d="M8 12V5a2 2 0 0 1 4 0v6-7a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v8c0 4-3 7-7 7h-1c-2 0-3-1-4-2l-4-4a2 2 0 0 1 3-3l2 2"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>'
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.home}</svg>`;
}

function selectedCycle() {
  const available = state.cycles.filter((cycle) => cycle.activo);
  return available.find((cycle) => cycle.id === state.selectedCycleId) || available[0] || null;
}

function loadLocalPreferences() {
  try {
    const key = `mi-caja-preferencias-v1:${state.user?.id || "signed-out"}`;
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    state.contactFrequency = value.contactFrequency || {};
    state.missedWeeks = value.missedWeeks || {};
  } catch { state.contactFrequency = {}; state.missedWeeks = {}; }
}

function saveLocalPreferences() {
  if (!state.user || state.isDemo) return;
  try { localStorage.setItem(`mi-caja-preferencias-v1:${state.user.id}`, JSON.stringify({ contactFrequency: state.contactFrequency, missedWeeks: state.missedWeeks })); }
  catch { toast("No pudimos guardar las preferencias en este teléfono.", "error"); }
}

function contactFrequency(person) { return state.contactFrequency[person?.id] || "flexible"; }

function setContactFrequency(personId, frequency) {
  if (!["weekly", "fortnightly", "flexible"].includes(frequency)) return;
  state.contactFrequency[personId] = frequency;
  saveLocalPreferences();
}

function setMissedWeek(personId, saturday, missed) {
  const key = `${personId}:${saturday}`;
  if (missed) state.missedWeeks[key] = true;
  else delete state.missedWeeks[key];
  saveLocalPreferences();
}

function missedWeek(personId, saturday) { return Boolean(state.missedWeeks[`${personId}:${saturday}`]); }

function cycleName(cycle) { return cycle?.nombre || "Sin caja"; }
function participantName(id) { return state.people.find((person) => person.id === id)?.nombre || "Sin persona"; }
function activePeople() { return state.people.filter((person) => person.estatus !== "inactivo"); }
function loanBalance(loan, asOf = todayMx()) {
  return Math.max(0, loanCapitalBalance(loan) + loanInterestBalance(loan, asOf));
}

function loanCapitalBalance(loan) {
  const paidCapital = state.transactions.filter((transaction) => transaction.prestamo_id === loan.id && transaction.tipo_movimiento === "abono_prestamo" && !transaction.anulado).reduce((total, payment) => total + Number(payment.capital_aplicado || 0), 0);
  return Math.max(0, Number(loan.capital_original || 0) - paidCapital);
}

function lastLoanPaymentDate(loan) {
  return state.transactions.filter((tx) => tx.prestamo_id === loan.id && tx.tipo_movimiento === "abono_prestamo" && !tx.anulado)
    .reduce((latest, tx) => String(tx.fecha_operacion) > latest ? String(tx.fecha_operacion) : latest, "");
}

function nextSaturday(value = todayMx()) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return addDays(value, (6 - day + 7) % 7);
}

function savingsWeekRange(cycle, date = todayMx()) {
  const saturday = nextSaturday(date);
  const end = cycle?.fecha_fin && saturday > cycle.fecha_fin ? cycle.fecha_fin : saturday;
  const start = cycle?.fecha_inicio && addDays(end, -6) < cycle.fecha_inicio ? cycle.fecha_inicio : addDays(end, -6);
  return { start, end };
}

function participantDues(person, cycle = selectedCycle()) {
  const frequency = contactFrequency(person);
  if (!person || !cycle) return { person, loans: [], loanTotal: 0, interest: 0, savingsPending: false, type: "", frequency };
  const loans = openLoans(cycle.id).filter((loan) => loan.participante_id === person.id);
  const loanTotal = loans.reduce((sum, loan) => sum + loanBalance(loan), 0);
  const interest = loans.reduce((sum, loan) => sum + loanInterestBalance(loan), 0);
  const range = savingsWeekRange(cycle);
  const savingsRecorded = person.tipo === "socio" && state.transactions.some((tx) =>
    tx.ciclo_id === cycle.id && tx.participante_id === person.id && tx.tipo_movimiento === "ahorro_semanal"
    && !tx.anulado && tx.fecha_operacion >= range.start && tx.fecha_operacion <= range.end
  );
  const savingsPending = person.tipo === "socio" && cycle.activo && todayMx() <= cycle.fecha_fin && frequency !== "flexible"
    && (frequency === "weekly" ? !savingsRecorded : !state.transactions.some((tx) => tx.ciclo_id === cycle.id && tx.participante_id === person.id && tx.tipo_movimiento === "ahorro_semanal" && !tx.anulado && tx.fecha_operacion >= addDays(todayMx(), -13)));
  const hasLoan = loanTotal > 0.01;
  const type = savingsPending && hasLoan ? "Caja y réditos" : savingsPending ? "Caja de ahorro" : hasLoan ? "Réditos" : "";
  return { person, loans, loanTotal, interest, savingsPending, type, week: range, frequency };
}

function collectablePeople(cycle = selectedCycle()) {
  return state.people.filter((person) => person.estatus !== "inactivo")
    .map((person) => participantDues(person, cycle))
    .filter((due) => due.savingsPending || due.loanTotal > 0.01);
}

function contactCalendar(person, cycle) {
  if (!person || !cycle) return "";
  const latest = todayMx() < cycle.fecha_fin ? todayMx() : cycle.fecha_fin;
  const weeks = [];
  let saturday = isSaturday(cycle.fecha_inicio) ? cycle.fecha_inicio : nextSaturday(cycle.fecha_inicio);
  for (; saturday <= latest; saturday = addDays(saturday, 7)) {
    const start = saturday === cycle.fecha_inicio ? cycle.fecha_inicio : addDays(saturday, -6);
    const contributions = state.transactions.filter((tx) => tx.ciclo_id === cycle.id && tx.participante_id === person.id && tx.tipo_movimiento === "ahorro_semanal" && !tx.anulado && tx.fecha_operacion >= start && tx.fecha_operacion <= saturday);
    const loanPayments = state.transactions.filter((tx) => tx.ciclo_id === cycle.id && tx.participante_id === person.id && tx.tipo_movimiento === "abono_prestamo" && !tx.anulado && tx.fecha_operacion >= start && tx.fecha_operacion <= saturday);
    const amount = contributions.reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
    const loanAmount = loanPayments.reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
    const marked = missedWeek(person.id, saturday);
    const classes = [amount > 0 ? "week-savings" : "", loanAmount > 0 ? "week-loan" : "", marked && amount <= 0 ? "week-missed" : ""].filter(Boolean).join(" ");
    weeks.push(`<button class="mini-week ${classes}" data-action="calendar-week" data-cycle="${h(cycle.id)}" data-saturday="${saturday}" title="${dateText(saturday)} · Caja ${money(amount)} · Préstamos ${money(loanAmount)}"><span>${new Date(`${saturday}T12:00:00Z`).getUTCDate()}</span></button>`);
  }
  const groups = new Map();
  for (let index = 0; index < weeks.length; index += 1) {
    const saturdayDate = isSaturday(cycle.fecha_inicio) ? addDays(cycle.fecha_inicio, index * 7) : addDays(nextSaturday(cycle.fecha_inicio), index * 7);
    const key = saturdayDate.slice(0, 7);
    groups.set(key, [...(groups.get(key) || []), weeks[index]]);
  }
  return `<section class="calendar-panel mt-4"><div class="flex items-start justify-between gap-3"><div><h4 class="font-extrabold">Calendario de aportaciones</h4><p class="mt-1 text-sm text-slate-500">Verde: ahorro · dorado: pago de préstamo. Toca una semana para ver el detalle.</p></div><button class="btn-quiet" data-action="close-calendar">Cerrar</button></div><div class="month-heatmap mt-3">${[...groups.entries()].reverse().map(([month, cells]) => `<section class="month-card"><h5>${new Intl.DateTimeFormat("es-MX", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`))}</h5><div class="mini-week-grid">${cells.join("")}</div></section>`).join("") || `<p class="text-sm text-slate-500">Todavía no hay semanas para mostrar.</p>`}</div></section>`;
}

function alertCount() { return collectablePeople().length + blockedQueueCount(); }

function queueCount() { return state.pending.filter((item) => item.status === "pending" || item.status === "blocked").length; }
function blockedQueueCount() { return state.pending.filter((item) => item.status === "blocked").length; }
function queuedLabel(item) { return item.action === "loan" ? "Préstamo" : item.action === "income" ? "Ingreso a caja" : (movementLabels[item.payload.p_tipo_movimiento] || item.payload.p_tipo_movimiento); }
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
  const incomePeopleOptions = state.people.filter((person) => person.tipo === "socio" && person.estatus === "activo").map((person) => `<option value="${h(person.id)}" ${person.id === selectedPerson?.id ? "selected" : ""}>${h(person.nombre)}</option>`).join("");
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
    </details>` : item.action === "income" ? `
    <details class="mt-3 rounded-xl bg-slate-50 p-3"><summary class="cursor-pointer text-sm font-bold text-teal-800">Corregir datos y reenviar</summary>
      <form class="mt-3 grid gap-3" data-queue-correction="${h(item.id)}">
        <label class="field-label">Socio<select class="field" name="participant_id" required>${incomePeopleOptions}</select></label>
        <label class="field-label">Cantidad<input class="field" name="amount" type="number" inputmode="decimal" min="0.01" max="${MAX_DB_AMOUNT}" step="0.01" value="${h(payload.p_monto)}" required /></label>
        <label class="field-label">Fecha de aportación<input class="field" name="date" type="date" max="${todayMx()}" value="${h(payload.p_fecha_operacion)}" required /></label>
        <label class="field-label">Forma de entrega<select class="field" name="method" required><option value="efectivo" ${payload.p_metodo_pago === "efectivo" ? "selected" : ""}>Efectivo</option><option value="transferencia" ${payload.p_metodo_pago === "transferencia" ? "selected" : ""}>Transferencia</option></select></label>
        <label class="field-label">Nota<input class="field" name="note" maxlength="1000" value="${h(payload.p_nota || "")}" /></label>
        <p class="text-xs leading-5 text-slate-500">La fecha puede ser cualquier día dentro de la caja. El folio se conservará.</p>
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
  if ((!state.session || !state.user) && !state.isDemo) return;
  if (!state.isDemo && state.user.user_metadata?.must_change_password === true) { renderPasswordChange(); return; }
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  const navItems = [["inicio", "Resumen", "home"], ["alertas", "Pendientes", "bell"], ["prestamos", "Préstamos", "wallet"], ["personas", "Contactos", "people"]];
  const pending = queueCount();
  const alerts = alertCount();
  const greetingName = h(firstName() || "bienvenido");
  const top = `
    <header class="app-header safe-top sticky top-0 z-30 ${state.isDemo ? "demo-header" : ""}">
      <div class="mx-auto flex max-w-4xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div class="flex min-w-0 items-center gap-3"><button class="icon-button" data-action="toggle-menu" aria-label="Abrir perfil e historial">${icon("menu", 21)}</button><div class="min-w-0"><p class="truncate text-base font-extrabold leading-5 text-forest-900">Hola, ${greetingName}, bienvenido,</p><p class="text-sm leading-5 text-slate-600">¿qué quieres hacer hoy?</p><p class="truncate text-[11px] font-semibold text-forest-700">${h(selectedCycle()?.nombre || "La primera temporada se abrirá sola")}</p></div></div>
        <div class="flex shrink-0 items-center gap-2">
          ${pending && isOnline() ? `<button data-action="sync" class="icon-button hidden sm:inline-flex" aria-label="Enviar movimientos pendientes" ${state.syncing ? "disabled" : ""}>${icon("refresh", 18)}</button>` : ""}
          ${state.view === "personas" ? `<button data-action="toggle-person-form" class="btn-primary header-add">${icon("plus", 17)} Agregar</button>` : `<button data-action="navigate" data-view="alertas" class="icon-button alert-button ${state.view === "alertas" ? "active" : ""}" aria-label="Pendientes${alerts ? `, ${alerts}` : ""}">${icon("bell", 21)}${alerts ? `<span class="alert-count">${alerts > 99 ? "99+" : alerts}</span>` : ""}</button>`}
        </div>
      </div>
    </header>`;
  const drawer = state.menuOpen ? `<div class="drawer-backdrop" data-drawer-backdrop><aside class="drawer-panel safe-top safe-bottom" data-drawer="true">
    <div class="flex items-center justify-between"><div><p class="text-xs font-bold uppercase tracking-wide text-forest-700">Mi Caja</p><h2 class="text-xl font-extrabold">Tu cuenta</h2></div><button class="icon-button" data-action="close-menu" aria-label="Cerrar menú">${icon("close", 19)}</button></div>
    <div class="profile-user-card mt-4"><span class="profile-avatar">${h((firstName() || "M").slice(0, 1))}</span><span class="min-w-0"><strong class="block text-lg">${h(firstName() || "Cuenta activa")}</strong><span class="block break-all text-sm text-white/75">${h(state.user.email || "Cuenta activa")}</span></span></div>
    <button class="menu-link mt-5 w-full" data-action="navigate" data-view="calendario"><span>${icon("calendar", 19)}<span>Calendario de la caja</span></span>${icon("arrow", 17)}</button>
    <button class="menu-link mt-3 w-full" data-action="navigate" data-view="temporadas"><span>${icon("calendar", 19)}<span>Historial de cajas</span></span><span class="badge badge-green">${state.cycles.length}</span></button>
    ${renderYearHistory()}
    ${selectedCycle()?.activo && selectedCycle().fecha_fin <= todayMx() ? `<button class="btn-secondary mt-3 w-full" data-action="navigate" data-view="temporadas">Entregar temporada</button>` : ""}
    <section class="profile-section mt-5">${state.isDemo ? `<div class="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">El cambio de contraseña no está disponible en datos de prueba.</div>` : `<h3 class="font-extrabold">Cambiar contraseña</h3><form id="profile-password-form" class="mt-3 space-y-3"><label class="field-label">Contraseña actual<input class="field" name="current" type="password" autocomplete="current-password" required /></label><label class="field-label">Nueva contraseña<input class="field" name="password" type="password" autocomplete="new-password" minlength="10" required /></label><label class="field-label">Repite la nueva contraseña<input class="field" name="confirm" type="password" autocomplete="new-password" minlength="10" required /></label><button class="btn-secondary w-full" type="submit">Guardar contraseña</button></form>`}<button data-action="logout" class="btn-quiet mt-3 w-full text-rose-700">${icon("logout", 17)} ${state.isDemo ? "Salir del modo de prueba" : "Cerrar sesión"}</button></section>
  </aside></div>` : "";
  const page = `
    <div class="mx-auto min-h-[calc(100vh-66px)] max-w-4xl">
      <main class="min-w-0 px-4 pb-28 pt-4 sm:px-6 sm:pt-6">
        ${state.view !== "inicio" ? `<div class="mb-4 flex items-center justify-between gap-3"><h1 class="text-xl font-extrabold text-forest-900 sm:text-2xl">${viewNames[state.view]}</h1>${state.view !== "personas" && !isOnline() ? `<span class="badge badge-amber">Sin conexión</span>` : ""}</div>` : ""}
        ${!isOnline() && state.view !== "inicio" ? `<div class="info-banner mb-4">Sin internet. Los movimientos se guardan en este teléfono y se enviarán cuando vuelva la conexión.</div>` : ""}
        ${state.isDemo ? `<div class="demo-ribbon" role="status">MODO SIMULACIÓN · Datos de prueba <button class="btn-quiet" data-action="reset-demo">Reiniciar datos</button></div>` : pending && state.view !== "inicio" ? `<div class="info-banner mb-4 flex flex-wrap items-center justify-between gap-2"><p><strong>${pending} movimiento${pending === 1 ? "" : "s"}</strong> guardado${pending === 1 ? "" : "s"} en este teléfono.${blockedQueueCount() ? ` ${blockedQueueCount()} necesita${blockedQueueCount() === 1 ? "" : "n"} revisión.` : ""}</p><button data-action="sync" class="btn-secondary px-3 py-2" ${!isOnline() || state.syncing ? "disabled" : ""}>${icon("refresh", 16)} Enviar</button></div>` : ""}
        <section id="view-content">${renderView()}</section>
      </main>
      <nav class="bottom-nav safe-bottom fixed inset-x-0 bottom-0 z-40" aria-label="Navegación principal">${navItems.map(([key, label, iconName]) => `<button data-action="navigate" data-view="${key}" class="bottom-nav-item ${state.view === key ? "active" : ""}" ${state.view === key ? 'aria-current="page"' : ""}>${icon(iconName, 20)}<span>${label}</span></button>`).join("")}</nav>
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
  return `<section class="history-peek mt-4"><p class="text-sm font-bold text-forest-900">${totalCount} caja${totalCount === 1 ? "" : "s"} guardada${totalCount === 1 ? "" : "s"}</p>${years.length ? years.slice(0, 2).map(([year, group]) => { const change = previousGains.get(year); const trend = change === null ? "Primera temporada" : change > 0 ? `Subieron ${money(change)} frente al año anterior` : change < 0 ? `Bajaron ${money(Math.abs(change))} frente al año anterior` : "Se mantuvieron igual"; return `<div class="mt-3 border-t border-slate-100 pt-3"><div class="flex justify-between gap-3"><p class="font-semibold">${h(year)} · ${group.count} caja${group.count === 1 ? "" : "s"}</p><p class="font-bold">${money(group.gains)}</p></div><p class="mt-1 text-sm text-slate-500">Ganancias: ${trend}</p></div>`; }).join("") : `<p class="mt-1 text-sm text-slate-500">Las cajas de otros años aparecerán aquí.</p>`}<button class="btn-quiet mt-3 w-full" data-action="navigate" data-view="temporadas">Ver historial completo</button></section>`;
}

function emptyState(message) { return `<div class="empty">${h(message)}</div>`; }

function statCard(title, value, hint, iconName, tone = "teal") {
  const color = tone === "blue" ? "bg-blue-50 text-blue-700" : tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-teal-50 text-teal-700";
  return `<article class="card"><div class="flex items-start justify-between gap-3"><div><p class="text-sm font-semibold text-slate-500">${title}</p><p class="mt-2 text-2xl font-extrabold tracking-tight">${value}</p><p class="mt-1 text-xs text-slate-400">${hint}</p></div><span class="rounded-xl ${color} p-3">${icon(iconName,21)}</span></div></article>`;
}

function renderDashboard() {
  const cycle = selectedCycle();
  const gains = state.gains.find((item) => item.ciclo_id === cycle?.id);
  const liveLoans = openLoans(cycle?.id);
  const loaned = liveLoans.reduce((sum, loan) => sum + loanCapitalBalance(loan), 0);
  const interestLeft = liveLoans.reduce((sum, loan) => sum + loanInterestBalance(loan), 0);
  const available = Number(state.liquidity?.liquidez_total || 0);
  const generalTotal = available + loaned;
  const loanPercent = generalTotal > 0 ? (loaned / generalTotal) * 100 : 0;
  const availablePercent = Math.max(0, 100 - loanPercent);
  const gainsValue = Number(gains?.utilidad_neta || 0);
  const estimate = gainsValue + interestLeft;
  const interestRows = liveLoans.map((loan) => `<div class="interest-row"><span>${h(participantName(loan.participante_id))}</span><strong>${money(loanInterestBalance(loan))}</strong></div>`).join("");
  return `${!cycle ? `<section class="empty-season"><img src="./icon.svg" alt="" /><h2>${state.cycles.length ? "La siguiente caja se abrirá sola" : "Tu caja se abrirá sola"}</h2><p>Conéctate y registra la primera aportación o préstamo cuando empiece la temporada. Aparecerá automáticamente en tu historial.</p><button class="btn-secondary mt-4" data-action="navigate" data-view="personas">Agregar contactos</button></section>` : ""}
    <section class="balance-card" aria-label="Saldo y distribución del dinero">
      <p class="balance-eyebrow">Saldo actual</p><p class="balance-value">${state.liquidity ? money(available) : "—"}</p>
      <p class="balance-caption">Es el dinero que hay en la caja ahora mismo.</p>
      <div class="balance-track" role="img" aria-label="${availablePercent.toFixed(0)} por ciento disponible y ${loanPercent.toFixed(0)} por ciento prestado"><span class="balance-in" style="width:${availablePercent}%"></span><span class="balance-loaned" style="width:${loanPercent}%"></span></div>
      <div class="balance-legend"><span><i class="legend-dot legend-mint"></i>En la caja ${availablePercent.toFixed(0)}%</span><span><i class="legend-dot legend-gold"></i>Prestado ${loanPercent.toFixed(0)}%</span></div>
      ${state.liquidity ? `<p class="balance-date">Actualizado ${dateText(state.liquidity.fecha)}</p>` : `<p class="balance-date">Se actualizará al cargar la caja.</p>`}
    </section>
    <div class="finance-grid mt-4">
      <article class="finance-card"><p>Dinero total general</p><strong>${money(generalTotal)}</strong><span>Lo que hay en la caja más lo que está prestado.</span></article>
      <article class="finance-card loan-finance-card"><p>En préstamo</p><strong>${money(loaned)}</strong><span>${loanPercent.toFixed(0)}% del total · ${liveLoans.length} préstamo${liveLoans.length === 1 ? "" : "s"}</span><details class="interest-details"><summary>Ver detalle de réditos</summary><p class="interest-total">${money(interestLeft)} por cobrar</p><span>Rédito simple: 5% cada 15 días completos sobre el capital pendiente; los pagos a capital reducen los periodos siguientes.</span>${interestRows || `<p class="mt-2 text-sm text-slate-500">No hay réditos por cobrar.</p>`}</details></article>
      <article class="finance-card"><p>Ganancias</p><strong class="finance-green">${money(gainsValue)}</strong><span>Intereses y multas, menos gastos.</span></article>
      <article class="finance-card estimate-card"><p>Estimado</p><strong>${money(estimate)}</strong><span>Ganancias actuales más ${money(interestLeft)} de réditos por cobrar al 5%.</span></article>
    </div>
    <section class="movements-callout mt-4"><div><h2>¿Quieres revisar un registro?</h2><p>Consulta los movimientos por fecha o por mes.</p></div><button class="btn-primary" data-action="navigate" data-view="movimientos">Ver movimientos</button></section>`;
}

function renderAlerts() {
  const cycle = selectedCycle();
  const today = todayMx();
  const dues = collectablePeople(cycle);
  const cards = dues.map((due) => {
    const lateDays = due.loans.reduce((max, loan) => Math.max(max, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${loan.fecha_vencimiento}T00:00:00Z`)) / 86400000)), 0);
    const loanStatus = due.loanTotal > 0.01 ? (lateDays > 0 ? `${lateDays} día${lateDays === 1 ? "" : "s"} de retraso` : due.loans.some((loan) => loan.fecha_vencimiento === today) ? "Vence hoy" : "Préstamo por pagar") : "";
    const badge = due.type === "Caja y réditos" ? "badge-both" : due.type === "Caja de ahorro" ? "badge-green" : "badge-amber";
    return `<article class="due-card"><div class="flex flex-wrap items-start justify-between gap-3"><div class="min-w-0"><h3 class="text-lg font-extrabold">${h(due.person.nombre)}</h3><span class="badge ${badge} mt-2">${due.type}</span><span class="badge badge-gray ml-2 mt-2">${due.frequency === "weekly" ? "Cada semana" : "Cada 15 días"}</span></div>${lateDays > 0 && due.loanTotal > 0.01 ? `<span class="badge badge-red">Atrasado</span>` : ""}</div><div class="due-detail mt-4">${due.savingsPending ? `<p><strong>Aportación por registrar:</strong> recordatorio de ${due.frequency === "weekly" ? "esta semana" : "los últimos 15 días"}.</p>` : ""}${due.loanTotal > 0.01 ? `<p><strong>Préstamos por cobrar:</strong> ${money(due.loanTotal)}${loanStatus ? ` · ${loanStatus}` : ""}</p><p><strong>Réditos pendientes:</strong> ${money(due.interest)}</p>` : ""}</div><div class="mt-4 flex flex-wrap gap-2"><button class="btn-secondary" data-action="whatsapp" data-person="${h(due.person.id)}">${icon("message", 17)} Recordar</button><button class="btn-primary" data-action="collect-person" data-person="${h(due.person.id)}">${due.savingsPending && due.loanTotal <= 0.01 ? "Anotar ahorro" : "Cobrar"}</button></div></article>`;
  }).join("");
  const blocked = state.pending.filter((item) => item.status === "blocked");
  return `<div class="space-y-4"><section class="section-intro"><p>Recordatorios flexibles y pagos por cobrar. Puedes elegir cada semana, cada 15 días o sin recordatorio para cada contacto.</p>${cycle ? `<span>Semana actual: ${dateText(savingsWeekRange(cycle).start)} – ${dateText(savingsWeekRange(cycle).end)}</span>` : ""}</section>${cards || `<section class="empty-season"><h2>Todo al día</h2><p>No hay recordatorios ni préstamos por cobrar.</p></section>`}${blocked.length ? `<section class="attention-card"><div class="flex items-start justify-between gap-3"><div><h2 class="font-extrabold">Movimientos rechazados</h2><p class="mt-1 text-sm">${blocked.length} movimiento${blocked.length === 1 ? "" : "s"} necesita${blocked.length === 1 ? "" : "n"} revisión. Abre cada aviso para corregirlo o descartarlo; los demás siguen sincronizándose.</p></div><span class="badge badge-red">${blocked.length}</span></div><div class="mt-4 space-y-3">${blocked.map(renderQueueEntry).join("")}</div></section>` : ""}${state.pending.some((item) => item.status === "pending") ? `<section class="card"><div class="flex items-center justify-between gap-3"><div><h2 class="font-extrabold">Guardados en este teléfono</h2><p class="mt-1 text-sm text-slate-500">Se enviarán con el mismo folio al recuperar la conexión.</p></div><button data-action="sync" class="btn-secondary" ${!isOnline() || state.syncing ? "disabled" : ""}>Enviar ahora</button></div>${state.pending.filter((item) => item.status === "pending").map(renderQueueEntry).join("")}</section>` : ""}</div>`;
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
  return `<div class="space-y-5"><section class="card"><div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-lg font-extrabold">Estado de cuenta</h2><p class="mt-1 text-sm text-slate-500">${state.statementPersonId ? `Movimientos de ${h(participantName(state.statementPersonId))}.` : "Movimientos más recientes primero."}</p></div><div class="flex flex-wrap gap-2">${state.statementPersonId ? '<button class="btn-secondary" data-action="clear-person-statement">Ver todos</button>' : ""}${state.isDemo ? "" : '<button class="btn-primary" data-action="new-movement">Anotar movimiento</button>'}</div></div><div class="mt-4 grid gap-3 sm:grid-cols-3"><div class="rounded-xl bg-teal-50 p-3"><p class="text-sm text-slate-600">Ahorros recibidos</p><p class="mt-1 text-lg font-extrabold">${money(savings)}</p></div><div class="rounded-xl bg-blue-50 p-3"><p class="text-sm text-slate-600">Préstamos entregados</p><p class="mt-1 text-lg font-extrabold">${money(loansGiven)}</p></div><div class="rounded-xl bg-slate-50 p-3"><p class="text-sm text-slate-600">Abonos cobrados</p><p class="mt-1 text-lg font-extrabold">${money(payments)}</p></div></div><div class="mt-4 flex flex-wrap items-end gap-3"><label class="field-label min-w-[180px]">Consultar por mes<select id="statement-month" class="field"><option value="">Todos los meses</option>${months.map((value) => `<option value="${value}" ${value === month ? "selected" : ""}>${new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T12:00:00Z`))}</option>`).join("")}</select></label><p class="pb-3 text-sm text-slate-500">${month ? `Total registrado: <strong class="text-ink">${money(rows.reduce((sum, tx) => sum + Number(tx.monto || 0), 0))}</strong>` : `${rows.length} movimiento${rows.length === 1 ? "" : "s"}`}</p></div></section><section class="card">${renderTransactionsTable(rows, true)}</section>${state.pending.length ? `<section class="card"><div class="flex items-center justify-between gap-3"><div><h2 class="font-extrabold">Pendientes guardados</h2><p class="mt-1 text-sm text-slate-500">Si uno se rechaza, los demás se sincronizan por separado.</p></div><button class="btn-secondary" data-action="sync" ${!isOnline() || state.syncing ? "disabled" : ""}>Sincronizar</button></div><div class="mt-4 space-y-3">${state.pending.map(renderQueueEntry).join("")}</div></section>` : ""}<section class="card"><h3 class="font-extrabold">Historial de temporadas</h3><p class="mt-2 text-sm text-slate-600">Consulta las cajas anteriores desde tu menú.</p><button class="btn-secondary mt-3" data-action="navigate" data-view="temporadas">Ver historial de cajas</button></section></div>`;
}

function calendarWeeks(cycle) {
  if (!cycle) return [];
  const latest = todayMx() < cycle.fecha_fin ? todayMx() : cycle.fecha_fin;
  const firstSaturday = isSaturday(cycle.fecha_inicio) ? cycle.fecha_inicio : nextSaturday(cycle.fecha_inicio);
  const weeks = [];
  for (let saturday = firstSaturday, index = 1; saturday <= latest; saturday = addDays(saturday, 7), index += 1) {
    const start = saturday === cycle.fecha_inicio ? cycle.fecha_inicio : addDays(saturday, -6);
    const rows = state.transactions.filter((tx) => tx.ciclo_id === cycle.id && !tx.anulado && tx.fecha_operacion >= start && tx.fecha_operacion <= saturday);
    const savings = rows.filter((tx) => tx.tipo_movimiento === "ahorro_semanal");
    const loanPayments = rows.filter((tx) => tx.tipo_movimiento === "abono_prestamo");
    weeks.push({
      cycle, index, saturday, start, rows,
      savingsTotal: savings.reduce((sum, tx) => sum + Number(tx.monto || 0), 0),
      loanTotal: loanPayments.reduce((sum, tx) => sum + Number(tx.monto || 0), 0),
      interestTotal: loanPayments.reduce((sum, tx) => sum + Number(tx.interes_aplicado || 0), 0)
    });
  }
  return weeks;
}

function renderCalendarWeekDetail(week) {
  if (!week) return `<section class="empty-season"><h2>Elige una semana</h2><p>Toca un bloque del calendario para ver quién aportó y cuánto entró.</p></section>`;
  const grouped = new Map();
  for (const tx of week.rows) {
    if (!tx.participante_id) continue;
    const row = grouped.get(tx.participante_id) || { name: participantName(tx.participante_id), total: 0, savings: 0, loan: 0 };
    row.total += Number(tx.monto || 0);
    if (tx.tipo_movimiento === "ahorro_semanal") row.savings += Number(tx.monto || 0);
    if (tx.tipo_movimiento === "abono_prestamo") row.loan += Number(tx.monto || 0);
    grouped.set(tx.participante_id, row);
  }
  const rows = [...grouped.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, "es"));
  const registerButtons = rows.filter(([id]) => state.people.some((person) => person.id === id)).map(([id, row]) => {
    const person = state.people.find((item) => item.id === id);
    return `<div class="movement-row"><div class="min-w-0"><p class="truncate font-bold">${h(row.name)}</p><p class="mt-1 text-xs text-slate-500">Caja ${money(row.savings)} · Préstamo ${money(row.loan)}</p></div><div class="flex shrink-0 items-center gap-2"><strong>${money(row.total)}</strong>${week.cycle.activo ? `<button class="btn-quiet" data-action="calendar-collect" data-person="${h(person.id)}" data-saturday="${week.saturday}">Anotar</button>` : ""}</div></div>`;
  }).join("");
  const canRegister = week.cycle.activo && week.saturday <= todayMx();
  const totalIn = week.savingsTotal + week.loanTotal;
  return `<section class="card"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="eyebrow">Semana #${week.index}</p><h2 class="mt-1 text-lg font-extrabold">${dateText(week.start)} – ${dateText(week.saturday)}</h2><p class="mt-1 text-sm text-slate-500">${h(cycleName(week.cycle))}</p></div>${canRegister ? `<button class="btn-primary" data-action="calendar-collect" data-saturday="${week.saturday}">${icon("plus", 17)} Registrar pago</button>` : `<span class="badge badge-gray">Solo consulta</span>`}</div><div class="calendar-totals mt-4"><div><span>Entró por ahorro</span><strong>${money(week.savingsTotal)}</strong></div><div><span>Entró por préstamos</span><strong>${money(week.loanTotal)}</strong></div><div><span>Réditos cobrados</span><strong>${money(week.interestTotal)}</strong></div><div><span>Total recibido</span><strong>${money(totalIn)}</strong></div></div>${canRegister ? `<div class="calendar-quick-register mt-4"><label class="field-label">Registrar pago de<select class="field" id="calendar-quick-person"><option value="">Elige a una persona</option>${participantOptions("all", "", true)}</select></label><button class="btn-secondary mt-2 w-full" data-action="calendar-collect" data-saturday="${week.saturday}">Abrir registro para este sábado</button></div>` : ""}<h3 class="mt-5 font-extrabold">Personas que pagaron</h3><div class="mt-3 space-y-2">${registerButtons || emptyState("Todavía no hay pagos en esta semana.")}</div><p class="mt-3 text-xs text-slate-500">El total recibido suma ahorros y abonos anotados. Toca “Anotar” para registrar otro pago con la fecha de este sábado.</p></section>`;
}

function renderGlobalCalendar() {
  const cycle = state.cycles.find((item) => item.id === state.calendarCycleId) || selectedCycle() || state.cycles[0] || null;
  if (!cycle) return `<section class="empty-season"><h2>Aún no hay cajas</h2><p>El calendario aparecerá cuando la caja se abra con el primer movimiento.</p></section>`;
  const weeks = calendarWeeks(cycle);
  const months = [...new Set(weeks.map((week) => week.saturday.slice(0, 7)))].sort();
  const visibleWeeks = weeks.filter((week) => !state.calendarMonth || week.saturday.startsWith(state.calendarMonth));
  const groups = new Map();
  for (const week of visibleWeeks) groups.set(week.saturday.slice(0, 7), [...(groups.get(week.saturday.slice(0, 7)) || []), week]);
  let selected = weeks.find((week) => week.saturday === state.calendarWeek) || null;
  const jumpNumber = Number(String(window.location.hash.match(/#S(\d+)/i)?.[1] || ""));
  if (!selected && jumpNumber > 0) selected = weeks.find((week) => week.index === jumpNumber) || null;
  if (!selected && state.calendarWeek) selected = weeks.find((week) => week.index === Number(String(state.calendarWeek).replace(/\D/g, ""))) || null;
  const cycleChoices = [...state.cycles].sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)));
  return `<div class="space-y-4"><section class="card"><div class="flex flex-wrap items-end justify-between gap-3"><div><p class="eyebrow">Ahorros y pagos por semana</p><h2 class="mt-1 text-xl font-extrabold">Calendario de la caja</h2><p class="mt-1 text-sm text-slate-500">El bloque corresponde al sábado que cierra cada semana.</p></div><form id="calendar-jump-form" class="calendar-jump"><label class="field-label">Ir a semana<input class="field" name="week" inputmode="numeric" placeholder="#S12" aria-label="Número de semana, por ejemplo S12" /></label><button class="btn-secondary mt-1" type="submit">Ir</button></form></div><div class="mt-4 grid gap-3 sm:grid-cols-2"><label class="field-label">Caja<select id="calendar-cycle" class="field">${cycleChoices.map((item) => `<option value="${h(item.id)}" ${item.id === cycle.id ? "selected" : ""}>${h(item.nombre || cycleName(item))}</option>`).join("")}</select></label><label class="field-label">Filtrar por mes<select id="calendar-month" class="field"><option value="">Todos los meses</option>${months.map((month) => `<option value="${month}" ${state.calendarMonth === month ? "selected" : ""}>${new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`))}</option>`).join("")}</select></label></div><div class="calendar-legend mt-4"><span><i class="legend-dot legend-mint"></i>Ahorro recibido</span><span><i class="legend-dot legend-gold"></i>Abono de préstamo</span><span><i class="legend-dot legend-empty"></i>Sin movimientos</span></div><div class="month-heatmap mt-4">${[...groups.entries()].reverse().map(([month, items]) => `<section class="month-card"><h3>${new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`))}</h3><div class="week-heatmap">${items.map((week) => `<button class="week-cell ${week.savingsTotal > 0 ? "week-savings" : ""} ${week.loanTotal > 0 ? "week-loan" : ""} ${selected?.saturday === week.saturday ? "week-selected" : ""}" data-action="calendar-week" data-cycle="${h(cycle.id)}" data-saturday="${week.saturday}" aria-label="Semana ${week.index}, sábado ${dateText(week.saturday)}, ahorro ${money(week.savingsTotal)}, préstamos ${money(week.loanTotal)}"><span>#S${week.index}</span><small>${new Date(`${week.saturday}T12:00:00Z`).getUTCDate()}</small></button>`).join("")}</div></section>`).join("") || emptyState("No hay semanas para mostrar en esta temporada.")}</div></section>${renderCalendarWeekDetail(selected)}</div>`;
}

function renderTransactionsTable(rows, allowCancel = false) {
  if (!rows.length) return emptyState("No hay movimientos en esta caja.");
  const sorted = [...rows].sort((a, b) => String(b.fecha_operacion).localeCompare(String(a.fecha_operacion)) || String(b.creado_at).localeCompare(String(a.creado_at)));
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Movimiento</th><th>Persona</th><th>Forma de pago</th><th>Monto</th>${allowCancel ? "<th></th>" : ""}</tr></thead><tbody>${sorted.map((tx) => `<tr><td>${dateText(tx.fecha_operacion)}</td><td>${h(movementLabels[tx.tipo_movimiento] || tx.tipo_movimiento)}${tx.anulado ? ` <span class="badge badge-red">Anulado</span>` : ""}</td><td>${h(participantName(tx.participante_id))}</td><td>${h(paymentLabels[tx.metodo_pago] || tx.metodo_pago)}</td><td class="font-bold">${money(tx.monto)}</td>${allowCancel ? `<td>${!tx.anulado ? `<button class="btn-quiet text-rose-700" data-action="cancel-tx" data-id="${h(tx.id)}">Anular</button>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

function whatsappLink(person) {
  const due = participantDues(person);
  if (!due.savingsPending && due.loanTotal <= 0.01) { toast("Esta persona no tiene nada pendiente por cobrar.", "info"); return; }
  let phone = state.contactPhones[person.id] || "";
  if (!phone) {
    const phoneInput = window.prompt(`Escribe el número de WhatsApp de ${person.nombre}, con lada de país (solo números). Se guardará solo en este teléfono.`);
    if (!phoneInput) return;
    phone = phoneInput.replace(/\D/g, "");
    if (phone.length < 10 || phone.length > 15) { toast("Escribe un número con lada de país, por ejemplo 5215512345678.", "error"); return; }
    saveContactPhone(person.id, phone).then(() => toast("Teléfono guardado en este dispositivo.", "success"));
  }
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Mexico_City" }).format(new Date()));
  const greeting = hour >= 5 && hour < 12 ? "buenos días" : hour >= 12 && hour < 19 ? "buenas tardes" : "buenas noches";
  const lines = [];
  if (due.savingsPending) lines.push(`Te recordamos tu aportación a la caja (${due.frequency === "weekly" ? "cada semana" : "cada 15 días"}), si ya te corresponde. Cuando la entregues, la anotamos con gusto.`);
  if (due.loanTotal > 0.01) {
    if (due.loanTotal - due.interest <= 0.01 && due.interest > 0.01) lines.push(`Quedan ${money(due.interest)} de réditos pendientes por pagar.`);
    else lines.push(`Tienes ${money(due.loanTotal)} pendiente de tus préstamos${due.interest > 0.01 ? `, incluidos ${money(due.interest)} de réditos` : ""}.`);
  }
  const kind = due.savingsPending && due.loanTotal > 0.01 ? "Caja y réditos" : due.savingsPending ? "Caja de ahorro" : "Réditos";
  const message = `Hola, ${greeting}, ${person.nombre} 😊\n\n${kind}: ${lines.join(" ")}\n\nCuando puedas, ¿nos apoyas con este pendiente? Si ya lo atendiste, puedes ignorar este mensaje. ¡Gracias! 🙌`;
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
}

function renderContactHistory(transactions, person) {
  const groups = new Map();
  for (const tx of transactions) {
    const month = String(tx.fecha_operacion || "").slice(0, 7) || "sin-fecha";
    groups.set(month, [...(groups.get(month) || []), tx]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  if (!ordered.length) return `<p class="mt-3 text-sm text-slate-500">${h(person.nombre)} todavía no tiene movimientos.</p>`;
  return `<div class="contact-month-history mt-3">${ordered.map(([month, rows], index) => {
    const monthLabel = month === "sin-fecha" ? "Sin fecha" : new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
    return `<details class="contact-history-month" ${index === 0 ? "open" : ""}><summary><span>${h(monthLabel)}</span><span>${rows.length} movimiento${rows.length === 1 ? "" : "s"}</span></summary><div class="mt-2 space-y-2">${rows.map((tx) => `<div class="movement-row"><div><p class="font-semibold">${h(movementLabels[tx.tipo_movimiento] || tx.tipo_movimiento)}${tx.anulado ? " · Anulado" : ""}</p><p class="mt-1 text-sm text-slate-500">${dateText(tx.fecha_operacion)} · ${h(paymentLabels[tx.metodo_pago] || tx.metodo_pago)}</p></div><strong>${money(tx.monto)}</strong></div>`).join("")}</div></details>`;
  }).join("")}</div>`;
}

function renderPeople() {
  const cycleId = selectedCycle()?.id;
  const query = state.personSearch.toLocaleLowerCase("es").trim();
  const digits = query.replace(/\D/g, "");
  const people = state.people.filter((person) => person.nombre.toLocaleLowerCase("es").includes(query) || (digits && String(state.contactPhones[person.id] || "").includes(digits)))
    .filter((person) => state.personFilter !== "with-movements" || state.transactions.some((tx) => tx.participante_id === person.id));
  const personRows = people.map((person) => {
    const due = participantDues(person, selectedCycle());
    const loans = state.loans.filter((loan) => loan.participante_id === person.id && loan.ciclo_id === cycleId && loan.estado === "activo");
    const balance = due.loanTotal;
    const transactions = state.transactions.filter((tx) => tx.participante_id === person.id).sort((a, b) => String(b.fecha_operacion).localeCompare(String(a.fecha_operacion)) || String(b.creado_at).localeCompare(String(a.creado_at)));
    const selected = state.selectedPersonId === person.id;
    const phone = state.contactPhones[person.id];
    const dueBadge = due.type ? `<span class="badge ${due.type === "Caja y réditos" ? "badge-both" : due.type === "Caja de ahorro" ? "badge-green" : "badge-amber"}">${due.type}</span>` : "";
    const frequencyControl = person.tipo === "socio" ? `<label class="field-label mt-4">Frecuencia de recordatorio<select id="contact-frequency" class="field" data-person="${h(person.id)}"><option value="weekly" ${contactFrequency(person) === "weekly" ? "selected" : ""}>Cada semana</option><option value="fortnightly" ${contactFrequency(person) === "fortnightly" ? "selected" : ""}>Cada 15 días</option><option value="flexible" ${contactFrequency(person) === "flexible" ? "selected" : ""}>Flexible, sin aviso automático</option></select></label>` : "";
    const calendar = state.calendarPersonId === person.id ? contactCalendar(person, selectedCycle()) : "";
    return `<article class="contact-card ${person.tipo === "externo" ? "external" : ""} ${selected ? "expanded" : ""}"><button class="contact-heading" data-action="toggle-person" data-id="${h(person.id)}" aria-expanded="${selected}"><span class="min-w-0"><strong class="block truncate text-base">${h(person.nombre)}</strong><span class="mt-2 flex flex-wrap items-center gap-2">${person.tipo === "externo" ? '<span class="badge badge-amber">No participa en caja</span>' : '<span class="badge badge-green">Socio</span>'}${dueBadge}</span><span class="mt-2 block truncate text-sm text-slate-500">${h(phone || "Sin teléfono")}</span></span><span class="shrink-0 text-right">${balance > 0.01 ? `<strong class="block text-lg">${money(balance)}</strong><span class="text-sm text-slate-500">por cobrar</span>` : `<span class="badge badge-gray">Al corriente</span>`}</span></button>${selected ? `<div class="contact-details"><div class="flex flex-wrap gap-2">${person.tipo === "socio" || loans.length ? `<button class="btn-primary" data-action="collect-person" data-person="${h(person.id)}">${person.tipo === "socio" ? "Registrar ingreso o pago" : "Registrar pago"}</button>` : `<button class="btn-primary" data-action="loan-person" data-person="${h(person.id)}">Prestar dinero</button>`}<button class="btn-secondary" data-action="whatsapp" data-person="${h(person.id)}">${icon("message",16)} WhatsApp</button>${person.tipo === "socio" ? `<button class="btn-secondary" data-action="toggle-calendar" data-person="${h(person.id)}">${icon("calendar", 16)} ${state.calendarPersonId === person.id ? "Ocultar calendario" : "Ver calendario"}</button>` : ""}</div>${frequencyControl}<h3 class="mt-5 font-extrabold">Movimientos de ${h(person.nombre)}</h3><p class="mt-1 text-xs text-slate-500">Agrupados por mes, del más reciente al más antiguo.</p>${renderContactHistory(transactions, person)}${calendar}</div>` : ""}</article>`;
  }).join("");
  const withMovementsCount = state.people.filter((person) => state.transactions.some((tx) => tx.participante_id === person.id)).length;
  return `<div class="space-y-4"><section class="card"><p class="text-sm text-slate-600">Toca una persona para consultar sus movimientos, su calendario y sus pagos pendientes.</p>${state.showPersonForm ? `<form id="person-form" class="person-form mt-5"><label class="field-label">Nombre completo<input class="field" name="name" maxlength="200" required placeholder="Nombre de la persona" /></label><label class="field-label">Teléfono de WhatsApp<input class="field" name="phone" type="tel" inputmode="tel" maxlength="20" required placeholder="Con lada de país" /></label><p class="text-sm text-slate-500">Al agregarlo, participa en la caja. El teléfono se guarda solo en este teléfono.</p><div class="flex gap-2"><button class="btn-primary" type="submit" ${!isOnline() && !state.isDemo || state.syncing ? "disabled" : ""}>Guardar socio</button><button class="btn-secondary" type="button" data-action="toggle-person-form">Cancelar</button></div></form>` : ""}</section><section class="card"><div class="flex flex-wrap items-end justify-between gap-3"><form id="search-person-form" class="search-form"><label class="search-box">${icon("search", 19)}<input name="query" type="search" value="${h(state.personSearch)}" placeholder="Buscar socio o teléfono" aria-label="Buscar contacto" /></label></form><button class="btn-secondary" data-action="general-movements">Movimientos generales</button></div><div class="mt-4 flex flex-wrap gap-2"><button class="filter-chip ${state.personFilter === "all" ? "active" : ""}" data-action="person-filter" data-filter="all">Todos (${state.people.length})</button><button class="filter-chip ${state.personFilter === "with-movements" ? "active" : ""}" data-action="person-filter" data-filter="with-movements">Con movimientos (${withMovementsCount})</button></div><div class="mt-4 space-y-3">${personRows || emptyState("No encontramos contactos con ese nombre.")}</div></section></div>`;
}

function renderLoans() {
  const cycle = selectedCycle();
  const hasLoanPending = state.pending.some((item) => item.action === "loan" && item.payload.p_ciclo_id === cycle?.id);
  const loans = state.loans.filter((loan) => loan.ciclo_id === cycle?.id).sort((a, b) => String(b.fecha_desembolso).localeCompare(String(a.fecha_desembolso)));
  const open = loans.filter((loan) => loanBalance(loan) > 0.01);
  const rows = open.map((loan) => { const person = state.people.find((row) => row.id === loan.participante_id); const due = participantDues(person, cycle); return `<article class="loan-card ${person?.tipo === "externo" ? "external" : ""}"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="text-lg font-extrabold">${h(participantName(loan.participante_id))}</h3><div class="mt-2 flex flex-wrap gap-2">${person?.tipo === "externo" ? '<span class="badge badge-amber">No participa en caja</span>' : '<span class="badge badge-green">Socio</span>'}<span class="badge badge-gray">5% cada 15 días</span></div><p class="mt-2 text-sm text-slate-500">Entregado ${dateText(loan.fecha_desembolso)}</p></div><span class="badge badge-amber">Por cobrar</span></div><div class="loan-numbers mt-4"><div><span>Capital inicial</span><strong>${money(loan.capital_original)}</strong></div><div><span>Réditos actuales</span><strong>${money(loanInterestBalance(loan))}</strong></div><div><span>Falta por pagar</span><strong>${money(loanBalance(loan))}</strong></div></div><div class="mt-4 flex flex-wrap gap-2"><button class="btn-primary" data-action="collect-person" data-person="${h(loan.participante_id)}" data-loan="${h(loan.id)}">Registrar pago</button>${due.loanTotal > 0.01 ? `<button class="btn-secondary" data-action="whatsapp" data-person="${h(loan.participante_id)}">${icon("message", 17)} Recordar</button>` : ""}</div></article>`; }).join("");
  const newContact = state.loanPersonChoice === "__new__";
  return `<div class="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
    <section class="card"><p class="text-xs font-bold uppercase tracking-wide text-teal-700">Nuevo préstamo</p><h2 class="mt-1 text-xl font-extrabold">Prestar dinero</h2><p class="mt-2 text-sm leading-6 text-slate-500">Se calcula 5% cada 15 días completos sobre el capital que siga pendiente. Los pagos a capital reducen los réditos siguientes. No hace falta definir un plazo fijo.</p>
      ${!cycle ? `<p class="info-banner mt-4">La temporada se abrirá al confirmar la primera operación. Necesitas conexión para crear un préstamo.</p>` : ""}
      <form id="loan-form" class="mt-5 space-y-4">
        <label class="field-label">¿A quién se lo prestas?<select class="field" name="person_choice" id="loan-person-choice" required><option value="">Elige un contacto</option>${participantOptions("all", "", true)}<option value="__new__" ${newContact ? "selected" : ""}>Agregar contacto externo</option></select></label>
        <div id="loan-new-contact" class="space-y-4 ${newContact ? "" : "hidden"}"><p class="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Se agregará con la etiqueta “No participa en caja”.</p><label class="field-label">Nombre<input class="field" name="new_name" maxlength="200" ${newContact ? "required" : ""} placeholder="Nombre del contacto" /></label><label class="field-label">Teléfono de WhatsApp<input class="field" name="new_phone" type="tel" inputmode="tel" maxlength="20" placeholder="Con lada de país" /></label></div>
        <label class="field-label">Cantidad a prestar${moneyField("capital", null, { required: true, placeholder: "0.00", extra: `maxlength="16" aria-label="Cantidad a prestar en pesos"` })}</label>
        <label class="field-label">Fecha de entrega (sábado)<input class="field" name="date" type="date" value="${lastSaturdayOnOrBefore()}" min="${cycle?.fecha_inicio || ""}" max="${todayMx()}" required /></label>
        <label class="field-label">Forma de entrega<select class="field" name="method"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
        <button class="btn-primary w-full" type="submit" ${(!isOnline() && !state.isDemo) || state.syncing || hasLoanPending ? "disabled" : ""}>Confirmar préstamo</button>
        ${hasLoanPending ? `<p class="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">Hay un préstamo pendiente de confirmar. Espera a que sincronice o revisa el folio guardado antes de intentar otro.</p>` : ""}
      </form>
    </section>
    <section class="card"><div class="mb-4"><h2 class="text-lg font-extrabold">Ver préstamos activos</h2><p class="text-sm text-slate-600">Consulta el saldo pendiente y registra los pagos.</p></div>${rows ? `<div class="space-y-3">${rows}</div>` : emptyState("No hay préstamos por cobrar.")}${loans.some((loan) => loanBalance(loan) <= 0.01) ? `<details class="mt-5"><summary class="cursor-pointer text-sm font-bold text-slate-600">Préstamos pagados (${loans.filter((loan) => loanBalance(loan) <= 0.01).length})</summary><div class="mt-3 space-y-2">${loans.filter((loan) => loanBalance(loan) <= 0.01).map((loan) => `<p class="rounded-xl bg-slate-50 p-3 text-sm">${h(participantName(loan.participante_id))} · ${dateText(loan.fecha_desembolso)} · ${money(loan.capital_original + loan.interes_total)}</p>`).join("")}</div></details>` : ""}</section>
  </div>`;
}

function renderCollectionForm() {
  const person = state.people.find((row) => row.id === state.collectionPersonId);
  const cycle = selectedCycle();
  if (!person) return `<section class="empty-season"><h2>No encontramos ese contacto</h2><p>Vuelve a Pendientes o Contactos y selecciona a la persona otra vez.</p><button class="btn-secondary mt-4" data-action="collection-back">Volver</button></section>`;
  const due = participantDues(person, cycle);
  const loans = due.loans;
  const selectedLoan = loans.find((loan) => loan.id === state.selectedLoanForPayment) || loans[0] || null;
  const operationDate = state.collectionDate || todayMx();
  const interest = selectedLoan ? loanInterestBalance(selectedLoan, operationDate) : 0;
  const lastPaymentDate = selectedLoan ? lastLoanPaymentDate(selectedLoan) : "";
  const backdatedLoanDate = Boolean(lastPaymentDate && operationDate < lastPaymentDate);
  const saturdayOnlyHelp = loans.length && (!isSaturday(operationDate) || backdatedLoanDate) ? `<p class="info-banner mt-4">${!isSaturday(operationDate) ? "La aportación de caja puede registrarse hoy. Para un abono de préstamo elige un sábado en el calendario." : `Ese préstamo ya tiene un abono posterior (${dateText(lastPaymentDate)}). Para conservar el cálculo quincenal, registra el abono después de esa fecha.`}</p>` : "";
  const operationDateCaption = operationDate === todayMx() ? `fecha de hoy (${dateText(operationDate)})` : `sábado seleccionado (${dateText(operationDate)})`;
  return `<div class="space-y-4"><section class="collection-person"><button class="btn-quiet" data-action="collection-back">${icon("arrow", 18)} Volver</button><h2 class="mt-3 text-2xl font-extrabold">${h(person.nombre)}</h2><p class="mt-1 text-sm text-slate-600">Anota lo que entregó. Cada movimiento guardará su propio folio.</p>${person.tipo === "externo" ? '<span class="badge badge-amber mt-3">No participa en caja</span>' : '<span class="badge badge-green mt-3">Socio de la caja</span>'}${!cycle ? `<p class="info-banner mt-4">La temporada se abrirá al guardar el primer movimiento. Para abrirla, necesitas conexión a internet.</p>` : `<p class="mt-2 text-xs text-slate-500">${h(cycle.nombre)} · se registrará con la ${operationDateCaption}.</p>`}</section>
    <form id="collection-form" class="card space-y-5">
      ${person.tipo === "socio" ? `<section class="payment-section"><div class="flex items-center justify-between gap-3"><div><h3 class="font-extrabold">Ahorro para la caja</h3><p class="mt-1 text-sm text-slate-600">${due.savingsPending ? "Tiene un recordatorio pendiente." : "Cantidad que aportó."}</p></div><span class="badge badge-green">Caja de ahorro</span></div><label class="field-label mt-4">¿Cuánto aportó?${moneyField("savings", null, { placeholder: "0.00", extra: `maxlength="16" aria-label="Cantidad de ahorro en pesos"` })}</label></section>` : ""}
      ${loans.length ? `<section class="payment-section"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-extrabold">Abono de préstamo</h3><p class="mt-1 text-sm text-slate-600">Se calcula 5% cada 15 días completos sobre el capital pendiente. El pago se aplica primero a réditos y luego a capital.</p></div><span class="badge badge-amber">${loans.length} préstamo${loans.length === 1 ? "" : "s"}</span></div><label class="field-label mt-4">Préstamo<select class="field" name="loan_id" id="collection-loan" required>${loans.map((loan) => `<option value="${h(loan.id)}" ${loan.id === selectedLoan?.id ? "selected" : ""}>Saldo total ${money(loanBalance(loan, operationDate))}</option>`).join("")}</select></label><div class="loan-summary-grid mt-3"><div><span>Réditos pendientes</span><strong>${money(interest)}</strong></div><div><span>Deuda total</span><strong>${money(selectedLoan ? loanBalance(selectedLoan, operationDate) : 0)}</strong></div></div><fieldset class="mt-4"><legend class="field-label">¿Cómo quieres aplicar el pago?</legend><div class="segmented-options mt-2"><label><input type="radio" name="loan_mode" value="interest-only" ${interest > 0 ? "checked" : "disabled"} /><span>Solo réditos</span></label><label><input type="radio" name="loan_mode" value="with-capital" ${interest <= 0 ? "checked" : ""} /><span>Abonar a capital</span></label></div></fieldset><label class="field-label mt-4">Cantidad recibida${moneyField("loan_amount", "collection-loan-amount", { placeholder: "0.00", extra: `maxlength="16" aria-label="Cantidad recibida en pesos" ${!isSaturday(operationDate) || backdatedLoanDate ? "disabled" : ""}` })}</label><div class="interest-preview mt-3"><span>Se aplica a réditos</span><strong id="collection-interest">${money(0)}</strong><span>Se aplica a capital</span><strong id="collection-capital-applied">${money(0)}</strong></div><div class="payment-total"><span>Total recibido</span><strong id="collection-total">${money(0)}</strong></div>${saturdayOnlyHelp}</section>` : ""}
      <label class="field-label">Forma de entrega<select class="field" name="method"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
      <div class="flex flex-wrap gap-2"><button class="btn-primary" type="submit" ${(!cycle && !isOnline()) || state.syncing ? "disabled" : ""}>Guardar ingreso o pago</button><button class="btn-secondary" type="button" data-action="collection-back">Cancelar</button></div>
    </form></div>`;
}

function updateCollectionPreview() {
  const form = document.querySelector("#collection-form");
  if (!form) return;
  const data = new FormData(form);
  const loan = state.loans.find((row) => row.id === String(data.get("loan_id") || ""));
  const payment = moneyInputValue(data.get("loan_amount"));
  const mode = String(data.get("loan_mode") || "interest-only");
  const operationDate = state.collectionDate || todayMx();
  const interestDue = loan ? loanInterestBalance(loan, operationDate) : 0;
  const total = Number.isFinite(payment) && payment > 0 ? Math.min(payment, loan ? (mode === "interest-only" ? interestDue : loanBalance(loan, operationDate)) : 0) : 0;
  const interest = Math.min(total, interestDue);
  const capital = Math.max(0, total - interest);
  const interestLabel = document.querySelector("#collection-interest");
  const capitalLabel = document.querySelector("#collection-capital-applied");
  const totalLabel = document.querySelector("#collection-total");
  if (interestLabel) interestLabel.textContent = money(interest);
  if (capitalLabel) capitalLabel.textContent = money(capital);
  if (totalLabel) totalLabel.textContent = money(total);
}

async function saveCollection(form) {
  const data = new FormData(form);
  const person = state.people.find((row) => row.id === state.collectionPersonId);
  let cycle = selectedCycle();
  const date = state.collectionDate || todayMx();
  const method = String(data.get("method") || "");
  const savings = moneyInputValue(data.get("savings"));
  const loanId = String(data.get("loan_id") || "");
  const loan = state.loans.find((row) => cycle?.activo && row.id === loanId && row.ciclo_id === cycle.id && row.participante_id === person?.id && row.estado === "activo");
  const loanPayment = moneyInputValue(data.get("loan_amount"));
  const interest = loan ? loanInterestBalance(loan, date) : 0;
  if (!person) { toast("El contacto ya no está disponible. Actualiza la información e intenta otra vez.", "error"); return; }
  if (!Number.isFinite(savings) || savings < 0 || savings > MAX_DB_AMOUNT || Math.round(savings * 100) !== savings * 100) { toast("Revisa la cantidad del ahorro; puede quedar en blanco o ser mayor que cero con hasta dos decimales.", "error"); return; }
  if (savings > 0 && (person.tipo !== "socio" || person.estatus !== "activo")) { toast("Solo un socio activo puede aportar ahorro a la caja.", "error"); return; }
  if (loanPayment > 0 && !loan) { toast("Elige uno de los préstamos activos de esta persona.", "error"); return; }
  if (loanPayment > 0 && (!Number.isFinite(loanPayment) || loanPayment > loanBalance(loan, date) || Math.round(loanPayment * 100) !== loanPayment * 100)) { toast("El pago debe ser mayor que cero y no superar el saldo pendiente del préstamo.", "error"); return; }
  if (loanPayment > 0 && !isSaturday(date)) { toast("El ahorro se puede anotar cualquier día. Los abonos de préstamo se registran en sábado; abre el calendario y elige uno.", "error"); return; }
  if (loanPayment > 0 && date < lastLoanPaymentDate(loan)) { toast(`Ese préstamo ya tiene un abono posterior (${dateText(lastLoanPaymentDate(loan))}). Elige una fecha posterior para conservar el orden de los réditos.`, "error"); return; }
  if (savings <= 0 && loanPayment <= 0) { toast("Escribe la cantidad del ahorro recibido o el pago del préstamo.", "error"); return; }
  if (!loan && savings <= 0) { toast("Escribe la cantidad del ahorro recibido.", "error"); return; }
  if (!["efectivo", "transferencia"].includes(method)) { toast("Elige efectivo o transferencia como forma de entrega.", "error"); return; }
  const paymentMode = String(data.get("loan_mode") || "interest-only");
  if (loanPayment > 0 && paymentMode === "interest-only" && loanPayment > interest) { toast(`Elige “Abonar a capital” para un pago mayor que los réditos (${money(interest)}).`, "error"); return; }
  if ((!cycle || !cycle.activo) && !state.isDemo && !isOnline()) { toast("La primera caja se abre con conexión. Conéctate una vez para guardar el primer ingreso; después podrás usar la cola sin señal.", "error"); return; }
  const interestPaid = Math.min(loanPayment, interest);
  const capitalPaid = Math.max(0, loanPayment - interestPaid);
  const summary = [savings > 0 ? `Ahorro: ${money(savings)}` : "", loanPayment > 0 ? `Abono: ${money(loanPayment)} (réditos ${money(interestPaid)} y capital ${money(capitalPaid)})` : ""].filter(Boolean).join("\n");
  if (!window.confirm(`Confirma el registro para ${person.nombre}:\n\n${summary}\nFecha automática: ${dateText(date)} · ${paymentLabels[method]}\n\n${state.isDemo ? "Solo cambiarán los datos de prueba." : isOnline() ? "Se enviará ahora." : "Se guardará en este teléfono y se enviará al recuperar conexión."}`)) return;
  if (!cycle?.activo && !state.isDemo) {
    if (!isOnline()) { toast("La primera caja se abre con conexión. Conéctate una vez para guardar el primer ingreso; después podrás usar la cola sin señal.", "error"); return; }
    const { error } = await supabase.rpc("asegurar_caja_automatica");
    if (error) { toast(friendlyError(error), "error"); return; }
    await refreshData();
    cycle = selectedCycle();
  }
  if (!cycle?.activo) { toast("No hay una caja abierta para esta fecha. La temporada se abrirá automáticamente cuando corresponda.", "error"); return; }
  const dateValidation = person.tipo === "socio" && savings > 0 ? validateIncomeDate(date, cycle) : validateSaturdayAndCycle(date, cycle, "La fecha del abono");
  if (dateValidation) { toast(friendlyError({ message: dateValidation }), "error"); return; }
  const items = [];
  const common = { p_ciclo_id: cycle.id, p_metodo_pago: method, p_fecha_operacion: date, p_participante_id: person.id, p_nota: null };
  let queueTime = Date.parse(nextQueuedAt());
  if (savings > 0) {
    const payload = { ...common, p_monto: Number(savings.toFixed(2)), p_id: crypto.randomUUID() };
    items.push({ id: payload.p_id, action: "income", owner_id: state.user.id, payload, created_at: new Date(queueTime++).toISOString(), status: "pending", last_error: null });
  }
  if (loan && loanPayment > 0) {
    const payload = { ...common, p_tipo_movimiento: "abono_prestamo", p_monto: Number(loanPayment.toFixed(2)), p_prestamo_id: loan.id, p_id: crypto.randomUUID() };
    items.push({ id: payload.p_id, action: "movement", owner_id: state.user.id, payload, created_at: new Date(queueTime++).toISOString(), status: "pending", last_error: null });
  }
  if (state.isDemo) recordDemoCollection(items, person);
  else {
    await storeQueueRecords(items);
    await refreshPending();
    if (isOnline()) await syncQueue();
    else toast("El registro quedó guardado en este teléfono y se enviará cuando vuelva la conexión.", "success");
  }
  state.view = state.collectionReturnView || "alertas";
  state.collectionPersonId = null;
  state.selectedLoanForPayment = null;
  state.collectionDate = null;
  renderShell();
}

function renderSeasonManagement() {
  const activeCycle = state.cycles.find((row) => row.activo) || null;
  const selected = activeCycle || state.cycles.find((row) => row.id === state.selectedCycleId) || state.cycles[0] || null;
  const closure = selected ? state.closures.find((row) => row.ciclo_id === selected.id) : null;
  const gain = selected ? state.gains.find((row) => row.ciclo_id === selected.id) : null;
  const pendingForCycle = activeCycle ? state.pending.filter((item) => item.payload.p_ciclo_id === activeCycle.id) : [];
  const unpaidLoans = activeCycle ? openLoans(activeCycle.id) : [];
  const savingsTotal = activeCycle ? state.transactions.filter((tx) => tx.ciclo_id === activeCycle.id && tx.tipo_movimiento === "ahorro_semanal" && !tx.anulado).reduce((sum, tx) => sum + Number(tx.monto || 0), 0) : 0;
  const finalDayReached = activeCycle && activeCycle.fecha_fin <= todayMx();
  const sortedCycles = [...state.cycles].sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)));
  const historyRows = sortedCycles.map((row) => {
    const rowClosure = state.closures.find((item) => item.ciclo_id === row.id);
    const rowGain = Number(rowClosure?.utilidad_neta ?? state.gains.find((item) => item.ciclo_id === row.id)?.utilidad_neta ?? 0);
    return `<article class="history-card"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-extrabold">${h(row.nombre || "Caja")}</h3><p class="mt-1 text-sm text-slate-500">${dateText(row.fecha_inicio)} – ${dateText(row.fecha_fin)}</p></div><span class="badge ${row.activo ? "badge-green" : "badge-gray"}">${row.activo ? "Abierta" : "Entregada"}</span></div><div class="mt-3 flex items-end justify-between gap-3"><div><p class="text-sm text-slate-500">Ganancias</p><strong class="text-lg">${money(rowGain)}</strong></div>${rowClosure ? `<span class="badge badge-green">Reparto guardado</span>` : ""}</div></article>`;
  }).join("");
  const finalForm = !activeCycle ? "" : finalDayReached ? `<section class="final-count-card"><div><span class="badge badge-amber">Una vez al entregar</span><h3 class="mt-3 text-xl font-extrabold">Cuenta el dinero final</h3><p class="mt-1 text-sm leading-6 text-slate-600">Al entregar la caja, registra una sola vez el efectivo y el saldo del banco. Se compararán con los registros; si la diferencia pasa de $10, explica por qué.</p></div>${state.expectedBalances ? `<div class="expected-grid mt-4"><div><span>Efectivo esperado</span><strong>${money(state.expectedBalances.efectivo)}</strong></div><div><span>Banco esperado</span><strong>${money(state.expectedBalances.transferencias)}</strong></div></div>` : `<p class="info-banner mt-4">Conéctate para calcular los saldos antes de entregar.</p>`}<form id="final-reconcile-form" class="mt-4 grid gap-4 sm:grid-cols-2"><label class="field-label">Efectivo contado<input class="field" name="cash" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" inputmode="decimal" required /></label><label class="field-label">Saldo real del banco<input class="field" name="bank" type="number" min="0" max="${MAX_DB_AMOUNT}" step="0.01" inputmode="decimal" required /></label><label class="field-label sm:col-span-2">Explicación si la diferencia pasa de $10<input class="field" name="note" maxlength="1000" placeholder="Escribe una explicación breve" /></label><div class="sm:col-span-2"><button class="btn-primary w-full sm:w-auto" type="submit" ${!isOnline() || !state.expectedBalances || state.syncing || state.actionBusy || pendingForCycle.length || unpaidLoans.length || savingsTotal <= 0 ? "disabled" : ""}>Entregar y guardar en historial</button></div></form>${unpaidLoans.length ? `<p class="info-banner mt-4">Quedan ${unpaidLoans.length} préstamo${unpaidLoans.length === 1 ? "" : "s"} por cobrar. Registra esos pagos antes de entregar la caja.</p><button class="btn-secondary mt-3" data-action="navigate" data-view="prestamos">Ver préstamos por cobrar</button>` : ""}${pendingForCycle.length ? `<p class="info-banner mt-4">Hay ${pendingForCycle.length} movimiento${pendingForCycle.length === 1 ? "" : "s"} sin enviar. Sincronízalos antes de entregar.</p>` : ""}${savingsTotal <= 0 ? `<p class="info-banner mt-4">Aún no hay ahorros para calcular el reparto.</p>` : ""}</section>` : `<div class="info-banner mt-4">La entrega estará disponible el ${dateText(activeCycle.fecha_fin)}. Hasta entonces puedes seguir anotando entradas y pagos.</div>`;
  const current = activeCycle ? `<section class="season-card"><div class="flex flex-wrap items-start justify-between gap-3"><div><p class="eyebrow">Temporada en curso</p><h2 class="mt-1 text-xl font-extrabold">${h(activeCycle.nombre)}</h2><p class="mt-1 text-sm text-slate-600">${dateText(activeCycle.fecha_inicio)} – ${dateText(activeCycle.fecha_fin)}</p></div><span class="badge badge-green">Abierta</span></div><div class="season-stats mt-4"><div><span>Ahorros anotados</span><strong>${money(savingsTotal)}</strong></div><div><span>Préstamos por cobrar</span><strong>${unpaidLoans.length}</strong></div><div><span>Ganancias hasta hoy</span><strong>${money(gain?.utilidad_neta || 0)}</strong></div></div>${finalForm}</section>` : selected && closure ? `<section class="season-card"><p class="eyebrow">Caja entregada</p><h2 class="mt-1 text-xl font-extrabold">${h(selected.nombre)}</h2><p class="mt-2 text-slate-600">Ganancias repartidas: <strong>${money(closure.utilidad_neta)}</strong></p><p class="mt-1 text-sm text-slate-500">El resultado y la parte de cada socio se guardaron en el historial.</p>${state.shares.filter((share) => share.cierre_id === closure.id).length ? `<details class="mt-4"><summary class="cursor-pointer font-bold text-forest-700">Ver reparto por socio</summary><div class="mt-3 space-y-2">${state.shares.filter((share) => share.cierre_id === closure.id).map((share) => `<div class="movement-row"><span>${h(participantName(share.participante_id))} · ${Number(share.porcentaje).toFixed(2)}%</span><strong>${money(share.monto_utilidad)}</strong></div>`).join("")}</div></details>` : ""}</section>` : !activeCycle ? `<section class="empty-season"><h2>Tu primera temporada se abrirá sola</h2><p>Al guardar la primera aportación o préstamo, aparecerá aquí en tu historial.</p></section>` : "";
  return `<div class="space-y-4">${current}<section class="card"><div class="flex flex-wrap items-end justify-between gap-3"><div><h2 class="text-lg font-extrabold">Historial de cajas</h2><p class="mt-1 text-sm text-slate-600">${state.cycles.length} caja${state.cycles.length === 1 ? "" : "s"} en total, con sus ganancias y estado.</p></div></div>${historyRows ? `<div class="history-list mt-4">${historyRows}</div>` : `<div class="empty mt-4">Las cajas que cierres aparecerán aquí. La primera se crea automáticamente con la actividad.</div>`}</section></div>`;
}

function renderView() {
  if (state.loading && !state.cycles.length && !state.people.length) return `<div class="card py-12 text-center text-slate-500">Cargando la información de tu caja…</div>`;
  switch (state.view) {
    case "movimientos": return renderMovementForm();
    case "calendario": return renderGlobalCalendar();
    case "alertas": return renderAlerts();
    case "personas": return renderPeople();
    case "prestamos": return renderLoans();
    case "cobrar": return renderCollectionForm();
    case "temporadas": return renderSeasonManagement();
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
  if (!state.user || state.isDemo || !isOnline()) return;
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
        if (cycle.activo && cycle.fecha_fin <= todayMx()) {
          const [cash, bank] = await Promise.all([
            supabase.rpc("fn_efectivo_disponible", { p_ciclo_id: cycle.id, p_fecha: cycle.fecha_fin }),
            supabase.rpc("fn_saldo_transferencias", { p_ciclo_id: cycle.id, p_fecha: cycle.fecha_fin })
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

async function startSession(session) {
  state.isDemo = false;
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
  loadLocalPreferences();
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
  if (email.toLowerCase() === "admin" && password === "root") { await submitDemoLogin(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { renderLogin("Escribe el correo electrónico y la contraseña de tu cuenta."); return; }
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
  if (!cycle) return "La caja se abrirá automáticamente con el primer movimiento. Revisa tu conexión e inténtalo de nuevo.";
  if (!date || !isSaturday(date)) return `${label} debe ser sábado.`;
  if (date > todayMx()) return `${label} no puede estar en el futuro.`;
  if (date < cycle.fecha_inicio || date > cycle.fecha_fin) return `${label} debe quedar dentro de la caja abierta.`;
  const lastArqueo = state.arqueos.filter((row) => row.ciclo_id === cycle.id).sort((a,b) => String(b.fecha_sabado).localeCompare(String(a.fecha_sabado)))[0];
  if (lastArqueo && date <= lastArqueo.fecha_sabado) return "Ese sábado ya se cerró. Elige un sábado posterior al último cierre.";
  return "";
}

function validateIncomeDate(date, cycle) {
  if (!cycle) return "La caja se abrirá automáticamente con el primer movimiento. Revisa tu conexión e inténtalo de nuevo.";
  if (!date) return "Elige la fecha de la aportación.";
  if (date > todayMx()) return "La fecha no puede estar en el futuro.";
  if (date < cycle.fecha_inicio || date > cycle.fecha_fin) return "La fecha debe quedar dentro de la caja abierta.";
  if (state.arqueos.some((row) => row.ciclo_id === cycle.id && row.fecha_sabado >= date)) return "Ese periodo ya se cerró. Elige una fecha posterior al último cierre.";
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
  if (state.isDemo) { toast("El registro de movimientos generales no está disponible en el demo; usa Cobros o Préstamos. No se envió nada a Supabase.", "info"); return; }
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
  if (state.syncing || !isOnline() || !state.user || state.isDemo) return;
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
        const rpcName = item.action === "loan" ? "crear_prestamo" : item.action === "income" ? "registrar_aportacion_cualquier_dia" : "registrar_transaccion";
        const { error } = await supabase.rpc(rpcName, item.payload);
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
  } else if (item.action === "income") {
    const participantId = String(data.get("participant_id") || "");
    const participant = state.people.find((person) => person.id === participantId && person.tipo === "socio" && person.estatus === "activo");
    const amount = Number(data.get("amount"));
    const date = String(data.get("date") || "");
    const method = String(data.get("method") || "");
    const validation = validateIncomeDate(date, cycle);
    if (validation) { toast(validation, "error"); return; }
    if (!participant) { toast("Elige un socio activo de la caja.", "error"); return; }
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DB_AMOUNT || Math.round(amount * 100) !== amount * 100) { toast("La cantidad debe ser mayor que cero y tener máximo dos decimales.", "error"); return; }
    if (!["efectivo", "transferencia"].includes(method)) { toast("Elige efectivo o transferencia como forma de entrega.", "error"); return; }
    payload.p_participante_id = participant.id;
    payload.p_monto = Number(amount.toFixed(2));
    payload.p_fecha_operacion = date;
    payload.p_metodo_pago = method;
    payload.p_nota = note;
    if (!window.confirm(`Se corregirá el ingreso a caja de ${participant.nombre} por ${money(amount)}. Se conservará el mismo folio. ¿Continuar?`)) return;
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
  if (state.isDemo) {
    if (state.people.some((person) => person.nombre.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"))) { toast("Ya hay un contacto con ese nombre en los datos de prueba.", "error"); return; }
    const person = { id: crypto.randomUUID(), owner_id: state.user.id, nombre: name, tipo: "socio", estatus: "activo", limite_credito: 0 };
    state.people.push(person);
    if (phone) state.contactPhones[person.id] = phone;
    toast("Socio agregado solo a los datos de prueba.", "success"); form.reset(); state.showPersonForm = false; renderShell(); return;
  }
  if (!isOnline()) { toast("Conéctate para guardar una persona.", "error"); return; }
  const { data: person, error } = await supabase.from("socios_y_clientes").insert({ nombre: name, tipo: "socio", limite_credito: 0 }).select().single();
  if (error) { toast(friendlyError(error), "error"); return; }
  if (phone) await saveContactPhone(person.id, phone);
  toast("Socio agregado a la caja.", "success"); form.reset();
  await refreshData();
}

async function createLoan(form) {
  if (!state.isDemo && !isOnline()) { toast("Conéctate para confirmar el préstamo. No se guarda sin internet.", "error"); return; }
  let cycle = selectedCycle();
  const data = new FormData(form);
  const choice = String(data.get("person_choice") || "");
  let participantId = choice === "__new__" ? "" : choice;
  const newName = String(data.get("new_name") || "").trim();
  const newPhone = String(data.get("new_phone") || "").replace(/\D/g, "");
  const capital = moneyInputValue(data.get("capital"));
  const date = String(data.get("date"));
  const method = String(data.get("method"));
  if (!isSaturday(date)) { toast("La fecha de entrega debe ser sábado.", "error"); return; }
  if (date > todayMx()) { toast("No puedes registrar una entrega de dinero en una fecha futura.", "error"); return; }
  if (!choice) { toast("Elige un contacto o agrega uno nuevo.", "error"); return; }
  if (choice === "__new__" && !newName) { toast("Escribe el nombre del nuevo contacto.", "error"); return; }
  if (newPhone && (newPhone.length < 10 || newPhone.length > 15)) { toast("Revisa el teléfono e incluye la lada del país.", "error"); return; }
  if (!Number.isFinite(capital) || capital <= 0 || capital > MAX_DB_AMOUNT || Math.round(capital * 100) !== capital * 100) { toast("El capital debe estar dentro del límite permitido y tener hasta dos decimales.", "error"); return; }
  if (!window.confirm(`Confirma el préstamo:\n\nContacto: ${choice === "__new__" ? newName : participantName(participantId)}\nCapital: ${money(capital)}\nRédito: 5% por cada 15 días completos sobre el capital pendiente\nPrimer cobro de réditos: después de 15 días\nEntrega: ${dateText(date)}\n\nLos réditos no se suman al capital. ¿Continuar?`)) return;
  if ((!cycle || !cycle.activo) && !state.isDemo) {
    const { error } = await supabase.rpc("asegurar_caja_automatica");
    if (error) { toast(friendlyError(error), "error"); return; }
    await refreshData();
    cycle = selectedCycle();
  }
  if (!cycle?.activo) { toast("La temporada se abrirá automáticamente al registrar la primera operación.", "error"); return; }
  const validation = validateSaturdayAndCycle(date, cycle, "La fecha de entrega");
  if (validation) { toast(friendlyError({ message: validation }), "error"); return; }
  const weeks = Math.floor((Date.parse(`${cycle.fecha_fin}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / (7 * 86400000));
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) { toast("El préstamo debe entregarse antes del último sábado para que haya tiempo de liquidarlo.", "error"); return; }
  if (choice === "__new__") {
    const existing = state.people.find((person) => person.tipo === "externo" && person.nombre.trim().toLocaleLowerCase("es") === newName.toLocaleLowerCase("es"));
    let person = existing || null;
    if (!person) {
      if (state.isDemo) {
        person = { id: crypto.randomUUID(), owner_id: state.user.id, nombre: newName, tipo: "externo", estatus: "activo", limite_credito: Number(capital.toFixed(2)) };
        state.people.push(person);
      } else {
        const { data: created, error } = await supabase.from("socios_y_clientes").insert({ nombre: newName, tipo: "externo", limite_credito: Number(capital.toFixed(2)) }).select().single();
        if (error) {
          await refreshData();
          person = state.people.find((row) => row.tipo === "externo" && row.nombre.trim().toLocaleLowerCase("es") === newName.toLocaleLowerCase("es")) || null;
          if (!person) { toast(friendlyError(error), "error"); return; }
        } else person = created;
      }
    }
    participantId = person.id;
    if (newPhone) await saveContactPhone(person.id, newPhone);
    if (!state.isDemo) await refreshData();
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
    p_nota: null
  };
  if (state.isDemo) { recordDemoLoan(payload, participant); return; }
  const record = { id: payload.p_id, action: "loan", owner_id: state.user.id, payload, created_at: nextQueuedAt(), status: "pending", last_error: null };
  try { await storePut("queue", record); } catch (error) { toast(friendlyError(error), "error"); return; }
  await refreshPending();
  await syncQueue();
  if (state.pending.some((item) => item.id === payload.p_id && item.status === "pending")) toast("No se confirmó la respuesta de la red. El préstamo quedó guardado con el mismo folio para volver a intentar.", "info");
}

async function cancelTransaction(id, button) {
  if (cancellingTransaction) return;
  const transaction = state.transactions.find((row) => row.id === id);
  if (!transaction || transaction.anulado) return;
  if (!state.isDemo && !isOnline()) { toast("Conéctate para anular un movimiento y guardar la explicación.", "error"); return; }
  const reason = window.prompt("¿Por qué se anula este movimiento? Escribe al menos cinco caracteres.");
  if (reason === null) return;
  if (reason.trim().length < 5) { toast("La explicación debe tener al menos cinco caracteres.", "error"); return; }
  if (!window.confirm(`Se anulará este movimiento y se guardará la explicación en la bitácora. No se puede borrar después.\n\nMotivo: ${reason.trim()}\n\n¿Confirmas la anulación?`)) return;
  if (state.isDemo) { transaction.anulado = true; toast("Movimiento anulado solo en los datos de prueba.", "success"); renderShell(); return; }
  cancellingTransaction = true;
  if (button) { button.disabled = true; button.textContent = "Anulando…"; }
  try {
    const annulRpc = transaction.tipo_movimiento === "ahorro_semanal" ? "anular_aportacion_cualquier_dia" : "anular_transaccion";
    const { error } = await supabase.rpc(annulRpc, { p_transaccion_id: id, p_motivo: reason.trim() });
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

async function closeSeason(form) {
  if (state.isDemo) { toast("La entrega está desactivada en el modo de prueba. No se envió nada a Supabase.", "info"); return; }
  if (state.actionBusy) return;
  state.actionBusy = true;
  try {
    if (!isOnline()) { toast("Conéctate para entregar la caja.", "error"); return; }
    const cycle = state.cycles.find((row) => row.activo);
    if (!cycle) { toast("No encontramos una caja abierta.", "error"); return; }
    if (!isSaturday(cycle.fecha_fin) || cycle.fecha_fin > todayMx()) { toast("La entrega estará disponible cuando llegue el último sábado de la temporada.", "error"); return; }
    const data = new FormData(form);
    const cash = Number(data.get("cash"));
    const bank = Number(data.get("bank"));
    const rawNote = String(data.get("note") || "");
    const note = rawNote.trim() || null;
    if ([cash, bank].some((value) => !Number.isFinite(value) || value < 0 || value > MAX_DB_AMOUNT || Math.round(value * 100) !== value * 100)) { toast("Los saldos deben ser cero o mayores y tener máximo dos decimales.", "error"); return; }
    if (rawNote.length > 1000) { toast("La explicación no puede tener más de 1,000 caracteres.", "error"); return; }
    const pending = state.pending.filter((item) => item.payload.p_ciclo_id === cycle.id);
    if (pending.length) { toast(`Hay ${pending.length} movimiento${pending.length === 1 ? "" : "s"} sin enviar. Sincronízalos o revísalos antes de entregar.`, "error"); return; }
    const unpaid = openLoans(cycle.id);
    if (unpaid.length) { toast(`Quedan ${unpaid.length} préstamo${unpaid.length === 1 ? "" : "s"} por cobrar. Registra los pagos antes de entregar.`, "error"); return; }
    const savings = state.transactions.filter((tx) => tx.ciclo_id === cycle.id && tx.tipo_movimiento === "ahorro_semanal" && !tx.anulado).reduce((sum, tx) => sum + Number(tx.monto || 0), 0);
    if (savings <= 0) { toast("Aún no hay aportaciones para calcular el reparto.", "error"); return; }
    if (!state.expectedBalances) { toast("No pudimos calcular los saldos esperados. Actualiza la pantalla e intenta de nuevo.", "error"); return; }
    const discrepancy = Math.abs(cash - state.expectedBalances.efectivo) > 10 || Math.abs(bank - state.expectedBalances.transferencias) > 10;
    if (discrepancy && (!note || note.length < 5)) { toast("La diferencia supera $10. Escribe una explicación de al menos cinco caracteres.", "error"); return; }
    const largeNote = Math.max(cash, bank) >= LARGE_AMOUNT_CONFIRMATION ? "\n\nEl saldo es alto. Confirma que las cifras estén bien capturadas." : "";
    if (!window.confirm(`Vas a entregar “${cycle.nombre}” con un solo conteo final.\n\nEfectivo contado: ${money(cash)}\nEfectivo esperado: ${money(state.expectedBalances.efectivo)}\nBanco contado: ${money(bank)}\nBanco esperado: ${money(state.expectedBalances.transferencias)}${note ? `\nExplicación: ${note}` : ""}\n\nSe guardará el resultado y el reparto proporcional en el historial. No se puede deshacer.${largeNote}\n\n¿Confirmas la entrega?`)) return;
    const { error } = await supabase.rpc("cerrar_temporada_final", { p_ciclo_id: cycle.id, p_efectivo_fisico_real: Number(cash.toFixed(2)), p_saldo_banco_real: Number(bank.toFixed(2)), p_nota_ajuste: note });
    if (error) { toast(friendlyError(error), "error"); return; }
    toast("Temporada entregada. El conteo final y el reparto quedaron guardados en el historial.", "success");
    state.view = "temporadas";
    await refreshData();
  } finally {
    state.actionBusy = false;
    if (state.session) renderShell();
  }
}

async function logout() {
  if (state.isDemo) { state.isDemo = false; await startSession(null); toast("Saliste del modo de prueba.", "success"); return; }
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
  if (action === "reset-demo") { resetDemoData(); return; }
  if (action === "close-menu") { state.menuOpen = false; renderShell(); return; }
  if (action === "navigate") { state.view = button.dataset.view || "inicio"; state.menuOpen = false; if (state.view === "movimientos") state.statementPersonId = null; else state.showMovementForm = false; renderShell(); if (state.view === "temporadas" && isOnline()) refreshData(); return; }
  if (action === "general-movements") { state.statementPersonId = null; state.view = "movimientos"; state.showMovementForm = false; renderShell(); return; }
  if (action === "clear-person-statement") { state.statementPersonId = null; renderShell(); return; }
  if (action === "new-movement") { state.showMovementForm = true; state.selectedPersonId = null; renderShell(); return; }
  if (action === "show-statement") { state.showMovementForm = false; state.selectedPersonId = null; renderShell(); return; }
  if (action === "logout") { logout(); return; }
  if (action === "sync") { syncQueue(); return; }
  if (action === "cancel-tx") { cancelTransaction(button.dataset.id, button); return; }
  if (action === "close-cycle") { state.view = "temporadas"; renderShell(); return; }
  if (action === "toggle-person-form") { state.showPersonForm = !state.showPersonForm; renderShell(); return; }
  if (action === "collection-back") { state.view = state.collectionReturnView || "alertas"; state.collectionPersonId = null; state.selectedLoanForPayment = null; state.collectionDate = null; renderShell(); return; }
  if (action === "collect-person") {
    const person = state.people.find((row) => row.id === button.dataset.person);
    if (!person) { toast("No encontramos ese contacto. Actualiza la información e intenta de nuevo.", "error"); return; }
    state.collectionReturnView = state.view;
    state.collectionPersonId = person.id;
    state.selectedLoanForPayment = button.dataset.loan || null;
    state.collectionDate = null;
    state.view = "cobrar"; state.menuOpen = false; renderShell(); return;
  }
  if (action === "loan-person") { state.loanPersonChoice = button.dataset.person; state.view = "prestamos"; state.menuOpen = false; renderShell(); return; }
  if (action === "whatsapp") { const person = state.people.find((row) => row.id === button.dataset.person); if (person) whatsappLink(person, Number(button.dataset.amount)); return; }
  if (action === "toggle-person") { state.selectedPersonId = state.selectedPersonId === button.dataset.id ? null : button.dataset.id; if (!state.selectedPersonId) state.calendarPersonId = null; renderShell(); return; }
  if (action === "person-filter") { state.personFilter = button.dataset.filter || "all"; renderShell(); return; }
  if (action === "toggle-calendar") { state.selectedPersonId = button.dataset.person; state.calendarPersonId = state.calendarPersonId === button.dataset.person ? null : button.dataset.person; renderShell(); return; }
  if (action === "calendar-week") {
    state.calendarCycleId = button.dataset.cycle || state.calendarCycleId || selectedCycle()?.id || null;
    state.calendarWeek = button.dataset.saturday || "";
    const weekIndex = calendarWeeks(state.cycles.find((item) => item.id === state.calendarCycleId)).find((week) => week.saturday === state.calendarWeek)?.index;
    if (weekIndex) history.replaceState(null, "", `#S${weekIndex}`);
    state.view = "calendario"; renderShell(); return;
  }
  if (action === "calendar-collect") {
    const personId = button.dataset.person || document.querySelector("#calendar-quick-person")?.value;
    const person = state.people.find((row) => row.id === personId);
    if (!person) { toast("Elige a la persona para registrar el pago.", "info"); return; }
    state.collectionReturnView = "calendario";
    state.collectionPersonId = person.id;
    state.selectedLoanForPayment = button.dataset.loan || null;
    state.collectionDate = button.dataset.saturday || state.calendarWeek || todayMx();
    state.view = "cobrar"; state.menuOpen = false; renderShell(); return;
  }
  if (action === "close-calendar") { state.calendarPersonId = null; renderShell(); return; }
  if (action === "toggle-missed-week") { setMissedWeek(button.dataset.person, button.dataset.saturday, !missedWeek(button.dataset.person, button.dataset.saturday)); state.selectedPersonId = button.dataset.person; state.calendarPersonId = button.dataset.person; renderShell(); return; }
  if (action === "person-movements") { state.selectedPersonId = button.dataset.id; state.statementPersonId = button.dataset.id; state.view = "movimientos"; state.showMovementForm = false; renderShell(); return; }
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
  const busyLabel = form.id === "login-form" ? "Entrando…" : form.id === "loan-form" ? "Confirmando préstamo…" : form.id === "final-reconcile-form" ? "Entregando temporada…" : "Guardando…";
  if (button) { button.disabled = true; button.textContent = busyLabel; }
  try {
    if (form.id === "login-form") await submitLogin(form);
    else if (form.id === "password-form") await submitPasswordChange(form);
    else if (form.id === "profile-password-form") await changeProfilePassword(form);
    else if (form.id === "movement-form") await saveMovement(form);
    else if (form.id === "person-form") await createPerson(form);
    else if (form.id === "loan-form") await createLoan(form);
    else if (form.id === "collection-form") await saveCollection(form);
    else if (form.id === "final-reconcile-form") await closeSeason(form);
    else if (form.id === "search-person-form") { state.personSearch = String(new FormData(form).get("query") || "").trim(); renderShell(); }
    else if (form.id === "calendar-jump-form") {
      const number = Number(String(new FormData(form).get("week") || "").replace(/\D/g, ""));
      const cycle = state.cycles.find((item) => item.id === state.calendarCycleId) || selectedCycle();
      const target = calendarWeeks(cycle).find((week) => week.index === number);
      if (!target) toast("No encontramos esa semana en esta caja. Revisa el número e intenta de nuevo.", "error");
      else { state.calendarCycleId = cycle.id; state.calendarWeek = target.saturday; state.calendarMonth = target.saturday.slice(0, 7); history.replaceState(null, "", `#S${target.index}`); renderShell(); }
    }
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
  if (event.target.matches("#calendar-cycle")) { state.calendarCycleId = event.target.value; state.calendarWeek = ""; state.calendarMonth = ""; renderShell(); }
  if (event.target.matches("#calendar-month")) { state.calendarMonth = event.target.value; renderShell(); }
  if (event.target.matches("#contact-frequency")) { setContactFrequency(event.target.dataset.person, event.target.value); renderShell(); }
  if (event.target.matches("#movement-loan")) {
    const chosen = event.target.selectedOptions[0]?.dataset.person;
    const person = document.querySelector("#movement-person");
    if (person && chosen) person.value = chosen;
  }
  if (event.target.matches("#collection-loan, #collection-loan-amount, [name=loan_mode]")) updateCollectionPreview();
});

appScreen.addEventListener("input", (event) => {
  const field = event.target;
  if (field.matches("[data-money-input]")) {
    const raw = field.value.replace(/[^\d.]/g, "");
    const [integerPart = "", ...decimalParts] = raw.split(".");
    const integer = integerPart.slice(0, 10);
    const decimals = decimalParts.join("").slice(0, 2);
    field.value = decimalParts.length ? `${integer}.${decimals}` : integer;
  }
  if (field.matches("#collection-loan-amount, [name=savings]")) updateCollectionPreview();
});

appScreen.addEventListener("focusout", (event) => {
  const field = event.target;
  if (!field.matches("[data-money-input]") || !field.value.trim()) return;
  const amount = moneyInputValue(field.value);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_DB_AMOUNT) return;
  field.value = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  if (field.matches("#collection-loan-amount, [name=savings]")) updateCollectionPreview();
});

window.addEventListener("online", () => { renderShell(); if (state.user) syncQueue(); });
window.addEventListener("offline", () => renderShell());
window.addEventListener("focus", () => verifyAccessOnReturn());
window.addEventListener("pageshow", () => verifyAccessOnReturn());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") verifyAccessOnReturn(); });
window.addEventListener("storage", () => { if (state.user) refreshPending(); });

supabase.auth.onAuthStateChange((_event, session) => {
  if (state.isDemo || enteringDemo) return;
  queueMicrotask(() => {
    if (session?.user?.user_metadata?.must_change_password === true || session?.user?.id !== state.user?.id || !session) startSession(session);
    else { state.session = session; state.user = session.user; }
  });
});

async function verifyAccessOnReturn() {
  if (!state.user || state.isDemo || document.visibilityState === "hidden" || verifyingAccess) return;
  if (state.user.user_metadata?.must_change_password === true) { renderPasswordChange(); return; }
  verifyingAccess = true;
  appScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");
  authScreen.innerHTML = `<main class="safe-top safe-bottom flex min-h-screen items-center justify-center px-4"><section class="card text-center"><h1 class="text-xl font-extrabold">Mi Caja</h1><p class="mt-2 text-sm text-slate-500">Revisando el acceso…</p></section></main>`;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) { verifyingAccess = false; renderLogin("No pudimos comprobar tu acceso. Revisa tu conexión e inicia sesión de nuevo."); return; }
    if (!data.user) { await startSession(null); return; }
    state.user = data.user;
    state.session = { ...state.session, user: data.user };
    verifyingAccess = false;
    if (data.user.user_metadata?.must_change_password === true) renderPasswordChange();
    else await startSession(state.session);
  } catch { verifyingAccess = false; renderLogin("No pudimos comprobar tu acceso. Revisa tu conexión e inicia sesión de nuevo."); }
  finally { verifyingAccess = false; }
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
