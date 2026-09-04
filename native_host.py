#!/usr/bin/python3
"""Native messaging host for selecting a folder and saving DocDigital files."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
from subprocess import TimeoutExpired
import sys
import tempfile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


ALLOWED_CALLERS = {
    "chrome-extension://ohadnblcekkdnkdodicghfmphibjfajh/",
}
ALLOWED_ORIGINS = {
    "https://doc.digital.gob.cl",
    "https://docv3.digital.gob.cl",
}
ALLOWED_FOLDERS = {
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
}
FILE_DOWNLOAD_PATH = re.compile(
    r"^/(?:backend/)?api/documentos/[^/]+/archivos/[^/]+$"
)
TRACE_DOWNLOAD_PATH = re.compile(
    r"^/(?:backend/)?api/documentos/[^/]+/comprobante-trazabilidad$"
)
ANNEX_SUBPATH = re.compile(r"^Anexos/[0-9]+$")
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
MAX_TOKEN_LENGTH = 16_384
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
MAX_LOG_BYTES = 2 * 1024 * 1024

selected_directory: Path | None = None


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> Request | None:
        validate_download_url(new_url)
        return super().redirect_request(
            request,
            file_pointer,
            code,
            message,
            headers,
            new_url,
        )


def read_exact(byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            raise EOFError("Mensaje nativo incompleto.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message() -> dict[str, Any] | None:
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise EOFError("Cabecera nativa incompleta.")
    (message_length,) = struct.unpack("=I", header)
    if message_length <= 0 or message_length > MAX_MESSAGE_BYTES:
        raise ValueError("Tamaño de mensaje nativo no permitido.")
    message = json.loads(read_exact(message_length).decode("utf-8"))
    if not isinstance(message, dict):
        raise ValueError("El mensaje nativo debe ser un objeto.")
    return message


def write_message(message: dict[str, Any]) -> None:
    encoded = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def sanitize_filename(filename: Any) -> str:
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(filename or "documento.pdf"))
    safe = re.sub(r"\s+", " ", safe).strip().strip(".")
    safe = safe.encode("utf-8")[:180].decode("utf-8", errors="ignore").strip()
    return safe or "documento.pdf"


def validate_folder(folder: Any) -> str:
    value = str(folder or "")
    if value not in ALLOWED_FOLDERS:
        raise ValueError("La carpeta de descarga no está permitida.")
    return value


def validate_subpath(subpath: Any) -> str:
    value = str(subpath or "")
    if value == "" or value == "Trazabilidad" or ANNEX_SUBPATH.fullmatch(value):
        return value
    raise ValueError("La subcarpeta de descarga no está permitida.")


def validate_download_url(raw_url: Any) -> str:
    url = str(raw_url or "")
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if (
        origin not in ALLOWED_ORIGINS
        or parsed.username
        or parsed.password
        or not (
            FILE_DOWNLOAD_PATH.fullmatch(parsed.path)
            or TRACE_DOWNLOAD_PATH.fullmatch(parsed.path)
        )
    ):
        raise ValueError("La dirección de descarga no está permitida.")
    return url


def validate_token(token: Any) -> str:
    value = str(token or "")
    if not value or len(value) > MAX_TOKEN_LENGTH or "\r" in value or "\n" in value:
        raise ValueError("La sesión de DocDigital no es válida.")
    return value


def destination_path(folder: Any, subpath: Any) -> Path:
    if selected_directory is None:
        raise RuntimeError("Primero debes seleccionar una carpeta.")

    selected_root = selected_directory.resolve(strict=True)
    parts = [validate_folder(folder)]
    safe_subpath = validate_subpath(subpath)
    if safe_subpath:
        parts.extend(safe_subpath.split("/"))

    target = selected_root.joinpath(*parts)
    candidate = target.resolve(strict=False)
    if not candidate.is_relative_to(selected_root):
        raise ValueError("La carpeta de destino sale de la ubicación seleccionada.")

    target.mkdir(parents=True, exist_ok=True)
    resolved_target = target.resolve(strict=True)
    if not resolved_target.is_relative_to(selected_root):
        raise ValueError("La carpeta de destino sale de la ubicación seleccionada.")
    return resolved_target


def root_log_path(filename: Any) -> Path:
    if selected_directory is None:
        raise RuntimeError("Primero debes seleccionar una carpeta.")

    selected_root = selected_directory.resolve(strict=True)
    safe_name = sanitize_filename(filename)
    if not safe_name.lower().endswith(".txt"):
        safe_name += ".txt"

    target = selected_root / safe_name
    candidate = target.resolve(strict=False)
    if not candidate.is_relative_to(selected_root):
        raise ValueError("El nombre del archivo de registro no es válido.")
    return candidate


def write_log(message: dict[str, Any]) -> dict[str, Any]:
    content = str(message.get("content") or "")
    if not content:
        raise ValueError("El contenido del registro está vacío.")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_LOG_BYTES:
        raise ValueError("El registro de contingencias es demasiado grande.")

    target = root_log_path(message.get("filename"))
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".contingencias.",
            suffix=".part",
            dir=target.parent,
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(encoded)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, target)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return {"filename": target.name}


def default_picker_directory() -> Path:
    downloads = Path.home() / "Descargas"
    return downloads if downloads.is_dir() else Path.home()


def picker_environment() -> dict[str, str]:
    environment = os.environ.copy()
    runtime_directory = Path(f"/run/user/{os.getuid()}")
    environment.setdefault("DISPLAY", ":0")
    if runtime_directory.is_dir():
        environment.setdefault("XDG_RUNTIME_DIR", str(runtime_directory))
        session_bus = runtime_directory / "bus"
        if session_bus.exists():
            environment.setdefault(
                "DBUS_SESSION_BUS_ADDRESS",
                f"unix:path={session_bus}",
            )
        wayland_sockets = sorted(
            path
            for path in runtime_directory.glob("wayland-*")
            if path.is_socket()
        )
        if wayland_sockets:
            environment.setdefault("WAYLAND_DISPLAY", wayland_sockets[0].name)
    return environment


def select_directory() -> dict[str, Any]:
    global selected_directory

    process = subprocess.Popen(
        [
            "/usr/bin/zenity",
            "--file-selection",
            "--directory",
            "--title=Selecciona dónde guardar los documentos de DocDigital",
            f"--filename={default_picker_directory()}/",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=picker_environment(),
        text=True,
    )
    try:
        stdout, stderr = process.communicate()
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=2)
        except TimeoutExpired:
            process.kill()
        raise

    if process.returncode == 1:
        return {"cancelled": True}
    if process.returncode != 0:
        detail = stderr.strip() or "sin detalle"
        raise RuntimeError(f"No fue posible abrir el selector: {detail}")

    candidate = Path(stdout.strip()).expanduser().resolve(strict=True)
    if not candidate.is_dir():
        raise ValueError("El destino seleccionado no es una carpeta.")
    selected_directory = candidate
    return {"cancelled": False, "name": candidate.name or str(candidate)}


def existing_files(message: dict[str, Any]) -> dict[str, Any]:
    directory = destination_path(message.get("folder"), message.get("subpath"))
    filenames = sorted(
        entry.name
        for entry in directory.iterdir()
        if entry.is_file() and entry.stat().st_size > 0
    )
    return {"filenames": filenames}


def download_file(message: dict[str, Any]) -> dict[str, Any]:
    url = validate_download_url(message.get("url"))
    token = validate_token(message.get("token"))
    filename = sanitize_filename(message.get("filename"))
    directory = destination_path(message.get("folder"), message.get("subpath"))
    final_path = directory / filename
    parsed_url = urlparse(url)
    origin = f"{parsed_url.scheme}://{parsed_url.netloc}"
    request = Request(
        url,
        headers={
            "Accept": "application/pdf,application/octet-stream,*/*",
            "Authorization": f"Bearer {token}",
            "Origin": origin,
            "Referer": f"{origin}/",
            "User-Agent": "Mozilla/5.0 DocDigital-Downloader/3.2",
        },
    )
    opener = build_opener(SafeRedirectHandler())
    temporary_path: Path | None = None

    try:
        with opener.open(request, timeout=120) as response:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{filename}.",
                suffix=".part",
                dir=directory,
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                while chunk := response.read(DOWNLOAD_CHUNK_BYTES):
                    temporary_file.write(chunk)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
        if temporary_path.stat().st_size <= 0:
            raise RuntimeError("DocDigital devolvió un archivo vacío.")
        os.replace(temporary_path, final_path)
        temporary_path = None
    except HTTPError as error:
        raise RuntimeError(f"DocDigital respondió HTTP {error.code}.") from error
    except URLError as error:
        raise RuntimeError(f"No se pudo conectar con DocDigital: {error.reason}") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return {"filename": filename}


def handle_message(message: dict[str, Any]) -> dict[str, Any]:
    action = message.get("action")
    if action == "selectDirectory":
        return select_directory()
    if action == "existingFiles":
        return existing_files(message)
    if action == "download":
        return download_file(message)
    if action == "writeLog":
        return write_log(message)
    raise ValueError("Acción nativa no permitida.")


def stop_on_signal(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt


def main() -> int:
    caller = sys.argv[1] if len(sys.argv) > 1 else ""
    if caller not in ALLOWED_CALLERS:
        return 1

    signal.signal(signal.SIGTERM, stop_on_signal)
    while True:
        try:
            message = read_message()
            if message is None:
                return 0
            request_id = message.get("requestId")
            if not isinstance(request_id, int) or request_id < 1:
                raise ValueError("Identificador de solicitud no válido.")
            try:
                result = handle_message(message)
                write_message({"requestId": request_id, "ok": True, **result})
            except Exception as error:
                write_message(
                    {
                        "requestId": request_id,
                        "ok": False,
                        "error": str(error)[:500],
                    }
                )
        except KeyboardInterrupt:
            return 0
        except (EOFError, json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
