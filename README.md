# Monitor de Captación — Ingeniería Sin Fronteras Argentina

Herramienta de supervisión de campo para campañas de captación de donantes en vía pública. Permite que un coordinador o coordinadora escuche en tiempo real —desde su celular— el discurso de cada captador/a, mientras el captador usa la tablet para mostrar una presentación al posible donante y registrar la donación.

---

## Qué hace

La aplicación tiene dos modos que corren en el mismo archivo HTML:

### Modo Coordinador (celular)

- Genera un código numérico de 4 dígitos que identifica la sesión.
- Recibe el audio del captador/a en tiempo real.
- Permite iniciar y detener grabaciones durante la escucha.
- Convierte cada grabación a MP3 en el propio navegador y la ofrece para descargar.
- Opcionalmente sube el MP3 a una carpeta de Google Drive de la organización de forma automática.
- Ofrece un botón de acceso directo a la carpeta de Google Drive donde se guardan las grabaciones.
- Puede cortar la transmisión del captador/a de forma remota desde un botón (le apaga el micrófono y lo devuelve a la pantalla de inicio), manteniendo la sesión viva para otro captador/a.
- Registra el nombre del captador/a en el nombre del archivo para facilitar el seguimiento.
- Detecta cuando el captador/a se desconecta (de forma casi instantánea) y actualiza el estado visualmente.
- Si la desconexión ocurre durante una grabación, **no la corta**: la mantiene esperando la reconexión y solo la detiene automáticamente 90 segundos después. El coordinador/a también puede detenerla a mano en cualquier momento.

### Modo Captador (tablet)

- Recibe el código de la coordinación e inicia la transmisión de micrófono.
- Al conectar, la pantalla pasa a una vista de donante: muestra la presentación de Google Slides de ISF Argentina embebida, a pantalla completa.
- Desde esa misma vista se puede acceder al formulario real de donación (`isf-argentina.org/formularios/donar`) embebido, sin salir de la app.
- Un menú discreto (botón `···`, esquina superior derecha) da acceso a los controles técnicos: estado de la transmisión, nivel de micrófono, pantalla completa, y detener con confirmación de dos pasos.
- Reconexión automática y persistente si el audio se interrumpe (por red, o porque el coordinador/a bloqueó el teléfono): sigue reintentando sin volver a la pantalla de inicio y se reconecta solo cuando el otro lado vuelve.

---

## Cómo funciona internamente

### Arquitectura general

La aplicación es un **único archivo HTML estático** sin backend propio. Toda la lógica corre en el navegador. Depende de tres servicios externos:

| Servicio | Rol |
|---|---|
| PeerJS cloud (`peerjs.com`) | Señalización WebRTC para establecer la conexión entre dispositivos |
| Servidores STUN/TURN | Traversal de NAT para que el audio llegue entre redes distintas |
| Google Apps Script (opcional) | Receptor HTTP que guarda los MP3 en Google Drive |

### Transmisión de audio (WebRTC)

El audio viaja directamente entre el celular del coordinador y la tablet del captador usando **WebRTC peer-to-peer**. El servidor solo interviene en el establecimiento inicial de la conexión (señalización y NAT traversal); una vez conectados, el audio no pasa por ningún servidor intermedio.

**Señalización con PeerJS:** el coordinador crea un `Peer` con ID `isfa` + código de 4 dígitos. El captador crea un `Peer` anónimo y llama a ese ID. PeerJS gestiona el intercambio de SDP y candidatos ICE.

**NAT traversal con STUN + TURN:** las redes móviles usan NAT simétrico, que bloquea las conexiones P2P directas. Con STUN solo, una fracción significativa de las conexiones en red celular fallan a los pocos segundos. Se incluyeron servidores TURN que actúan como relay cuando no hay ruta directa disponible. Las credenciales de producción recomendadas son de ExpressTURN o Metered (plan gratuito, 1000 GB/mes); el repositorio incluye credenciales `openrelay` solo para pruebas rápidas.

**Reconexión automática:** `placeCall()` observa `RTCPeerConnection.iceConnectionState`. Si el estado pasa a `failed` o `disconnected`, `scheduleReconnect()` reintenta la llamada con backoff (1,5 → 4 s). En la conexión **inicial** da hasta 8 intentos antes de mostrar error; pero una vez que se conectó al menos una vez (`everConnected`), reintenta **indefinidamente** sin abandonar, porque el otro lado pudo haber bloqueado el teléfono y va a volver. En el lado del coordinador, `watchCoordConn()` hace el mismo seguimiento y dispara `coordDisconnected()` después de un período de gracia de 1,5 s.

**Recuperación tras bloqueo de pantalla (`visibilitychange`):** cuando un dispositivo se bloquea o pasa a segundo plano, el navegador congela la página y se corta el WebRTC. Al volver a primer plano, un listener de `visibilitychange` reactiva el Wake Lock y **re-establece la conexión solo**: el coordinador/a vuelve a registrar su mismo código en el servidor (`peer.reconnect()`, o recrea el `Peer` con el mismo código si fue destruido) y el captador/a reanuda los reintentos de llamada. Así no hay que reconectar a mano de ningún lado.

**Detección instantánea de la desconexión deliberada:** cuando el captador/a toca "Detener", el medio WebRTC puede tardar varios segundos en cerrarse a nivel ICE. Para que la coordinación se entere al instante, se abre además un `DataConnection` de PeerJS entre ambos dispositivos; el captador/a envía un mensaje `'bye'` por ese canal justo antes de destruir el `Peer`, y el coordinador/a reacciona de inmediato. Si en cambio se pierde la señal sin aviso, la detección recae en el seguimiento de ICE con el período de gracia de 1,5 s.

**Grabación a prueba de cortes:** si el captador/a se desconecta mientras hay una grabación activa, el coordinador/a no la corta. La grabación sigue (capturando silencio durante el corte) y, si el captador/a se reconecta, retoma el audio en el **mismo archivo** (`attachRecSource()` reapunta el nodo de captura al nuevo stream). Solo si pasan 90 segundos sin reconexión se dispara la detención automática y se guarda lo grabado.

### Grabación

**Por qué no se usa `MediaRecorder` directamente sobre el stream remoto:** grabar el stream entrante de WebRTC con `MediaRecorder` da silencio en Chrome. El stream llega correctamente al elemento `<audio>` y se escucha, pero `MediaRecorder` no captura ese audio porque Chrome trata el stream remoto como "inactivo" para efectos de grabación.

**Solución adoptada — captura PCM vía Web Audio API:** cuando el coordinador inicia una grabación, se arma un grafo de Web Audio:

```
MediaStreamSource(rstream)
    → ScriptProcessorNode(4096 muestras)
    → GainNode(gain=0)             ← silencioso, no duplica el audio
    → AudioContext.destination     ← necesario para que el procesador tire del grafo
```

El `ScriptProcessorNode` entrega bloques de `Float32Array` en cada evento `onaudioprocess`, que se acumulan en `pcmChunks`. Al detener, los bloques se concatenan en un único `Float32Array` y se encodean a MP3.

**Encoding MP3 en el navegador:** se usa [lamejs](https://github.com/nicktindall/lamejs) (build `lame.min.js` del CDN, la versión todo-en-uno del port JavaScript de LAME). El encoder recibe PCM mono a la frecuencia de muestreo del `AudioContext` (típicamente 48 000 Hz) y produce MP3 a 64 kbps. El resultado se entrega como `Blob(type='audio/mpeg')`.

Se eligió MP3 (y no WebM/Opus, que es el codec nativo de WebRTC) porque los reproductores estándar de Windows no soportan Opus en contenedor WebM sin instalar codecs adicionales. MP3 a 64 kbps es compatible universalmente y mantiene el archivo en ~0,5 MB por minuto de audio.

### Presentación embebida

La presentación de Google Slides se carga en un `<iframe>` usando el endpoint `/embed` de Google, que siempre permite ser incrustado (a diferencia de URLs arbitrarias que pueden bloquear el embedding con `X-Frame-Options`).

**Por qué se embebe en lugar de usar la app nativa de Slides:** si el captador/a abre la app nativa de Google Slides, Chrome pasa a segundo plano. En Android (especialmente en gamas medias y bajas con gestión agresiva de memoria como la Samsung Tab A), el sistema operativo puede suspender o matar el proceso del navegador para liberar RAM, cortando el micrófono y la transmisión. Al mantener la presentación dentro del mismo documento HTML, Chrome nunca pierde el primer plano y el micrófono se mantiene activo.

El mismo razonamiento aplica al formulario de donación: se embebe en un `<iframe>` en lugar de navegar a él, para que la app nunca cambie de URL ni pase a segundo plano.

### Subida automática a Google Drive

El coordinador/a descarga el MP3 manualmente con el botón "Bajar". Adicionalmente, si `UPLOAD_URL` está configurado, la app envía el archivo codificado en Base64 como JSON a un **Google Apps Script** publicado como aplicación web.

El script (`GuardarEnDrive.gs`) corre bajo la identidad de la cuenta de ISF y usa `DriveApp.getFolderById(FOLDER_ID).createFile(blob)` para guardar el archivo. Esta API funciona tanto en carpetas de "Mi unidad" como en unidades compartidas (Shared Drives), siempre que la cuenta que ejecuta el script tenga rol de Colaborador o superior en esa unidad.

La subida usa `fetch` con `mode: 'no-cors'` porque Apps Script no devuelve cabeceras CORS para peticiones externas. Esto significa que la respuesta es opaca y no se puede leer su contenido; la app asume éxito si el `fetch` no lanza una excepción de red.

---

## Archivos del repositorio

```
isf-monitor.html      — Aplicación completa (único archivo necesario para usar)
GuardarEnDrive.gs     — Google Apps Script para guardado automático en Drive
README.md             — Este archivo
```

---

## Configuración

Las constantes configurables están al comienzo del bloque `<script>` en `isf-monitor.html`:

```javascript
// URL real del formulario de donación (no se replica, se embebe)
const FORM_URL = 'https://isf-argentina.org/formularios/donar';

// URL del Apps Script para subida automática a Drive.
// Dejar vacío ('') para deshabilitar esta función.
const UPLOAD_URL = '';

// Link de la carpeta de Drive donde se guardan las grabaciones
// (mismo FOLDER_ID que GuardarEnDrive.gs). Habilita el botón
// "Ver grabaciones en Drive" del coordinador. Vacío ('') lo oculta.
const DRIVE_FOLDER_URL = 'https://drive.google.com/drive/folders/...';

// URL embed de la presentación de Google Slides.
// Dejar vacío ('') para mostrar el cartel de marca de respaldo.
const SLIDES_URL = 'https://docs.google.com/presentation/d/.../embed?...';

// Servidores ICE (STUN + TURN). Reemplazar las credenciales TURN
// con las de ExpressTURN o Metered antes de usar en producción.
const ICE_SERVERS = [ ... ];

// Versión incremental de la app. Subir este número en cada cambio;
// se muestra en el pie de cada pantalla para confirmar que estás
// usando la última versión publicada.
const APP_VERSION = '1.6.1';
```

---

## Despliegue

La aplicación requiere ser servida por **HTTPS** porque los navegadores modernos solo conceden acceso al micrófono desde orígenes seguros.

La opción más simple es **Netlify Drop**: arrastrar `isf-monitor.html` a [netlify.com/drop](https://netlify.com/drop) y obtener una URL `https://` en menos de un minuto, sin cuenta ni configuración.

La opción más permanente es **GitHub Pages**: subir el archivo como `index.html` en un repositorio público y activar Pages en Settings → Pages. La URL queda en `https://usuario.github.io/nombre-repo`.

---

## Configuración del Apps Script para Google Drive

Ver las instrucciones completas dentro del archivo `GuardarEnDrive.gs`. En resumen:

1. Abrir [script.google.com](https://script.google.com) con la cuenta de ISF y crear un nuevo proyecto.
2. Pegar el contenido de `GuardarEnDrive.gs`.
3. Reemplazar `FOLDER_ID` con el ID de la carpeta destino (la parte larga de la URL de la carpeta en Drive).
4. Verificar que la cuenta tenga rol **Colaborador** o superior en esa carpeta (requisito para crear archivos en unidades compartidas).
5. Ejecutar la función `probar()` desde el editor para confirmar que el acceso funciona antes de publicar.
6. Publicar como **Aplicación web** (ejecutar como: yo; acceso: cualquiera) y copiar la URL resultante en `UPLOAD_URL` dentro de `isf-monitor.html`.

---

## Consumo de datos

| Segmento | Consumo aproximado |
|---|---|
| Establecimiento de la conexión | ~50–100 KB |
| Transmisión de audio (Opus, mono) | ~15 MB / hora |
| MP3 generado (64 kbps, mono) | ~0,5 MB / minuto |

La transmisión usa el codec Opus que WebRTC negocia por defecto, optimizado para voz. El encoding a MP3 ocurre localmente en el celular del coordinador al terminar cada grabación; no genera tráfico adicional de red.

---

## Limitaciones conocidas

**Bloqueo de pantalla:** mientras hay una sesión activa —el captador/a transmitiendo en la vista de donante, **o** el coordinador/a escuchando/grabando— la app pide un *Screen Wake Lock* (`navigator.wakeLock`) para que el dispositivo **no se bloquee solo** aunque nadie toque la pantalla, igual que hace una app de video. El lock se libera al detener la sesión y se vuelve a pedir automáticamente cuando la pestaña regresa a primer plano. Requiere HTTPS y un navegador compatible (Chrome para Android, Safari iOS 16.4+).

**Transmisión / escucha en segundo plano:** cuando la app está en primer plano, el micrófono (captador) y el audio recibido (coordinador) se mantienen activos. Si el usuario **bloquea manualmente** el dispositivo (botón de encendido) o cambia a otra app, el sistema operativo puede suspender el proceso del navegador y cortar la transmisión o la grabación. Esta es una limitación del navegador: solo las apps nativas pueden declarar un *foreground service* de audio que el sistema garantiza no interrumpir. El Wake Lock evita el **bloqueo automático por inactividad** (el caso más común), pero no impide la suspensión si el dispositivo se bloquea a mano o la app pasa a segundo plano. Por eso la presentación y el formulario se embeben dentro de la propia app en lugar de abrirse en apps externas.

**Indicador de micrófono del sistema:** mientras el micrófono está activo, el navegador muestra un ícono de grabación en la pestaña y Android/iPadOS muestran un punto (verde/naranja) en la esquina de la pantalla. Es una **medida de privacidad del sistema operativo que una web no puede ocultar ni desactivar**. En algunos equipos el ícono de la pestaña queda "pegado" aunque el micrófono ya esté apagado; por eso, al detener la transmisión deliberadamente, el captador/a **recarga la página** (`location.reload()`), que destruye toda referencia al micrófono y garantiza que el indicador se apague. (Las caídas transitorias no recargan: se reintenta la reconexión.)

**Subida a Drive con respuesta opaca:** por la restricción de CORS de Apps Script, la app no puede confirmar definitivamente si el archivo llegó. Si hay error de red durante la subida, la grabación sigue disponible para descarga manual.

**ScriptProcessorNode deprecado:** la API `createScriptProcessor` está marcada como deprecated en el estándar Web Audio a favor de `AudioWorklet`. Sigue funcionando en todos los navegadores actuales, pero en un futuro podría ser eliminada. La migración a `AudioWorklet` requeriría separar la lógica de captura a un Worker, lo cual agrega complejidad. Se optó por `ScriptProcessorNode` por compatibilidad y simplicidad; la deprecación no tiene fecha de eliminación confirmada.

---

## Dependencias externas

| Librería | Versión | Origen | Uso |
|---|---|---|---|
| PeerJS | 1.4.7 | cdnjs.cloudflare.com | Señalización WebRTC y gestión de conexiones P2P |
| lamejs | 1.2.1 | cdnjs.cloudflare.com | Encoding MP3 en el navegador (port JS de LAME) |
