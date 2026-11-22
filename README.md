# Mi Caja

Aplicación web privada para administrar ahorros y préstamos. Usa HTML, JavaScript y Tailwind CSS, con compilación de rutas relativas para GitHub Pages y uso como PWA.

## Funciones

- Inicio de sesión con Supabase Auth. Si el perfil exige cambio de contraseña, se bloquea la app hasta validar la contraseña actual y guardar una nueva.
- Modo de simulación local desde el mismo formulario; no consulta ni escribe datos reales de Supabase.
- Resumen financiero, movimientos por mes, pendientes de cobro, préstamos activos y contactos.
- Calendario por caja y mes, con semanas marcadas por ahorros o pagos, detalle semanal, acceso rápido a registros y salto por semana `#S…`.
- Calendario compacto por contacto e historial agrupado por mes. Los teléfonos para WhatsApp se guardan solo en el dispositivo.
- Ahorros con recordatorio semanal flexible. La aportación puede anotarse después sin que se bloquee por una semana omitida.
- Préstamos con 5% simple por cada periodo completo de 15 días, sobre el capital pendiente. Los réditos no se suman al capital y cada abono se aplica primero a réditos y después a capital. Los abonos de préstamo se registran en sábado y siguen el orden de pagos ya guardados.
- Cola offline en IndexedDB por cuenta. Conserva el mismo `p_id` y los datos originales; cada movimiento rechazado muestra el motivo y permite corregirse o descartarse sin detener los demás.
- Temporadas automáticas de diciembre a noviembre, historial anual y conciliación final al entregar, con tolerancia de $10 y reparto proporcional calculado por el backend.

## Supabase y seguridad

La app usa la Project URL y la llave publicable proporcionadas para Mi Caja. La llave publicable está pensada para clientes web. Nunca añadas la `service_role` key ni contraseñas al repositorio o al navegador. La protección de datos depende de Supabase Auth, funciones RPC con `p_id` y políticas RLS.

Aplica las migraciones del repositorio en orden, incluidas `20261121190000_interest_every_15_days.sql` y `20261121200000_guard_loan_annulment_order.sql`, antes de usar los nuevos cálculos. La primera se detiene si detecta préstamos previos sin conciliación; revisa las cuentas existentes antes de reintentarla. En la base consultada para este cambio no había préstamos registrados.

## Desarrollo local

Requiere Node.js y npm.

```sh
npm install
npm run build
npx http-server dist -p 4173
```

Abre `http://localhost:4173`. Para usar el modo sin conexión, abre la app una vez con internet, inicia sesión y deja que carguen los datos.

## Publicación en GitHub Pages

El workflow `.github/workflows/deploy-pages.yml` compila con `npm ci` y `npm run build`, valida `dist/` y publica en GitHub Pages con cada push a `main`. En GitHub, selecciona **Settings → Pages → Build and deployment → Source → GitHub Actions**.

URL publicada: <https://erickgotze98-bot.github.io/caja-ahorro-intelia/>.

## Instalar en el celular

Abre el enlace publicado en Chrome o Safari y selecciona **Añadir a pantalla de inicio**. La pantalla abre sin conexión después de cargarla una vez; para operar con Supabase, la sesión debe haberse iniciado en ese dispositivo.

Para preparar Capacitor:

```sh
npm install @capacitor/core @capacitor/cli
npx cap add android
npx cap sync
```

`capacitor.config.ts` usa `dist` como directorio web.

## Notas operativas

- Las operaciones nuevas de préstamo requieren conexión. La cola offline conserva el folio idempotente para los abonos y movimientos permitidos.
- El interés se reconoce en la base antes de registrar cada abono: 5% por cada periodo completo de 15 días sobre el capital pendiente. Una fecha de abono anterior a otro pago ya guardado se rechaza para no alterar el orden del cálculo.
- Para mantener consistente el historial de réditos, los abonos de un préstamo se anulan del más reciente al más antiguo. La app bloquea el botón de anulación en pagos anteriores y Supabase aplica la misma regla.
- La base sigue siendo la autoridad final para fechas, saldos, RLS, permisos e idempotencia. El frontend valida y explica los rechazos, pero no sustituye esas reglas.
- Los datos de teléfono, preferencias de recordatorio y caché offline permanecen locales en cada dispositivo.
