(() => {
  "use strict";

  const PANEL_ID = "docdigital-documents-downloader";
  const ALLOWED_HOSTS = new Set([
    "doc.digital.gob.cl",
    "docv3.digital.gob.cl",
  ]);
  const PAGE_SIZE = 30;
  const MAX_PAGES = 1000;
  const REQUEST_DELAY_MS = 250;
  const MAX_CONSECUTIVE_ERRORS = 5;
  const HAS_DIRECTORY_PICKER =
    window.isSecureContext && "showDirectoryPicker" in window;
  const START_BUTTON_LABEL = "Elegir carpeta e iniciar";

  if (!ALLOWED_HOSTS.has(window.location.hostname)) {
    return;
  }

  document.getElementById(PANEL_ID)?.remove();

  const backendBase = new URL("/backend/", window.location.origin);
  const endpoints = {
    signatureTasks: "/api/documentos/tareas/firma",
    approvalTasks: "/api/documentos/tareas/visacion",
    receivedTasks: "/api/documentos/tareas/recibidos",
    processedTasks: "/api/documentos/tareas/creacion/procesados",
    inProgressTasks: "/api/documentos/tareas/creacion/en-tramite",
    draftTasks: "/api/documentos/tareas/creacion/borradores",
    returnedCreationTasks: "/api/documentos/tareas/creacion/rechazadas",
    documentDetail: "/api/documentos/{id}/tramitacion/detalle",
    download: "/api/documentos/{id}/archivos/{archivoId}",
    available: "/api/documentos/{id}/archivo-principal/disponible-descargar",
    restricted: "/api/documentos/{id}/archivos/{archivoId}/contenido-restringido",
    traceDownload: "/api/documentos/{id}/comprobante-trazabilidad",
    traceAvailable:
      "/api/documentos/{id}/tramitacion/comprobante-trazabilidad/disponible-descargar",
  };
  const TRAYS = [
    {
      key: "signed",
      label: "Firmados",
      folder: "Firmados",
      endpoint: endpoints.signatureTasks,
      filters: { isCompletada: "true" },
    },
    {
      key: "approved",
      label: "Visados",
      folder: "Visados",
      endpoint: endpoints.approvalTasks,
      filters: { isCompletada: "true" },
    },
    {
      key: "received",
      label: "Comunicaciones recibidas",
      folder: "Comunicaciones-recibidas",
      endpoint: endpoints.receivedTasks,
      filters: { isCompletada: "false", isRechazada: "false" },
    },
    {
      key: "processed",
      label: "Tramitados",
      folder: "Tramitados",
      endpoint: endpoints.processedTasks,
      filters: { isCompletada: "false", isRechazada: "false" },
    },
    {
      key: "in-progress",
      label: "En trámite",
      folder: "En-tramite",
      endpoint: endpoints.inProgressTasks,
      filters: { isCompletada: "false", isRechazada: "false" },
    },
    {
      key: "drafts",
      label: "Borradores",
      folder: "Borradores",
      endpoint: endpoints.draftTasks,
      filters: { isCompletada: "false", isRechazada: "false" },
    },
    {
      key: "creation-returned",
      label: "Devueltos de creación",
      folder: "Devueltos-creacion",
      endpoint: endpoints.returnedCreationTasks,
      filters: { isCompletada: "false", isRechazada: "false" },
    },
    {
      key: "signature-returned",
      label: "Devueltos de firma",
      folder: "Devueltos-firma",
      endpoint: endpoints.signatureTasks,
      filters: { isCompletada: "false", isRechazada: "true" },
    },
    {
      key: "approval-returned",
      label: "Devueltos de visación",
      folder: "Devueltos-visacion",
      endpoint: endpoints.approvalTasks,
      filters: { isCompletada: "false", isRechazada: "true" },
    },
    {
      key: "signature-pending",
      label: "Pendientes de firma",
      folder: "Pendientes-firma",
      endpoint: endpoints.signatureTasks,
      filters: { isCompletada: "false", isRechazada: "false" },
    },
    {
      key: "approval-pending",
      label: "Pendientes de visación",
      folder: "Pendientes-visacion",
      endpoint: endpoints.approvalTasks,
      filters: { isCompletada: "false", isRechazada: "false" },
    },
  ];

  let activeController = null;
  let activeDestinationKind = null;
  let cancelled = false;
  let running = false;
  let selectingDestination = false;

  const host = document.createElement("div");
  host.id = PANEL_ID;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        color-scheme: light;
      }
      .panel {
        box-sizing: border-box;
        width: min(330px, calc(100vw - 32px));
        padding: 14px;
        border: 1px solid rgba(213, 219, 227, 0.7);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.86);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 16px 45px rgba(16, 24, 40, 0.2);
        color: #17202a;
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .header {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 12px;
      }
      h2 {
        margin: 0;
        font-size: 15px;
        line-height: 1.3;
      }
      p {
        margin: 6px 0 0;
      }
      .muted {
        color: #5d6875;
        font-size: 11px;
      }
      .close {
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #4d5966;
        cursor: pointer;
        font-size: 19px;
        line-height: 1;
      }
      .close:hover {
        background: rgba(238, 241, 244, 0.9);
      }
      .progress-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }
      progress {
        flex: 1;
        width: 100%;
        height: 8px;
        accent-color: #005ea8;
      }
      .progress-pct {
        min-width: 32px;
        text-align: right;
        font: 600 11px/1 system-ui, sans-serif;
        color: #005ea8;
      }
      .status {
        min-height: 36px;
        margin-top: 8px;
        white-space: pre-wrap;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      .button {
        flex: 1 1 auto;
        min-width: 100px;
        min-height: 36px;
        padding: 8px 12px;
        border: 1px solid #005ea8;
        border-radius: 6px;
        background: #005ea8;
        color: #ffffff;
        cursor: pointer;
        font: 600 12px/1.2 system-ui, sans-serif;
      }
      .button.secondary {
        background: rgba(255, 255, 255, 0.6);
        color: #005ea8;
      }
      .button:disabled {
        border-color: #aeb7c0;
        background: #dce1e6;
        color: #697581;
        cursor: not-allowed;
      }
      .error {
        color: #b42318;
      }
      .success {
        color: #087443;
      }
    </style>
    <section class="panel" aria-label="Descargador de documentos de DocDigital">
      <div class="header">
        <div>
          <h2>Descargar todos los documentos</h2>
          <p class="muted">Guarda principales, anexos y trazabilidad por bandeja.</p>
        </div>
        <button class="close" type="button" aria-label="Cerrar">×</button>
      </div>
      <div class="progress-row">
        <progress value="0" max="1" aria-label="Progreso de descarga"></progress>
        <span class="progress-pct">0%</span>
      </div>
      <div class="status" role="status">Listo. Inicia sesión en DocDigital antes de comenzar.</div>
      <div class="actions">
        <button class="button start" type="button">${START_BUTTON_LABEL}</button>
        <button class="button secondary cancel" type="button" disabled>Cancelar</button>
        <button class="button secondary report" type="button" disabled>Abrir resumen</button>
      </div>
    </section>
  `;
  document.documentElement.appendChild(host);

  const closeButton = shadow.querySelector(".close");
  const startButton = shadow.querySelector(".start");
  const cancelButton = shadow.querySelector(".cancel");
  const reportButton = shadow.querySelector(".report");
  const progress = shadow.querySelector("progress");
  const progressPct = shadow.querySelector(".progress-pct");
  const status = shadow.querySelector(".status");
  let lastReportInfo = null;

  function setStatus(message, type = "") {
    status.textContent = message;
    status.className = `status ${type}`.trim();
  }

  // El detalle línea a línea ya no se muestra en el panel: queda en el
  // resumen de contingencias, que siempre se guarda al terminar la descarga.
  function addLog() {}

  function updateProgress(value) {
    progress.value = value;
    const max = progress.max || 1;
    const pct = Math.round((Math.min(value, max) / max) * 100);
    progressPct.textContent = `${pct}%`;
  }

  function setRunning(value) {
    running = value;
    startButton.disabled = value;
    cancelButton.disabled = !value;
    closeButton.disabled = value;
    startButton.textContent = value
      ? "Descargando…"
      : START_BUTTON_LABEL;
  }

  function parseCookieValue(rawValue) {
    let decoded = rawValue;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      // Conserva el valor original si la cookie contiene un escape incompleto.
    }

    try {
      const parsed = JSON.parse(decoded);
      return typeof parsed === "string" ? parsed : decoded;
    } catch {
      return decoded;
    }
  }

  function getSessionToken() {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("token="));

    if (!cookie) {
      return null;
    }

    const rawValue = cookie.slice("token=".length);
    return rawValue ? parseCookieValue(rawValue) : null;
  }

  function endpointUrl(path) {
    const url = new URL(path.replace(/^\//, ""), backendBase);
    if (url.origin !== window.location.origin) {
      throw new Error(
        "DocDigital configuró un servidor externo; la descarga se detuvo para proteger la sesión.",
      );
    }
    return url;
  }

  function fillEndpoint(template, values) {
    return Object.entries(values).reduce(
      (result, [key, value]) =>
        result.replace(`{${key}}`, encodeURIComponent(String(value))),
      template,
    );
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timeoutId);
        reject(new DOMException("Descarga cancelada", "AbortError"));
      };
      const timeoutId = window.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function extensionMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "La extensión no respondió.");
    }
    return response;
  }

  async function saveWithNativeHost({
    url,
    filename,
    folder,
    subpath = "",
    token,
  }) {
    try {
      await extensionMessage({
        action: "nativeDownload",
        kind: "file",
        url,
        filename,
        folder,
        subpath,
        token,
      });
    } catch (error) {
      if (cancelled) {
        throw new DOMException("Descarga cancelada", "AbortError");
      }
      throw error;
    }
  }

  function documentIdFromFilename(filename) {
    return String(filename).match(/^(\d+)-/)?.[1] || null;
  }

  async function getExistingFilenames(destination, folder, subpath = "") {
    if (destination.kind === "native-directory") {
      const response = await extensionMessage({
        action: "nativeExistingFiles",
        folder,
        subpath,
      });
      return new Set((response.filenames || []).map(String));
    }

    if (destination.kind !== "directory") {
      throw new Error("El destino de descarga no es compatible.");
    }

    const filenames = new Set();
    for await (const entry of destination.handle.values()) {
      if (entry.kind !== "file") {
        continue;
      }
      try {
        const file = await entry.getFile();
        if (file.size > 0) {
          filenames.add(entry.name);
        }
      } catch {
        // Un archivo ilegible no debe impedir revisar el resto de la carpeta.
      }
    }
    return filenames;
  }

  async function getExistingDocumentIds(destination, folder) {
    const filenames = await getExistingFilenames(destination, folder);
    const documentIds = new Set();
    for (const filename of filenames) {
      const documentId = documentIdFromFilename(filename);
      if (documentId) {
        documentIds.add(documentId);
      }
    }
    return documentIds;
  }

  async function getErrorMessage(response) {
    try {
      const data = await response.clone().json();
      return (
        data?.message ||
        data?.error?.message ||
        data?.error ||
        `HTTP ${response.status}`
      );
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  async function authenticatedFetch(url, options = {}) {
    const retryableStatuses = new Set([429, 502, 503, 504]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = getSessionToken();
      if (!token) {
        throw new Error(
          "No se encontró una sesión activa. Inicia sesión nuevamente en DocDigital.",
        );
      }

      const headers = new Headers(options.headers || {});
      headers.set("Authorization", `Bearer ${token}`);
      headers.set("Accept", options.accept || "application/json");

      const response = await fetch(url, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        signal: activeController?.signal,
      });

      if (response.ok) {
        return response;
      }

      if (retryableStatuses.has(response.status) && attempt < 2) {
        await response.body?.cancel().catch(() => {});
        await delay(750 * 2 ** attempt, activeController?.signal);
        continue;
      }

      const detail = await getErrorMessage(response);
      throw new Error(`DocDigital respondió ${response.status}: ${detail}`);
    }

    throw new Error("DocDigital no respondió después de varios intentos.");
  }

  async function getJson(url) {
    const response = await authenticatedFetch(url);
    return response.json();
  }

  function isSessionError(error) {
    const message = String(error?.message || error);
    return (
      !getSessionToken() ||
      message.includes("DocDigital respondió 401") ||
      message.includes("La sesión de DocDigital dejó de estar disponible")
    );
  }

  async function listTasks(tray) {
    const tasksByDocument = new Map();
    let pageNumber = 0;
    let fetchedCount = 0;
    let expectedTotal = null;

    while (pageNumber < MAX_PAGES) {
      if (cancelled) {
        throw new DOMException("Descarga cancelada", "AbortError");
      }

      const url = endpointUrl(tray.endpoint);
      url.search = new URLSearchParams({
        ...tray.filters,
        orderBy: "updatedAt",
        orderType: "DESC",
        pageNumber: String(pageNumber),
        pageSize: String(PAGE_SIZE),
      }).toString();

      setStatus(`Consultando ${tray.label}… página ${pageNumber + 1}`);
      const payload = await getJson(url);
      const batch = Array.isArray(payload?.result) ? payload.result : null;

      if (!batch) {
        throw new Error(
          "DocDigital devolvió una lista de documentos inesperada.",
        );
      }

      if (expectedTotal === null) {
        const reportedTotal = Number(
          payload?.total_count ?? payload?.totalCount,
        );
        expectedTotal = Number.isFinite(reportedTotal) ? reportedTotal : null;
      }

      fetchedCount += batch.length;
      for (const task of batch) {
        if (task?.docId !== undefined && task?.docId !== null) {
          const key = String(task.docId);
          if (!tasksByDocument.has(key)) {
            tasksByDocument.set(key, task);
          }
        }
      }

      if (
        batch.length === 0 ||
        batch.length < PAGE_SIZE ||
        (expectedTotal !== null && fetchedCount >= expectedTotal)
      ) {
        break;
      }

      pageNumber += 1;
    }

    if (pageNumber >= MAX_PAGES) {
      throw new Error("Se alcanzó el límite de seguridad de paginación.");
    }

    return Array.from(tasksByDocument.values());
  }

  function filenameFromDisposition(header) {
    if (!header) {
      return null;
    }

    const encodedMatch = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (encodedMatch) {
      try {
        return decodeURIComponent(encodedMatch[1].trim());
      } catch {
        return encodedMatch[1].trim();
      }
    }

    const plainMatch = header.match(
      /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i,
    );
    return plainMatch ? (plainMatch[1] || plainMatch[2]).trim() : null;
  }

  function sanitizeFilename(filename, fallback) {
    let result = String(filename || fallback)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+|\.+$/g, "");

    if (!result) {
      result = fallback;
    }

    if (result.length > 180) {
      const extensionMatch = result.match(/(\.[A-Za-z0-9]{1,8})$/);
      const extension = extensionMatch?.[1] || "";
      result = `${result.slice(0, 180 - extension.length)}${extension}`;
    }

    return result;
  }

  function getDownloadFilename(docId, mainFile, response = null) {
    let filename =
      filenameFromDisposition(
        response?.headers?.get("content-disposition"),
      ) ||
      mainFile?.refNombre ||
      mainFile?.nombreOriginal ||
      mainFile?.nombre ||
      mainFile?.fileName ||
      `documento-${docId}.pdf`;

    if (!/\.[A-Za-z0-9]{1,8}$/.test(filename)) {
      const contentType =
        response?.headers?.get("content-type") || mainFile?.contentType || "";
      if (contentType.includes("application/pdf")) {
        filename += ".pdf";
      }
    }

    const prefixed = String(filename).startsWith(`${docId}-`)
      ? filename
      : `${docId}-${filename}`;
    return sanitizeFilename(prefixed, `${docId}-documento.pdf`);
  }

  function extensionForContentType(contentType) {
    const normalized = String(contentType || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    return (
      {
        "application/pdf": ".pdf",
        "application/msword": ".doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
          ".docx",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
          ".xlsx",
        "application/zip": ".zip",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "text/plain": ".txt",
      }[normalized] || ""
    );
  }

  function artifactId(value) {
    return String(value ?? "archivo")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 80);
  }

  function getAnnexFilename(docId, annex) {
    const fileId = artifactId(annex?.id);
    let name =
      annex?.nombre ||
      annex?.refNombre ||
      annex?.nombreOriginal ||
      annex?.fileName ||
      `anexo-${fileId}`;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
      name += extensionForContentType(annex?.contentType);
    }
    return sanitizeFilename(
      `${docId}-${fileId}-${name}`,
      `${docId}-${fileId}-anexo`,
    );
  }

  async function getSubdirectoryDestination(destination, segments) {
    if (destination.kind !== "directory") {
      return destination;
    }

    let handle = destination.handle;
    for (const segment of segments) {
      handle = await handle.getDirectoryHandle(segment, { create: true });
    }
    return { kind: "directory", handle };
  }

  async function writeFile(directory, filename, data) {
    const fileHandle = await directory.getFileHandle(filename, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(data);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  function timestampForFilename(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return (
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
  }

  function buildContingencyReport(destination, results) {
    const now = new Date();
    const destinationName =
      destination.kind === "directory" ? destination.handle.name : destination.name;
    const downloaded = results.filter((r) => r.status === "descargado").length;
    const unavailable = results.filter((r) => r.status === "no_disponible").length;
    const failed = results.filter((r) => r.status === "error").length;
    const skipped = results.filter((r) => r.status === "omitido_existente").length;

    const lines = [
      "DocDigital Downloader — Resumen de contingencias",
      `Generado: ${now.toLocaleString("es-CL")}`,
      `Carpeta destino: ${destinationName}`,
      "",
      "TOTALES",
      `Nuevos: ${downloaded} | Ya existían: ${skipped} | No disponibles: ${unavailable} | Errores: ${failed}`,
      "",
      "POR BANDEJA",
    ];

    for (const tray of TRAYS) {
      const trayResults = results.filter((r) => r.trayKey === tray.key);
      if (trayResults.length === 0) {
        continue;
      }
      const trayDownloaded = trayResults.filter((r) => r.status === "descargado").length;
      const traySkipped = trayResults.filter(
        (r) => r.status === "omitido_existente",
      ).length;
      const trayUnavailable = trayResults.filter(
        (r) => r.status === "no_disponible",
      ).length;
      const trayFailed = trayResults.filter((r) => r.status === "error").length;
      lines.push(
        `${tray.label}: ${trayDownloaded} nuevos, ${traySkipped} existentes, ${trayUnavailable} no disponibles, ${trayFailed} errores.`,
      );
    }

    const errors = results.filter((r) => r.status === "error");
    lines.push("", `ERRORES DETALLADOS (${errors.length})`);
    if (errors.length === 0) {
      lines.push("Sin errores en esta corrida.");
    } else {
      for (const error of errors) {
        lines.push(
          `- ${error.trayLabel} · ${error.documentId} · ${error.artifactType}: ${error.detail || "sin detalle"}`,
        );
      }
    }
    lines.push("");

    return "﻿" + lines.join("\n");
  }

  async function saveContingencyReport(destination, results) {
    const report = buildContingencyReport(destination, results);
    const filename = `resumen-contingencias-${timestampForFilename(new Date())}.txt`;

    try {
      if (destination.kind === "directory") {
        await writeFile(destination.handle, filename, report);
      } else if (destination.kind === "native-directory") {
        await extensionMessage({
          action: "nativeWriteLog",
          content: report,
          filename,
        });
      } else {
        return;
      }
      addLog(`Resumen de contingencias guardado: ${filename}`);
      lastReportInfo = { destination, filename };
      reportButton.disabled = false;
    } catch (error) {
      addLog(
        `No se pudo guardar el resumen de contingencias: ${error.message}`,
      );
    }
  }

  async function saveArtifact({
    destination,
    folder,
    subpath,
    url,
    filename,
    accept,
  }) {
    if (destination.kind === "directory") {
      const response = await authenticatedFetch(url, { accept });
      const blob = await response.blob();
      await writeFile(destination.handle, filename, blob);
      return;
    }

    const token = getSessionToken();
    if (!token) {
      throw new Error("La sesión de DocDigital dejó de estar disponible.");
    }
    await saveWithNativeHost({
      url: url.href,
      filename,
      folder,
      subpath,
      token,
    });
  }

  async function downloadTask(destination, task, folder) {
    const docId = task.docId;
    const baseResult = {
      status: "error",
      detail: "",
    };

    const detailPath = fillEndpoint(endpoints.documentDetail, { id: docId });
    const detailPayload = await getJson(endpointUrl(detailPath));
    const detail = detailPayload?.result;
    const mainFile = detail?.documento?.archivoPrincipal;
    const fileId = mainFile?.id;

    if (fileId === undefined || fileId === null) {
      return {
        ...baseResult,
        detail: "No se encontró el archivo principal del documento.",
      };
    }

    const availabilityPath = fillEndpoint(endpoints.available, { id: docId });
    const availability = await getJson(endpointUrl(availabilityPath));
    if (availability?.result !== true) {
      return {
        ...baseResult,
        status: "no_disponible",
        detail: "DocDigital indicó que el archivo aún no está disponible.",
      };
    }

    const downloadPath = fillEndpoint(endpoints.download, {
      id: docId,
      archivoId: fileId,
    });
    const downloadUrl = endpointUrl(downloadPath);
    let filename;
    if (destination.kind === "directory") {
      const response = await authenticatedFetch(downloadUrl, {
        accept: "application/pdf,application/octet-stream,*/*",
      });
      filename = getDownloadFilename(docId, mainFile, response);
      const blob = await response.blob();
      await writeFile(destination.handle, filename, blob);
    } else {
      const token = getSessionToken();
      if (!token) {
        throw new Error("La sesión de DocDigital dejó de estar disponible.");
      }
      filename = getDownloadFilename(docId, mainFile);
      await saveWithNativeHost({
        url: downloadUrl.href,
        filename,
        folder,
        token,
      });
    }

    return {
      status: "descargado",
      detail: "",
    };
  }

  function addArtifactResult(
    results,
    run,
    docId,
    artifactType,
    status,
    detail = "",
    filename = "",
  ) {
    results.push({
      trayKey: run.tray.key,
      trayLabel: run.tray.label,
      documentId: String(docId),
      artifactType,
      status,
      detail,
      filename,
    });
  }

  async function prepareTraceState(run, results) {
    try {
      const destination = await getSubdirectoryDestination(run.destination, [
        "Trazabilidad",
      ]);
      const filenames = await getExistingFilenames(
        destination,
        run.tray.folder,
        "Trazabilidad",
      );
      const documentIds = new Set();
      for (const filename of filenames) {
        const documentId = documentIdFromFilename(filename);
        if (documentId) {
          documentIds.add(documentId);
        }
      }
      return { destination, documentIds };
    } catch (error) {
      if (error?.name === "AbortError" || isSessionError(error)) {
        throw error;
      }
      const message = String(error?.message || error).slice(0, 300);
      addArtifactResult(
        results,
        run,
        "",
        "trazabilidad",
        "error",
        `No se pudo preparar la carpeta de trazabilidad: ${message}`,
      );
      addLog(`${run.tray.label} · trazabilidad: error — ${message}`);
      return null;
    }
  }

  async function downloadAnnexes(run, docId, annexes, results) {
    if (!Array.isArray(annexes) || annexes.length === 0) {
      return false;
    }

    const fileAnnexes = annexes.filter(
      (annex) => annex?.categoriaArchivo !== "ANEXO_URL",
    );
    for (const annex of annexes) {
      if (annex?.categoriaArchivo === "ANEXO_URL") {
        addArtifactResult(
          results,
          run,
          docId,
          "anexo_url",
          "no_disponible",
          `Referencia URL: ${annex.descripcion || annex.nombre || "sin descripción"}`,
        );
      }
    }
    if (fileAnnexes.length === 0) {
      return false;
    }

    const subpath = `Anexos/${docId}`;
    let destination;
    let existingFilenames;
    try {
      destination = await getSubdirectoryDestination(run.destination, [
        "Anexos",
        String(docId),
      ]);
      existingFilenames = await getExistingFilenames(
        destination,
        run.tray.folder,
        subpath,
      );
    } catch (error) {
      if (error?.name === "AbortError" || isSessionError(error)) {
        throw error;
      }
      const message = String(error?.message || error).slice(0, 300);
      addArtifactResult(
        results,
        run,
        docId,
        "anexo",
        "error",
        `No se pudo preparar la carpeta de anexos: ${message}`,
      );
      return true;
    }

    let failed = false;
    for (const annex of fileAnnexes) {
      const fileId = annex?.id;
      if (fileId === undefined || fileId === null) {
        addArtifactResult(
          results,
          run,
          docId,
          "anexo",
          "no_disponible",
          "El anexo no tiene identificador de archivo.",
        );
        continue;
      }

      const filename = getAnnexFilename(docId, annex);
      const prefix = `${docId}-${artifactId(fileId)}-`;
      if (
        Array.from(existingFilenames).some((existing) =>
          existing.startsWith(prefix),
        )
      ) {
        addArtifactResult(
          results,
          run,
          docId,
          "anexo",
          "omitido_existente",
          "El anexo ya estaba descargado.",
          filename,
        );
        continue;
      }

      try {
        const fileDocumentId = annex?.documentoId ?? docId;
        const restrictedPath = fillEndpoint(endpoints.restricted, {
          id: fileDocumentId,
          archivoId: fileId,
        });
        const restricted = await getJson(endpointUrl(restrictedPath));
        if (restricted?.result === true) {
          addArtifactResult(
            results,
            run,
            docId,
            "anexo",
            "no_disponible",
            "Anexo restringido para la sesión actual.",
            filename,
          );
          continue;
        }

        const downloadPath = fillEndpoint(endpoints.download, {
          id: fileDocumentId,
          archivoId: fileId,
        });
        await saveArtifact({
          destination,
          folder: run.tray.folder,
          subpath,
          url: endpointUrl(downloadPath),
          filename,
          accept: "*/*",
        });
        existingFilenames.add(filename);
        addArtifactResult(
          results,
          run,
          docId,
          "anexo",
          "descargado",
          "",
          filename,
        );
        addLog(`${run.tray.label} · ${docId}: anexo descargado`);
      } catch (error) {
        if (error?.name === "AbortError" || isSessionError(error)) {
          throw error;
        }
        const message = String(error?.message || error).slice(0, 300);
        addArtifactResult(
          results,
          run,
          docId,
          "anexo",
          "error",
          message,
          filename,
        );
        failed = true;
        addLog(`${run.tray.label} · ${docId}: anexo con error — ${message}`);
      }
    }
    return failed;
  }

  async function downloadTrace(run, docId, traceState, results) {
    if (!traceState) {
      return false;
    }
    const documentId = String(docId);
    const filename = `${documentId}-trazabilidad.pdf`;
    if (traceState.documentIds.has(documentId)) {
      addArtifactResult(
        results,
        run,
        docId,
        "trazabilidad",
        "omitido_existente",
        "La trazabilidad ya estaba descargada.",
        filename,
      );
      return false;
    }

    try {
      const availabilityPath = fillEndpoint(endpoints.traceAvailable, {
        id: docId,
      });
      const availability = await getJson(endpointUrl(availabilityPath));
      if (availability?.result !== true) {
        addArtifactResult(
          results,
          run,
          docId,
          "trazabilidad",
          "no_disponible",
          "La trazabilidad aún no está disponible.",
          filename,
        );
        return false;
      }

      const tracePath = fillEndpoint(endpoints.traceDownload, { id: docId });
      await saveArtifact({
        destination: traceState.destination,
        folder: run.tray.folder,
        subpath: "Trazabilidad",
        url: endpointUrl(tracePath),
        filename,
        accept: "application/pdf,application/octet-stream,*/*",
      });
      traceState.documentIds.add(documentId);
      addArtifactResult(
        results,
        run,
        docId,
        "trazabilidad",
        "descargado",
        "",
        filename,
      );
      addLog(`${run.tray.label} · ${docId}: trazabilidad descargada`);
      return false;
    } catch (error) {
      if (error?.name === "AbortError" || isSessionError(error)) {
        throw error;
      }
      const message = String(error?.message || error).slice(0, 300);
      addArtifactResult(
        results,
        run,
        docId,
        "trazabilidad",
        "error",
        message,
        filename,
      );
      addLog(
        `${run.tray.label} · ${docId}: trazabilidad con error — ${message}`,
      );
      return true;
    }
  }

  async function downloadRelatedArtifacts(run, task, traceState, results) {
    const docId = task.docId;
    let failed = false;
    try {
      const detailPath = fillEndpoint(endpoints.documentDetail, { id: docId });
      const detailPayload = await getJson(endpointUrl(detailPath));
      const annexes = detailPayload?.result?.documento?.anexos;
      failed = (await downloadAnnexes(run, docId, annexes, results)) || failed;
    } catch (error) {
      if (error?.name === "AbortError" || isSessionError(error)) {
        throw error;
      }
      const message = String(error?.message || error).slice(0, 300);
      addArtifactResult(
        results,
        run,
        docId,
        "anexo",
        "error",
        `No se pudo consultar los anexos: ${message}`,
      );
      addLog(`${run.tray.label} · ${docId}: anexos con error — ${message}`);
      failed = true;
    }

    return (await downloadTrace(run, docId, traceState, results)) || failed;
  }

  async function prepareTrayRuns(destination, results) {
    const trayRuns = [];

    for (const tray of TRAYS) {
      try {
        const tasks = await listTasks(tray);
        const trayDestination =
          destination.kind === "directory"
            ? {
                kind: "directory",
                handle: await destination.handle.getDirectoryHandle(
                  tray.folder,
                  { create: true },
                ),
              }
            : destination;

        setStatus(`Revisando archivos existentes en ${tray.label}…`);
        const existingDocumentIds = await getExistingDocumentIds(
          trayDestination,
          tray.folder,
        );
        trayRuns.push({
          tray,
          tasks,
          destination: trayDestination,
          existingDocumentIds,
        });
        addLog(
          `${tray.label}: ${tasks.length} encontrados, ${existingDocumentIds.size} existentes.`,
        );
      } catch (error) {
        if (
          error?.name === "AbortError" ||
          cancelled ||
          isSessionError(error)
        ) {
          throw error;
        }
        const message = String(error?.message || error).slice(0, 300);
        results.push({
          trayKey: tray.key,
          trayLabel: tray.label,
          status: "error",
          detail: `No se pudo consultar la bandeja: ${message}`,
        });
        addLog(`${tray.label}: omitida por error — ${message}`);
      }
    }

    return trayRuns;
  }

  async function runDownload(destination, results) {
    const trayRuns = await prepareTrayRuns(destination, results);
    const totalTasks = trayRuns.reduce(
      (total, run) => total + run.tasks.length,
      0,
    );
    let processedTasks = 0;
    progress.max = Math.max(totalTasks * 2, 1);
    updateProgress(0);

    for (const run of trayRuns) {
      let consecutiveErrors = 0;
      for (const task of run.tasks) {
        if (cancelled) {
          throw new DOMException("Descarga cancelada", "AbortError");
        }

        const documentId = String(task.docId);
        const resultBase = {
          trayKey: run.tray.key,
          trayLabel: run.tray.label,
          documentId,
          artifactType: "principal",
        };
        if (run.existingDocumentIds.has(documentId)) {
          results.push({
            ...resultBase,
            status: "omitido_existente",
            detail: "El documento ya estaba descargado.",
          });
          consecutiveErrors = 0;
          processedTasks += 1;
          updateProgress(processedTasks);
          addLog(
            `${run.tray.label} · ${task.docId}: principal omitido — ya existe`,
          );
          continue;
        }

        let itemFailed = false;
        setStatus(
          `Descargando principal ${processedTasks + 1} de ${totalTasks}\n${run.tray.label} · documento ${task.docId}`,
        );

        try {
          const result = await downloadTask(
            run.destination,
            task,
            run.tray.folder,
          );
          results.push({ ...resultBase, ...result });
          itemFailed = result.status === "error";
          if (result.status === "descargado") {
            run.existingDocumentIds.add(documentId);
          }
          addLog(
            `${run.tray.label} · ${task.docId}: principal ${result.status}${result.detail ? ` — ${result.detail}` : ""}`,
          );
        } catch (error) {
          if (error?.name === "AbortError" || isSessionError(error)) {
            throw error;
          }
          const message = String(error?.message || error).slice(0, 300);
          results.push({
            ...resultBase,
            status: "error",
            detail: message,
          });
          itemFailed = true;
          addLog(
            `${run.tray.label} · ${task.docId}: principal con error — ${message}`,
          );
        }

        processedTasks += 1;
        updateProgress(processedTasks);
        consecutiveErrors = itemFailed ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          addLog(
            `${run.tray.label}: se omitió el resto después de ${MAX_CONSECUTIVE_ERRORS} errores consecutivos.`,
          );
          break;
        }
        if (processedTasks < totalTasks) {
          await delay(REQUEST_DELAY_MS, activeController?.signal);
        }
      }
    }

    let relatedProcessed = 0;
    for (const run of trayRuns) {
      if (run.tasks.length === 0) {
        continue;
      }
      const traceState = await prepareTraceState(run, results);
      let consecutiveErrors = 0;
      for (const task of run.tasks) {
        if (cancelled) {
          throw new DOMException("Descarga cancelada", "AbortError");
        }

        setStatus(
          `Revisando anexos y trazabilidad ${relatedProcessed + 1} de ${totalTasks}\n${run.tray.label} · documento ${task.docId}`,
        );
        const itemFailed = await downloadRelatedArtifacts(
          run,
          task,
          traceState,
          results,
        );
        relatedProcessed += 1;
        updateProgress(Math.min(totalTasks + relatedProcessed, progress.max));
        consecutiveErrors = itemFailed ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          addLog(
            `${run.tray.label}: se omitió el resto de anexos y trazabilidades después de ${MAX_CONSECUTIVE_ERRORS} documentos con errores consecutivos.`,
          );
          break;
        }
        if (relatedProcessed < totalTasks) {
          await delay(REQUEST_DELAY_MS, activeController?.signal);
        }
      }
    }

    updateProgress(progress.max);
  }

  closeButton.addEventListener("click", () => {
    if (!running && !selectingDestination) {
      host.remove();
    }
  });

  cancelButton.addEventListener("click", () => {
    cancelled = true;
    activeController?.abort();
    if (activeDestinationKind === "native-directory") {
      void extensionMessage({ action: "nativeCancel" }).catch(() => {});
    }
    cancelButton.disabled = true;
    setStatus("Cancelando…");
  });

  reportButton.addEventListener("click", async () => {
    if (!lastReportInfo || reportButton.disabled) {
      return;
    }
    reportButton.disabled = true;
    try {
      if (lastReportInfo.destination.kind === "directory") {
        const fileHandle = await lastReportInfo.destination.handle.getFileHandle(
          lastReportInfo.filename,
        );
        const file = await fileHandle.getFile();
        const blob = new Blob([file], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        await extensionMessage({
          action: "nativeOpenLog",
          filename: lastReportInfo.filename,
        });
      }
    } catch (error) {
      setStatus(`No se pudo abrir el resumen: ${error.message}`, "error");
    } finally {
      reportButton.disabled = false;
    }
  });

  startButton.addEventListener("click", async () => {
    if (running || selectingDestination) {
      return;
    }

    if (!getSessionToken()) {
      setStatus(
        "No se encontró una sesión activa. Inicia sesión en DocDigital y vuelve a intentarlo.",
        "error",
      );
      return;
    }

    let destination;
    selectingDestination = true;
    startButton.disabled = true;
    closeButton.disabled = true;
    try {
      if (HAS_DIRECTORY_PICKER) {
        const directory = await window.showDirectoryPicker({
          mode: "readwrite",
          startIn: "downloads",
        });
        destination = { kind: "directory", handle: directory };
      } else {
        const selection = await extensionMessage({
          action: "nativeSelectDirectory",
        });
        if (selection.cancelled) {
          setStatus("No se seleccionó una carpeta.");
          return;
        }
        destination = {
          kind: "native-directory",
          name: selection.name || "carpeta seleccionada",
        };
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatus("No se seleccionó una carpeta.");
      } else if (HAS_DIRECTORY_PICKER) {
        setStatus(`No fue posible abrir la carpeta: ${error.message}`, "error");
      } else {
        setStatus(
          `No fue posible abrir el selector local: ${error.message}. Recarga la extensión desde brave://extensions.`,
          "error",
        );
      }
      return;
    } finally {
      selectingDestination = false;
      startButton.disabled = false;
      closeButton.disabled = false;
    }

    cancelled = false;
    activeController = new AbortController();
    activeDestinationKind = destination.kind;
    addLog(
      destination.kind === "directory"
        ? `Carpeta seleccionada: ${destination.handle.name}`
        : `Carpeta seleccionada: ${destination.name}`,
    );
    setRunning(true);

    const results = [];
    try {
      await runDownload(destination, results);
      const downloaded = results.filter(
        (result) => result.status === "descargado",
      ).length;
      const unavailable = results.filter(
        (result) => result.status === "no_disponible",
      ).length;
      const failed = results.filter((result) => result.status === "error").length;
      const skipped = results.filter(
        (result) => result.status === "omitido_existente",
      ).length;

      for (const tray of TRAYS) {
        const trayResults = results.filter(
          (result) => result.trayKey === tray.key,
        );
        if (trayResults.length > 0) {
          const trayDownloaded = trayResults.filter(
            (result) => result.status === "descargado",
          ).length;
          const traySkipped = trayResults.filter(
            (result) => result.status === "omitido_existente",
          ).length;
          const trayUnavailable = trayResults.filter(
            (result) => result.status === "no_disponible",
          ).length;
          const trayFailed = trayResults.filter(
            (result) => result.status === "error",
          ).length;
          addLog(
            `${tray.label}: ${trayDownloaded} nuevos, ${traySkipped} existentes, ${trayUnavailable} no disponibles, ${trayFailed} errores.`,
          );
        }
      }

      await saveContingencyReport(destination, results);

      setStatus(
        `Proceso terminado: ${downloaded} archivos nuevos, ${skipped} ya existían, ${unavailable} no disponibles y ${failed} errores.`,
        failed === 0 ? "success" : "",
      );
    } catch (error) {
      if (error?.name === "AbortError" || cancelled) {
        setStatus(
          "Descarga cancelada. Los archivos ya guardados se conservaron.",
        );
        addLog("Proceso cancelado por el usuario.");
      } else {
        setStatus(`No se pudo completar: ${error.message}`, "error");
        addLog(`Error general: ${error.message}`);
      }

    } finally {
      if (activeDestinationKind === "native-directory") {
        await extensionMessage({ action: "nativeRelease" }).catch(() => {});
      }
      activeController = null;
      activeDestinationKind = null;
      setRunning(false);
    }
  });
})();
