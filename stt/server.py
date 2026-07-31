"""
Local speech-to-text sidecar for Oatmeal, the Discord note-taker bot.

Runs faster-whisper behind a tiny HTTP API on 127.0.0.1 so the Node bot can POST
a .wav utterance and get text back. Nothing leaves this machine.

    python stt/server.py

Env vars (all optional):
    STT_HOST         default 127.0.0.1
    STT_PORT         default 8756
    WHISPER_MODEL    default large-v3   (tiny|base|small|medium|large-v3|distil-large-v3|...)
    WHISPER_DEVICE   default auto       (auto|cuda|cpu)
    WHISPER_COMPUTE  default auto       (float16|int8_float16|int8|...)
    WHISPER_LANG     default en         (set to "auto" to detect per utterance)
"""

import gc
import io
import os
import sys
import time
import logging
import threading

# ---------------------------------------------------------------------------
# Windows: make the CUDA/cuDNN DLLs shipped by the nvidia-* pip wheels findable.
# faster-whisper uses CTranslate2, which dlopen()s cublas/cudnn at import time.
# Without this, GPU users get an opaque "Library cublas64_12.dll is not found".
# Must run BEFORE faster_whisper is imported.
# ---------------------------------------------------------------------------
def _register_nvidia_dlls() -> None:
    if sys.platform != "win32":
        return
    try:
        import nvidia
    except ImportError:
        return

    found = []
    for root in nvidia.__path__:
        for dirpath, _dirnames, filenames in os.walk(root):
            if any(f.endswith(".dll") for f in filenames):
                found.append(dirpath)

    for dirpath in found:
        # add_dll_directory covers Python extension modules...
        try:
            os.add_dll_directory(dirpath)
        except (OSError, AttributeError):
            pass

    # ...but CTranslate2 loads cublas/cudnn from inside its own compiled DLL via
    # a plain LoadLibrary, which ignores add_dll_directory and searches PATH.
    # Without this, GPU inference dies with "cublas64_12.dll is not found".
    if found:
        os.environ["PATH"] = os.pathsep.join(found) + os.pathsep + os.environ.get("PATH", "")


_register_nvidia_dlls()

from fastapi import FastAPI, File, UploadFile, HTTPException  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
import uvicorn  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  stt  %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("stt")

MODEL_NAME = os.getenv("WHISPER_MODEL", "large-v3")
LANGUAGE = os.getenv("WHISPER_LANG", "en")

app = FastAPI(title="Oatmeal STT")

_model: WhisperModel | None = None
_device = "unknown"
_compute = "unknown"
# Guards load/unload against in-flight transcription. The bot unloads the model
# between meetings to hand the GPU over to the note-writing LLM, so a request
# can arrive while the model is being freed.
_lock = threading.RLock()


def _pick_backend() -> tuple[str, str]:
    """Resolve (device, compute_type), honouring explicit overrides."""
    want_device = os.getenv("WHISPER_DEVICE", "auto")
    want_compute = os.getenv("WHISPER_COMPUTE", "auto")

    if want_device == "auto":
        # ctranslate2 reports GPU count without needing torch installed.
        try:
            import ctranslate2

            want_device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            want_device = "cpu"

    if want_compute == "auto":
        want_compute = "float16" if want_device == "cuda" else "int8"

    return want_device, want_compute


def load_model() -> WhisperModel:
    """Load the model once, falling back to CPU if CUDA init fails."""
    global _model, _device, _compute
    with _lock:
        if _model is not None:
            return _model

        device, compute = _pick_backend()
        log.info("loading %s on %s (%s) ...", MODEL_NAME, device, compute)
        started = time.time()
        try:
            _model = WhisperModel(MODEL_NAME, device=device, compute_type=compute)
        except Exception as exc:
            if device == "cpu":
                raise
            log.warning("CUDA load failed (%s) - falling back to CPU int8", exc)
            device, compute = "cpu", "int8"
            _model = WhisperModel(MODEL_NAME, device=device, compute_type=compute)

        _device, _compute = device, compute
        log.info("model ready in %.1fs  [%s / %s]", time.time() - started, device, compute)
        return _model


def unload_model() -> bool:
    """
    Drop the model and release its VRAM.

    On a 12GB card, Whisper large-v3 (~4.8GB) and a 9B note-writing LLM (~7GB)
    together leave almost no headroom. They are never needed at the same time --
    Whisper works during the call, the LLM only after it -- so the bot unloads
    this before writing notes. CTranslate2 frees device memory when the object
    is collected, so dropping the last reference is what actually matters.
    """
    global _model
    with _lock:
        if _model is None:
            return False
        _model = None
        gc.collect()
        log.info("model unloaded; VRAM released")
        return True


@app.on_event("startup")
def _startup() -> None:
    # Load eagerly so the first person to speak in a meeting doesn't eat the
    # model-load latency.
    load_model()


@app.get("/health")
def health() -> dict:
    # "ok" means the service is reachable and able to transcribe. The model may
    # be unloaded between meetings; it reloads on demand, so that is not an error.
    return {
        "status": "ok",
        "loaded": _model is not None,
        "model": MODEL_NAME,
        "device": _device,
        "compute_type": _compute,
        "language": LANGUAGE,
    }


@app.post("/load")
def load() -> dict:
    """Warm the model up ahead of a meeting so the first speaker isn't clipped."""
    started = time.time()
    was_loaded = _model is not None
    load_model()
    return {"loaded": True, "already_loaded": was_loaded, "elapsed": time.time() - started}


@app.post("/unload")
def unload() -> dict:
    """Release VRAM so the note-writing LLM can have the whole GPU."""
    return {"unloaded": unload_model()}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)) -> dict:
    """Transcribe one utterance. Expects 16kHz mono PCM wav."""
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="empty audio payload")

    model = load_model()
    started = time.time()

    # Held across transcription so an /unload between meetings can't pull the
    # model out from under an utterance that is still being processed.
    # `segments` is a lazy generator, so it must be *consumed* inside the lock,
    # not merely created there.
    with _lock:
        segments, info = model.transcribe(
            io.BytesIO(audio),
            language=None if LANGUAGE == "auto" else LANGUAGE,
            beam_size=5,
            # Discord only sends packets while someone is talking, but the tail of
            # an utterance still carries room tone. VAD keeps Whisper from
            # hallucinating "Thank you." / "Subscribe!" into near-silent audio.
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()

    elapsed = time.time() - started
    log.info(
        "transcribed %.1fs audio in %.1fs -> %s",
        info.duration,
        elapsed,
        (text[:70] + "...") if len(text) > 70 else (text or "<silence>"),
    )

    return {
        "text": text,
        "language": info.language,
        "duration": info.duration,
        "elapsed": elapsed,
    }


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("STT_HOST", "127.0.0.1"),
        port=int(os.getenv("STT_PORT", "8756")),
        log_level="warning",
    )
