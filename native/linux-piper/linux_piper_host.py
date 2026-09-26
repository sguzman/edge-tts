#!/usr/bin/env python3
"""Persistent CPU-only Piper Native Messaging host for Edge Natural TTS."""

from __future__ import annotations

import base64
import io
import json
import os
import re
import struct
import sys
import threading
import wave
from pathlib import Path
from typing import Any

# Defense in depth: the project never uses CUDA for Piper.
os.environ["CUDA_VISIBLE_DEVICES"] = ""

from piper import PiperVoice, SynthesisConfig  # type: ignore  # installed in app-private venv


PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 16 * 1024 * 1024
AUDIO_CHUNK_BYTES = 180_000
VOICE_ROOT = Path(
    os.environ.get(
        "EDGE_TTS_PIPER_VOICE_DIR",
        Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
        / "edge-natural-tts"
        / "voices",
    )
).expanduser()

_write_lock = threading.Lock()
_state_lock = threading.Lock()
_voice_load_lock = threading.Lock()
_loaded_voice_id: str | None = None
_loaded_voice: PiperVoice | None = None
_active_request_id: str | None = None
_active_cancel: threading.Event | None = None
_active_thread: threading.Thread | None = None


def clear_active_request(request_id: str) -> None:
    global _active_request_id, _active_cancel, _active_thread
    with _state_lock:
        if _active_request_id == request_id:
            _active_request_id = None
            _active_cancel = None
            _active_thread = None


def _read_exact(stream: Any, count: int) -> bytes | None:
    data = bytearray()
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def read_message() -> dict[str, Any] | None:
    length_bytes = _read_exact(sys.stdin.buffer, 4)
    if length_bytes is None:
        return None
    length = struct.unpack("<I", length_bytes)[0]
    if length <= 0 or length > MAX_MESSAGE_BYTES:
        raise ValueError(f"Invalid native-message length: {length}")
    payload = _read_exact(sys.stdin.buffer, length)
    if payload is None:
        return None
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Native message must be a JSON object")
    return value


def send_message(value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(payload)))
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()


def parse_voice_id(model_path: Path) -> dict[str, Any] | None:
    config_path = Path(str(model_path) + ".json")
    if not config_path.is_file():
        return None

    voice_id = model_path.stem
    match = re.match(r"^(?P<locale>[a-z]{2}_[A-Z]{2})-(?P<speaker>.+)-(?P<quality>low|medium|high)$", voice_id)
    locale = ""
    speaker = voice_id
    quality = ""
    if match:
        locale = match.group("locale").replace("_", "-")
        speaker = match.group("speaker")
        quality = match.group("quality")

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        language = config.get("language")
        if isinstance(language, dict):
            locale = str(language.get("code") or locale).replace("_", "-")
    except Exception:
        pass

    display_speaker = " ".join(part.capitalize() for part in re.split(r"[-_]+", speaker) if part)
    display_name = display_speaker or voice_id
    if quality:
        display_name = f"{display_name} {quality.capitalize()}"

    return {
        "id": voice_id,
        "name": display_name,
        "lang": locale,
        "quality": quality,
        "modelPath": str(model_path),
    }


def list_voices() -> list[dict[str, Any]]:
    if not VOICE_ROOT.is_dir():
        return []
    voices: list[dict[str, Any]] = []
    for model_path in sorted(VOICE_ROOT.glob("*.onnx")):
        voice = parse_voice_id(model_path)
        if voice is not None:
            voices.append(voice)
    return voices


def voice_model_path(voice_id: str) -> Path:
    if not voice_id or "/" in voice_id or "\\" in voice_id or voice_id in {".", ".."}:
        raise ValueError("Invalid Piper voice id")
    model_path = VOICE_ROOT / f"{voice_id}.onnx"
    config_path = Path(str(model_path) + ".json")
    if not model_path.is_file() or not config_path.is_file():
        raise FileNotFoundError(f"Piper voice is not installed: {voice_id}")
    return model_path


def get_voice(voice_id: str) -> PiperVoice:
    global _loaded_voice_id, _loaded_voice
    with _state_lock:
        if _loaded_voice is not None and _loaded_voice_id == voice_id:
            return _loaded_voice

    # Model loading is expensive. Startup warming and first synthesis may race,
    # so serialize the load and re-check after acquiring the load lock.
    with _voice_load_lock:
        with _state_lock:
            if _loaded_voice is not None and _loaded_voice_id == voice_id:
                return _loaded_voice

        model_path = voice_model_path(voice_id)
        # Hard invariant: CPU inference only.
        voice = PiperVoice.load(str(model_path), use_cuda=False)

        with _state_lock:
            _loaded_voice_id = voice_id
            _loaded_voice = voice
        return voice


def warm_default_voice() -> None:
    voice_id = "en_US-ryan-high"
    try:
        voice_model_path(voice_id)
    except Exception:
        return

    try:
        get_voice(voice_id)
    except Exception:
        # Warm-up is opportunistic. Normal synthesis reports actionable errors.
        return


def start_default_voice_warmup() -> None:
    threading.Thread(
        target=warm_default_voice,
        name="piper-warm-default",
        daemon=True,
    ).start()


_WORD_RE = re.compile(r"\S+")


def approximate_boundaries(text: str, duration_ms: float) -> list[dict[str, Any]]:
    """Produce conservative word timings until source-word alignment is added.

    Piper exposes phoneme/sample alignments, but they do not directly map back to
    source character spans. The browser contract needs source charIndex values,
    so v1 uses duration-weighted source-token timing rather than inventing an
    exact phoneme-to-source mapping.
    """
    matches = list(_WORD_RE.finditer(text))
    if not matches or duration_ms <= 0:
        return []

    weights = [max(1, len(re.sub(r"\W+", "", match.group(0)))) for match in matches]
    total_weight = max(1, sum(weights))
    cursor_ms = 0.0
    boundaries: list[dict[str, Any]] = []

    for match, weight in zip(matches, weights):
        span_ms = duration_ms * (weight / total_weight)
        boundaries.append(
            {
                "type": "boundary",
                "charIndex": match.start(),
                "length": match.end() - match.start(),
                "text": match.group(0),
                "audioPositionMs": cursor_ms,
                "durationMs": span_ms,
                "timing": "approximate",
            }
        )
        cursor_ms += span_ms

    return boundaries


def synthesize_worker(request_id: str, voice_id: str, text: str, cancel: threading.Event) -> None:
    global _active_request_id, _active_cancel, _active_thread

    try:
        send_message({"type": "status", "requestId": request_id, "status": "Loading Piper model..."})
        voice = get_voice(voice_id)
        send_message({"type": "status", "requestId": request_id, "status": "Synthesizing with Piper..."})
        config = SynthesisConfig(length_scale=1.0)
        pcm = bytearray()
        sample_rate: int | None = None
        sample_width: int | None = None
        channels: int | None = None

        for chunk in voice.synthesize(text, config, include_alignments=False):
            if cancel.is_set():
                send_message({"type": "cancelled", "requestId": request_id})
                return
            if sample_rate is None:
                sample_rate = int(chunk.sample_rate)
                sample_width = int(chunk.sample_width)
                channels = int(chunk.sample_channels)
            pcm.extend(chunk.audio_int16_bytes)

        if cancel.is_set():
            send_message({"type": "cancelled", "requestId": request_id})
            return
        if not pcm or not sample_rate or not sample_width or not channels:
            raise RuntimeError("Piper produced no audio")

        frames = len(pcm) / (sample_width * channels)
        duration_ms = (frames / sample_rate) * 1000.0

        wav_io = io.BytesIO()
        with wave.open(wav_io, "wb") as wav_file:
            wav_file.setframerate(sample_rate)
            wav_file.setsampwidth(sample_width)
            wav_file.setnchannels(channels)
            wav_file.writeframes(bytes(pcm))
        wav_bytes = wav_io.getvalue()
        send_message(
            {
                "type": "status",
                "requestId": request_id,
                "status": "Piper WAV ready...",
                "audioBytes": len(wav_bytes),
                "durationMs": duration_ms,
            }
        )

        for boundary in approximate_boundaries(text, duration_ms):
            if cancel.is_set():
                send_message({"type": "cancelled", "requestId": request_id})
                return
            boundary["requestId"] = request_id
            send_message(boundary)

        for offset in range(0, len(wav_bytes), AUDIO_CHUNK_BYTES):
            if cancel.is_set():
                send_message({"type": "cancelled", "requestId": request_id})
                return
            block = wav_bytes[offset : offset + AUDIO_CHUNK_BYTES]
            send_message(
                {
                    "type": "audioChunk",
                    "requestId": request_id,
                    "data": base64.b64encode(block).decode("ascii"),
                }
            )

        # Mark the helper idle before advertising completion so the browser can
        # immediately enqueue the next prefetched sentence without racing this
        # worker's finally block.
        clear_active_request(request_id)
        send_message(
            {
                "type": "synthesisEnd",
                "requestId": request_id,
                "durationMs": duration_ms,
                "timing": "approximate",
            }
        )
    except Exception as error:
        clear_active_request(request_id)
        send_message({"type": "error", "requestId": request_id, "message": str(error)})
    finally:
        clear_active_request(request_id)


def start_synthesis(message: dict[str, Any]) -> None:
    global _active_request_id, _active_cancel, _active_thread

    request_id = str(message.get("requestId") or "")
    voice_id = str(message.get("voiceId") or "")
    text = str(message.get("text") or "")
    if not request_id or not voice_id or not text:
        send_message({"type": "error", "requestId": request_id, "message": "Missing requestId, voiceId, or text"})
        return

    with _state_lock:
        if _active_thread is not None and _active_thread.is_alive():
            send_message(
                {
                    "type": "error",
                    "requestId": request_id,
                    "message": "Linux Piper helper is already synthesizing",
                }
            )
            return

        cancel = threading.Event()
        thread = threading.Thread(
            target=synthesize_worker,
            args=(request_id, voice_id, text, cancel),
            name=f"piper-{request_id}",
            daemon=True,
        )
        _active_request_id = request_id
        _active_cancel = cancel
        _active_thread = thread
        thread.start()


def cancel_synthesis(request_id: str) -> None:
    with _state_lock:
        active_id = _active_request_id
        cancel = _active_cancel

    if cancel is None or (request_id and request_id != active_id):
        return

    cancel.set()

    # onnxruntime inference itself is not cooperatively cancellable through
    # Piper's Python API. For interactive Stop/Pause/Quit semantics, terminate
    # this helper immediately after acknowledging cancellation. Edge will spawn
    # a fresh persistent helper on the next synthesis request.
    send_message({"type": "cancelled", "requestId": active_id or request_id})
    sys.stdout.buffer.flush()
    os._exit(0)


def handle_message(message: dict[str, Any]) -> None:
    message_type = str(message.get("type") or "")
    request_id = str(message.get("requestId") or "")

    if message_type == "hello":
        send_message(
            {
                "type": "hello",
                "protocol": PROTOCOL_VERSION,
                "platform": "linux",
                "backend": "piper",
                "cpuOnly": True,
                "voiceDir": str(VOICE_ROOT),
                "timing": "approximate-word-v1",
            }
        )
    elif message_type == "voices":
        send_message({"type": "voices", "requestId": request_id, "voices": list_voices()})
    elif message_type == "synthesize":
        start_synthesis(message)
    elif message_type == "cancel":
        cancel_synthesis(request_id)
    else:
        send_message({"type": "error", "requestId": request_id, "message": f"Unknown message type: {message_type}"})



def run_self_test(voice_id: str) -> int:
    """Synthesize a tiny probe without Native Messaging framing."""
    try:
        voice = get_voice(voice_id)
        config = SynthesisConfig(length_scale=1.0)
        pcm_bytes = 0
        sample_rate = 0
        peak = 0
        for chunk in voice.synthesize("Ryan Piper self test.", config, include_alignments=False):
            raw = chunk.audio_int16_bytes
            pcm_bytes += len(raw)
            sample_rate = int(chunk.sample_rate)
            if raw:
                import array

                samples = array.array("h")
                samples.frombytes(raw)
                if sys.byteorder != "little":
                    samples.byteswap()
                if samples:
                    peak = max(peak, max(abs(sample) for sample in samples))

        if pcm_bytes <= 0 or sample_rate <= 0 or peak <= 0:
            raise RuntimeError(
                f"Piper self-test produced invalid audio: bytes={pcm_bytes}, rate={sample_rate}, peak={peak}"
            )

        print(
            f"Piper self-test OK: {voice_id}; "
            f"{sample_rate} Hz; {pcm_bytes} PCM bytes; peak={peak}"
        )
        return 0
    except Exception as error:
        print(f"Piper self-test FAILED: {voice_id}: {error}", file=sys.stderr)
        return 1


def main() -> None:
    # Start loading Ryan immediately when Edge launches the native host. This
    # overlaps model I/O with handshake, voice discovery, and page modeling.
    start_default_voice_warmup()

    while True:
        try:
            message = read_message()
            if message is None:
                break
            handle_message(message)
        except Exception as error:
            try:
                send_message({"type": "error", "requestId": "", "message": str(error)})
            except Exception:
                break


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--self-test":
        raise SystemExit(run_self_test(sys.argv[2]))
    main()
