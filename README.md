# DocDigital - Descargar todos los documentos

Extensión local para Brave, Google Chrome o Microsoft Edge. Descarga el
documento principal, los anexos y la trazabilidad disponibles en las bandejas
del usuario, y los organiza por categoría.

## Brave vs. Chrome/Edge

Chrome y Edge soportan la File System Access API del navegador
(`showDirectoryPicker`), así que la extensión la usa directamente: no
necesitan Python ni ningún ayudante local, y funcionan igual en Linux,
Windows o Mac. Solo tienes que cargar la extensión sin empaquetar y usarla.

Brave deshabilita esa API a propósito, así que en Brave la extensión depende
del ayudante local `native_host.py` (Python) para mostrar el selector de
carpeta y escribir los archivos, y ese ayudante hay que registrarlo a mano en
cada equipo (ver "Configurar el ayudante local en Brave" más abajo). Ese
flujo solo está probado en Linux por ahora — en Windows requeriría además un
wrapper ejecutable (`.bat`) y registrar el manifest en el Registro de
Windows, algo que este repo todavía no documenta.

## Instalar en Chrome o Edge

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona la carpeta
   `DocDigital-Downloader`.

Nada más que hacer: la extensión usa el selector de carpetas del navegador
directamente.

## Instalar en Brave

1. Abre `brave://extensions`.
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar extensión sin empaquetar**.
4. Selecciona la carpeta `DocDigital-Downloader`.

Si ya estaba instalada una versión anterior, pulsa **Recargar** en la tarjeta
de la extensión y luego recarga la página de DocDigital.

## Configurar el ayudante local en Brave

1. Anota el ID que Brave asignó a la extensión en `brave://extensions`
   (aparece bajo el nombre, ej. `ohadnblcekkdnkdodicghfmphibjfajh`).
2. Abre `cl.docdigital.downloader.json` y reemplaza:
   - `path`: ruta absoluta a `native_host.py` en tu copia del repositorio
     (ej. `/home/tu-usuario/DocDigital-Downloader/native_host.py`).
   - `chrome-extension://TU_ID_DE_EXTENSION/`: el ID anotado en el paso 1.
3. Da permiso de ejecución al ayudante: `chmod +x native_host.py`.
4. Copia el archivo editado a la carpeta de hosts nativos de Brave:
   `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/`.
5. Recarga la extensión y la página de DocDigital.

## Descargar los documentos

1. Abre <https://doc.digital.gob.cl/> e inicia sesión normalmente.
2. Si DocDigital ya estaba abierto cuando instalaste la extensión, recarga la
   página.
3. En el panel **Descargar todos los documentos**, pulsa
   **Elegir carpeta e iniciar** y selecciona el destino.
4. Mantén la pestaña abierta hasta que el panel indique que terminó.

Dentro del destino se crean estas carpetas:

- `Firmados`
- `Visados`
- `Comunicaciones-recibidas`
- `Tramitados`
- `En-tramite`
- `Borradores`
- `Devueltos-creacion`
- `Devueltos-firma`
- `Devueltos-visacion`
- `Pendientes-firma`
- `Pendientes-visacion`

Cada categoría conserva los documentos principales en su raíz y organiza los
archivos relacionados de esta forma:

```text
Firmados/
├── 6303787-documento.pdf
├── Anexos/
│   └── 6303787/
│       └── 6303787-88991-anexo.xlsx
└── Trazabilidad/
    └── 6303787-trazabilidad.pdf
```

Puedes cancelar el proceso. Los PDF que ya se hayan escrito se conservan.
Si una bandeja no está disponible o el usuario no tiene permiso para verla,
la extensión la registra como error y continúa con las demás. Los errores de
sesión sí detienen todo el proceso para evitar peticiones sin autorización.

Antes de descargar cada bandeja, la extensión revisa el destino elegido y
omite los archivos no vacíos ya existentes. Los principales y trazabilidades
se identifican por ID de documento; los anexos también incluyen su ID de
archivo.

## Alcance y privacidad

- Descarga el documento principal, todos los anexos de archivo permitidos y el
  comprobante de trazabilidad cuando DocDigital indica que está disponible.
- Conserva el formato original de los anexos, por ejemplo PDF, Word, Excel,
  imágenes o archivos comprimidos.
- No intenta evadir restricciones. Los anexos reservados sin permiso y las
  referencias que son sólo URL se registran como no disponibles.
- Lee la sesión activa de DocDigital únicamente en memoria. No solicita,
  muestra ni registra credenciales o tokens. En Brave, el ayudante local usa
  el token sólo para descargar el archivo desde el propio DocDigital y lo
  descarta al cerrar la conexión.
- Sólo se ejecuta en `doc.digital.gob.cl` y `docv3.digital.gob.cl`.
- La descarga nativa valida el origen, las rutas de la API, las categorías y
  los nombres antes de escribir dentro de la carpeta elegida.
- El permiso `nativeMessaging` sólo permite comunicarse con el ayudante local
  autorizado para esta extensión.
- Usa endpoints internos de la interfaz de DocDigital. No son una API pública
  estable y podrían cambiar en una futura versión de la plataforma.

Para desinstalarla, abre la página de extensiones del navegador y pulsa
**Quitar**. La carpeta local se puede conservar o eliminar posteriormente.
