"use strict";

const ALLOWED_ORIGINS = new Set([
  "https://doc.digital.gob.cl",
  "https://docv3.digital.gob.cl",
]);
const FILE_DOWNLOAD_PATH =
  /^\/(?:backend\/)?api\/documentos\/[^/]+\/archivos\/[^/]+$/;
const TRACE_DOWNLOAD_PATH =
  /^\/(?:backend\/)?api\/documentos\/[^/]+\/comprobante-trazabilidad$/;
const MAX_TOKEN_LENGTH = 16_384;
const NATIVE_HOST_NAME = "cl.docdigital.downloader";
const ALLOWED_FOLDERS = new Set([
  "Firmados",
  "Visados",
  "Comunicaciones-recibidas",
  "Tramitados",
  "En-tramite",
  "Borradores",
  "Devueltos-creacion",
  "Devueltos-firma",
  "Devueltos-visacion",
  "Pendientes-firma",
  "Pendientes-visacion",
]);

let nativePort = null;
let nextNativeRequestId = 1;
const pendingNativeRequests = new Map();

function assertTrustedSender(sender) {
  const senderUrl = sender.tab?.url || sender.url;
  const origin = senderUrl ? new URL(senderUrl).origin : "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    throw new Error("La solicitud no proviene de DocDigital.");
  }
}

function sanitizeFilename(filename) {
  const safe = String(filename || "documento.pdf")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 180);
  return safe || "documento.pdf";
}

function validateFolder(folder) {
  if (!ALLOWED_FOLDERS.has(folder)) {
    throw new Error("La carpeta de descarga no está permitida.");
  }
  return folder;
}

function validateSubpath(subpath) {
  const value = String(subpath || "");
  if (
    value === "" ||
    value === "Trazabilidad" ||
    /^Anexos\/[0-9]+$/.test(value)
  ) {
    return value;
  }
  throw new Error("La subcarpeta de descarga no está permitida.");
}

function validateDownloadDestination(folder, subpath) {
  validateFolder(folder);
  validateSubpath(subpath);
}

function validateFileRequest(message) {
  const url = new URL(message.url);
  if (
    !ALLOWED_ORIGINS.has(url.origin) ||
    (!FILE_DOWNLOAD_PATH.test(url.pathname) &&
      !TRACE_DOWNLOAD_PATH.test(url.pathname)) ||
    url.username ||
    url.password
  ) {
    throw new Error("La dirección de descarga no está permitida.");
  }

  const token = String(message.token || "");
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    /[\r\n]/.test(token)
  ) {
    throw new Error("La sesión de DocDigital no es válida.");
  }

  return {
    url: url.href,
    token,
    filename: sanitizeFilename(message.filename),
  };
}

function rejectNativeRequests(message) {
  for (const { reject } of pendingNativeRequests.values()) {
    reject(new Error(message));
  }
  pendingNativeRequests.clear();
}

function disconnectNativeHost(message = "El ayudante local se desconectó.") {
  const port = nativePort;
  nativePort = null;
  if (port) {
    port.disconnect();
  }
  rejectNativeRequests(message);
}

function getNativePort() {
  if (nativePort) {
    return nativePort;
  }

  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  port.onMessage.addListener((response) => {
    const requestId = response?.requestId;
    if (!Number.isInteger(requestId)) {
      return;
    }
    const pending = pendingNativeRequests.get(requestId);
    if (!pending) {
      return;
    }
    pendingNativeRequests.delete(requestId);
    if (response.ok) {
      pending.resolve(response);
    } else {
      pending.reject(new Error(response.error || "El ayudante local falló."));
    }
  });
  port.onDisconnect.addListener(() => {
    if (nativePort === port) {
      nativePort = null;
    }
    const detail = chrome.runtime.lastError?.message;
    rejectNativeRequests(detail || "El ayudante local se desconectó.");
  });
  return port;
}

function nativeRequest(message) {
  const port = getNativePort();
  const requestId = nextNativeRequestId;
  nextNativeRequestId += 1;

  return new Promise((resolve, reject) => {
    pendingNativeRequests.set(requestId, { resolve, reject });
    try {
      port.postMessage({ requestId, ...message });
    } catch (error) {
      pendingNativeRequests.delete(requestId);
      reject(error);
    }
  });
}

async function startNativeDownload(message) {
  if (message.kind !== "file") {
    throw new Error("Tipo de descarga no permitido.");
  }
  validateDownloadDestination(message.folder, message.subpath);
  const request = validateFileRequest(message);
  return nativeRequest({
    action: "download",
    url: request.url,
    token: request.token,
    filename: request.filename,
    folder: message.folder,
    subpath: message.subpath || "",
  });
}

async function handleMessage(message, sender) {
  assertTrustedSender(sender);

  switch (message?.action) {
    case "nativeSelectDirectory":
      return nativeRequest({ action: "selectDirectory" });
    case "nativeExistingFiles":
      validateDownloadDestination(message.folder, message.subpath);
      return nativeRequest({
        action: "existingFiles",
        folder: message.folder,
        subpath: message.subpath || "",
      });
    case "nativeDownload":
      return startNativeDownload(message);
    case "nativeCancel":
      disconnectNativeHost("Descarga cancelada.");
      return {};
    case "nativeRelease":
      disconnectNativeHost();
      return {};
    default:
      throw new Error("Acción no permitida.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({ ok: false, error: String(error?.message || error) }),
    );
  return true;
});
