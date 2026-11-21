# Mi Caja · Intelia

Aplicación web privada para administrar una caja de ahorro y una cartera de préstamos. Está hecha con HTML, JavaScript y Tailwind CSS; el cliente Supabase se empaqueta localmente para que la pantalla de acceso y la app instalada sigan abriendo sin internet.

## Qué incluye

- Inicio de sesión con Supabase Auth; la app no ofrece registro público.
- Bloqueo de acceso hasta cambiar la contraseña cuando `user_metadata.must_change_password` sea `true`. Al guardarla, cambia el marcador a `false`.
- Lectura de datos bajo la sesión `authenticated` y las políticas RLS del proyecto.
- Altas de ciclos y personas únicamente con los permisos de sus tablas; los movimientos, préstamos, anulaciones y cierres usan las funciones RPC del backend.
- Tasa fija de 5%, cierre de sábados consecutivos, tolerancia de $10, conciliación de efectivo y banco y reparto proporcional calculado por `cerrar_ciclo`.
- Cola IndexedDB, separada por cuenta, que conserva el `p_id` y los datos originales de cada movimiento pendiente.
- Acceso a recordatorios de WhatsApp; el teléfono se solicita al abrir el enlace y no se guarda.
- PWA con caché del cascarón y acceso para instalar en la pantalla de inicio del celular.

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

## Publicación web

El proyecto está preparado para Vercel. Importa el repositorio privado y usa:

- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

La página publicada puede abrir la pantalla de acceso sin iniciar sesión. Los datos requieren sesión de Supabase; las tablas aplican RLS por `owner_id`.

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

- Las fechas de operación y de cierre deben ser sábado, no pueden ser futuras y tienen que pertenecer al ciclo abierto.
- No se permite saltar cierres semanales. Si falla la red durante un envío, la cola vuelve a intentar el mismo `p_id`; si el servidor rechaza el movimiento, lo marca para revisión y detiene los posteriores hasta resolverlo.
- La cola se guarda en el almacenamiento local del dispositivo. Cerrar sesión no la envía; al volver a entrar con la misma cuenta y recuperar internet, se puede sincronizar.
- Los préstamos, altas de personas/ciclos, anulaciones y cierres requieren conexión. Los abonos y otros movimientos sí se pueden dejar en cola.
- Las políticas RLS y las RPC son la autoridad final. El cliente ayuda con mensajes claros, pero no reemplaza las validaciones de la base de datos.
