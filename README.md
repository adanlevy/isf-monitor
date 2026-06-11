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
- Registra el nombre del captador/a en el nombre del archivo para facilitar el seguimiento.
- Detecta cuando el captador/a se desconecta y actualiza el estado visualmente.

### Modo Captador (tablet)

- Recibe el código de la coordinación e inicia la transmisión de micrófono.
- Al conectar, la pantalla pasa a una vista de donante: muestra la presentación de Google Slides de ISF Argentina embebida, a pantalla completa.
- Desde esa misma vista se puede acceder al formulario real de donación (`isf-argentina.org/formularios/donar`) embebido, sin salir de la app.
- Un menú discreto (botón `···`, esquina superior derecha) da acceso a los controles técnicos: estado de la transmisión, nivel de micrófono, pantalla completa, y detener con confirmación de dos pasos.
- Reconexión automática si el audio se interrumpe por un problema de red (hasta 8 intentos con 1,5 s de espera entre cada uno).

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

**Reconexión automática:** `placeCall()` observa `RTCPeerConnection.iceConnectionState`. Si el estado pasa a `failed` o `disconnected`, `scheduleReconnect()` reintenta la llamada con backoff lineal de 1,5 s, hasta 8 intentos. En el lado del coordinador, `watchCoordConn()` hace el mismo seguimiento y dispara `coordDisconnected()` después de un período de gracia de 3,5 s para evitar falsos positivos por blips de red.

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

Las cuatro constantes configurables están al comienzo del bloque `<script>` en `isf-monitor.html`:

```javascript
// URL real del formulario de donación (no se replica, se embebe)
const FORM_URL = 'https://isf-argentina.org/formularios/donar';

// URL del Apps Script para subida automática a Drive.
// Dejar vacío ('') para deshabilitar esta función.
const UPLOAD_URL = '';

// URL embed de la presentación de Google Slides.
// Dejar vacío ('') para mostrar el cartel de marca de respaldo.
const SLIDES_URL = 'https://docs.google.com/presentation/d/.../embed?...';

// Servidores ICE (STUN + TURN). Reemplazar las credenciales TURN
// con las de ExpressTURN o Metered antes de usar en producción.
const ICE_SERVERS = [ ... ];
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

**Transmisión en segundo plano:** cuando la app está en primer plano en Chrome para Android, el micrófono se mantiene activo. Si el usuario minimiza Chrome o cambia a otra app nativa (por ejemplo, la app de Google Slides), el sistema operativo puede suspender el proceso y cortar la transmisión. Esta es una limitación del navegador: solo las apps nativas Android pueden declarar un *foreground service* de audio que el sistema garantiza que no interrumpirá. Por esta razón, la presentación y el formulario se embeben dentro de la propia app en lugar de abrirse en apps externas.

**Reconexión no automática en el lado del coordinador:** si el celular del coordinador pierde conectividad, la instancia de `Peer` se destruye. Al recuperar la red, el coordinador debe recargar la app manualmente para obtener un nuevo código y que el captador/a se reconecte.

**Subida a Drive con respuesta opaca:** por la restricción de CORS de Apps Script, la app no puede confirmar definitivamente si el archivo llegó. Si hay error de red durante la subida, la grabación sigue disponible para descarga manual.

**ScriptProcessorNode deprecado:** la API `createScriptProcessor` está marcada como deprecated en el estándar Web Audio a favor de `AudioWorklet`. Sigue funcionando en todos los navegadores actuales, pero en un futuro podría ser eliminada. La migración a `AudioWorklet` requeriría separar la lógica de captura a un Worker, lo cual agrega complejidad. Se optó por `ScriptProcessorNode` por compatibilidad y simplicidad; la deprecación no tiene fecha de eliminación confirmada.

---

## Dependencias externas

| Librería | Versión | Origen | Uso |
|---|---|---|---|
| PeerJS | 1.4.7 | cdnjs.cloudflare.com | Señalización WebRTC y gestión de conexiones P2P |
| lamejs | 1.2.1 | cdnjs.cloudflare.com | Encoding MP3 en el navegador (port JS de LAME) |
