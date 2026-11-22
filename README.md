# Mi Caja

Aplicación web privada para administrar una caja de ahorro y una cartera de préstamos. Está hecha con HTML, JavaScript y Tailwind CSS; el cliente Supabase se empaqueta localmente para que la pantalla de acceso y la app instalada sigan abriendo sin internet.

## Qué incluye

- Inicio de sesión obligatorio con Supabase Auth y cambio de contraseña actual verificada antes de continuar. Al volver a la pestaña, la app vuelve a comprobar la sesión y conserva el bloqueo de cambio obligatorio.
- Menú de cuenta, historial anual de cajas, resumen financiero y vistas de movimientos, pendientes, contactos y préstamos. Los aportes y pagos se registran desde la persona correspondiente, sin una pestaña separada de ingresos.
- Los contactos se crean como socios de forma predeterminada. Los contactos externos se crean al prestarles y se muestran con la etiqueta “No participa en caja”.
- Tasa fija de 5%, aportaciones a caja cualquier día dentro de una temporada abierta, temporada creada automáticamente al registrar la primera operación y una sola conciliación final al entregar, con tolerancia de $10 y reparto proporcional calculado por el backend.
- Cola IndexedDB por cuenta, con el mismo `p_id` y datos originales. Los movimientos rechazados muestran la causa y permiten corregirlos o descartarlos; un rechazo no detiene el envío de los siguientes.
- Los teléfonos se guardan localmente en el dispositivo para abrir recordatorios de WhatsApp. El esquema actual de Supabase no tiene una columna para esos teléfonos.
- PWA con caché del cascarón, compilación con rutas relativas y acceso para instalar en el celular.
- Modo de prueba local con datos ficticios (`admin` / `root`), calendarios semanales y botón para reiniciar; no escribe datos en Supabase.

## Llave de Supabase

La app contiene la Project URL y la llave publicable (`sb_publishable_...`) que se entregaron para este proyecto. Esa llave está diseñada para usarse en clientes web. No añadas la `service_role` key ni contraseñas al repositorio o al navegador. La protección de registros depende de Supabase Auth, las funciones RPC y RLS.

## Desarrollo local

Requiere Node.js y npm.

```sh
npm install
npm run build
npx http-server dist -p 4173
```

Abre `http://localhost:4173`. Para probar el modo sin conexión, abre la app una vez con internet, inicia sesión y deja que cargue los datos antes de activar el modo avión.

## Publicación web en GitHub Pages

El workflow `.github/workflows/deploy-pages.yml` compila el proyecto con `npm ci` y `npm run build`, valida los archivos de `dist/` y publica ese artefacto cuando hay un push a `main`. En GitHub, selecciona **Settings → Pages → Build and deployment → Source → GitHub Actions**. La página esperada es `https://erickgotze98-bot.github.io/caja-ahorro-intelia/`.

La página publicada abre la pantalla de acceso. Los datos requieren sesión de Supabase; las tablas aplican RLS por `owner_id`.
## Instalar como PWA o preparar Capacitor

En Chrome o Safari del celular, abre el enlace publicado y usa **Añadir a pantalla de inicio** / **Add to Home Screen**. El inicio sin conexión sirve el cascarón guardado; la sesión debe haberse abierto antes en ese dispositivo.

Para iniciar una envoltura nativa con Capacitor:

```sh
npm install @capacitor/core @capacitor/cli
npx cap add android
npx cap sync
```

`capacitor.config.ts` apunta al directorio `dist`. Si Capacitor todavía no se instaló, copia la configuración de ese archivo a la configuración TypeScript que genere `npx cap init`.

## Notas de operación

- Los préstamos y abonos conservan la regla de sábado del backend; las aportaciones a caja pueden registrarse cualquier día con fecha automática. Las temporadas se entregan con un conteo final de efectivo y banco; no se hacen cierres semanales. Aplica las migraciones `20261121130000_income_any_day.sql`, `20261121150000_close_season_once.sql` y `20261121170000_automatic_season.sql` en el SQL Editor antes de usar estas funciones.
- La migración habilita las RPC `registrar_aportacion_cualquier_dia` y `anular_aportacion_cualquier_dia`; el resto de movimientos conserva el camino y la regla de sábado actuales. La vista semanal asigna las aportaciones de cada día al sábado que sigue.
- La RPC `asegurar_caja_automatica()` solo puede ejecutarse como usuario autenticado. Devuelve la temporada activa o crea la temporada diciembre–noviembre del propietario; el cliente no inserta temporadas directamente.
- La conciliación se hace una sola vez al final de cada temporada; la base exige explicar diferencias mayores a $10 y no permite entregar con préstamos abiertos o sin ahorros para repartir. Si falla la red durante un envío, la cola vuelve a intentar el mismo `p_id` con los mismos datos. Si Supabase rechaza un movimiento, muestra cuál falló y el motivo, permite corregirlo o descartarlo y continúa con los demás pendientes.
- La cola se guarda en el almacenamiento local del dispositivo. Cerrar sesión no la envía; al volver a entrar con la misma cuenta y recuperar internet, se puede sincronizar.
- La app pide al navegador permiso para marcar su almacenamiento local como persistente cuando está disponible. Aun así, la cola offline depende del espacio y las políticas del dispositivo; conéctate y sincroniza los pendientes con frecuencia.
- El calendario y las preferencias de frecuencia (semanal, cada 15 días o flexible) se guardan localmente en este dispositivo; son recordatorios visuales, no bloquean ni modifican movimientos.
- Los préstamos, altas de personas/ciclos, anulaciones y cierres requieren conexión. Los abonos y otros movimientos sí se pueden dejar en cola.
- Las políticas RLS y las RPC son la autoridad final. El cliente ayuda con mensajes claros, pero no reemplaza las validaciones de la base de datos.
