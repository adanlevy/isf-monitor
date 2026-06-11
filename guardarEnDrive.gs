/**
 * GuardarEnDrive.gs
 * Guarda los audios MP3 del Monitor de Captación en una carpeta del
 * Google Drive de Ingeniería Sin Fronteras Argentina.
 *
 * Funciona tanto con carpetas de "Mi unidad" como de una UNIDAD COMPARTIDA
 * (Shared Drive) de la organización.
 *
 * ─────────────────────────────────────────────────────────────
 *  CÓMO INSTALARLO (una sola vez)
 * ─────────────────────────────────────────────────────────────
 *  1. Iniciá sesión con la cuenta de Google de ISF que vas a usar para
 *     publicar el script y andá a  https://script.google.com  →  Nuevo proyecto.
 *
 *  2. Borrá lo que venga por defecto y pegá TODO este archivo.
 *
 *  3. Elegí la carpeta destino DENTRO de la unidad compartida:
 *       • Abrí la unidad compartida → entrá a la carpeta donde querés
 *         que se guarden los audios (o creala).
 *       • Mirá la URL del navegador, que termina en una secuencia larga:
 *           https://drive.google.com/drive/folders/XXXXXXXXXXXXXXXXX
 *         Ese  XXXXXXXXXXXXXXXXX  es el ID de la carpeta.
 *       • Pegalo abajo en FOLDER_ID.
 *
 *  4. ⚠️ IMPORTANTE — PERMISOS DE LA UNIDAD COMPARTIDA:
 *       La cuenta con la que publicás este script (paso 1) tiene que ser
 *       MIEMBRO de esa unidad compartida con rol "Colaborador" o superior
 *       (Colaborador / Administrador de contenido / Administrador).
 *       Con rol "Lector" o "Comentador" NO puede crear archivos y va a fallar.
 *
 *  5. ANTES de publicar, probá que tenga acceso:
 *       • Arriba, en el selector de funciones, elegí  "probar"  → Ejecutar.
 *       • Autorizá los permisos cuando lo pida.
 *       • Si en el Drive aparece un archivo "PRUEBA-monitor-captacion.txt"
 *         dentro de la carpeta, ¡está todo bien! Podés borrarlo.
 *       • Si da error, revisá el FOLDER_ID y los permisos del paso 4.
 *
 *  6. Recién ahí: Implementar → Nueva implementación → engranaje →
 *     "Aplicación web".
 *       • Descripción:        Monitor de Captación
 *       • Ejecutar como:      Yo  (la cuenta de ISF del paso 1)
 *       • Quién tiene acceso: Cualquiera
 *     Implementar → copiá la "URL de la aplicación web" (termina en /exec).
 *
 *  7. Pegá esa URL en la línea  const UPLOAD_URL = '...'  del archivo
 *     isf-monitor.html
 *
 *  Listo: cada grabación que el coordinador detenga se guarda sola en esa
 *  carpeta de la unidad compartida, además de poder descargarse a mano.
 *
 *  NOTA: si tu organización usa un proyecto de Google Cloud propio o el
 *  administrador restringió el "Drive SDK", puede que necesites que el
 *  admin lo habilite. En ese caso, consultá con quien administra el Workspace.
 * ─────────────────────────────────────────────────────────────
 */

const FOLDER_ID = 'PEGA_AQUI_EL_ID_DE_LA_CARPETA';

function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
    const bytes  = Utilities.base64Decode(data.b64);
    const blob   = Utilities.newBlob(bytes, 'audio/mpeg', data.name || 'audio.mp3');
    const folder = DriveApp.getFolderById(FOLDER_ID);   // funciona también en unidades compartidas
    folder.createFile(blob);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput('Monitor de Captación ISF — endpoint activo');
}

/**
 * Función de prueba: crea un archivo de texto en la carpeta para verificar
 * que el ID y los permisos están bien. Ejecutala desde el editor (paso 5).
 */
function probar() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const f = folder.createFile('PRUEBA-monitor-captacion.txt',
    'Si ves este archivo, el guardado en Drive funciona. Podés borrarlo.',
    MimeType.PLAIN_TEXT);
  Logger.log('OK — archivo creado en: ' + folder.getName() + '  (id: ' + f.getId() + ')');
}
