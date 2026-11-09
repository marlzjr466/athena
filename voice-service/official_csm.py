"""Athena's private stdio adapter for the unmodified SesameAILabs/csm source.

No MLX, alternate TTS, web service, or watermark bypass. Network access is only
enabled by the separate, explicitly approved `download` command.
"""
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import resource
import sys
import time
import textwrap
import types

ROOT = Path(os.environ['ATHENA_CSM_ROOT']).resolve()
SOURCE = Path(os.environ['ATHENA_CSM_SOURCE']).resolve()
os.environ['HF_HUB_CACHE'] = str(ROOT / 'hub')
os.environ['HUGGINGFACE_HUB_CACHE'] = str(ROOT / 'hub')
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['NO_TORCH_COMPILE'] = '1'
# The official watermark model uses torch.istft; PyTorch's MPS backend does
# not implement one of its backward kernels yet.  Allow PyTorch's documented
# CPU fallback for those unsupported operators while keeping CSM inference on
# MPS.  ATHENA_CSM_MPS_FALLBACK=0 can be used for a strict MPS diagnostic.
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
if len(sys.argv) < 2 or sys.argv[1] != 'download':
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
sys.path.insert(0, str(SOURCE))
MODEL = None
DEVICE = None
REFERENCE_CACHE = {}
ATHENA_REFERENCE_ID = 'b4b34c95-7b6f-4ea9-b2f8-17cc9d3b3cf4'
# CSM's upstream defaults are intentionally expressive but can vary speaker
# identity between short generations. These conservative values retain the
# official sampler while reducing gender/accent drift for Athena's fixed voice.
ATHENA_TEMPERATURE = 0.35
ATHENA_TOPK = 20


def _ensure_unquantized_moshi_compatibility():
    """Allow the official unquantized Mimi decoder to run on Apple Silicon.

    Moshi 0.2.2 imports bitsandbytes from its quantization helper even when the
    official Mimi checkpoint has no quantized layers.  bitsandbytes does not
    publish a supported macOS arm64 wheel.  Install a deliberately narrow
    import shim so the unquantized path can use torch's normal linear layers;
    if a quantized layer is ever encountered, fail explicitly rather than
    pretending it is supported.
    """
    try:
        __import__('bitsandbytes')
        return
    except ModuleNotFoundError:
        if sys.platform != 'darwin':
            raise

    module = types.ModuleType('bitsandbytes')

    class MatmulLtState:
        pass

    def matmul(*_args, **_kwargs):
        raise RuntimeError(
            'bitsandbytes is required for a quantized Mimi layer; '
            'the official Apple Silicon runtime only supports the '
            'unquantized CSM checkpoint.'
        )

    module.MatmulLtState = MatmulLtState
    module.matmul = matmul
    module.__path__ = []
    functional = types.ModuleType('bitsandbytes.functional')
    functional.matmul = matmul
    module.functional = functional
    sys.modules['bitsandbytes'] = module
    sys.modules['bitsandbytes.functional'] = functional


def emit(value):
    print(json.dumps(value), flush=True)


def diagnostic(error):
    # Never return raw library exceptions: gated requests can contain URLs/tokens.
    name = type(error).__name__
    text = str(error).lower()
    if 'gated' in name.lower() or '401' in text or '403' in text:
        return 'gated_access_required', 'Authorize sesame/csm-1b and meta-llama/Llama-3.2-1B on Hugging Face, then sign in locally with this environment’s huggingface-cli login. Do not paste tokens into Athena.'
    if isinstance(error, ImportError):
        return 'dependency_incompatible', 'Official CSM dependencies could not be imported (' + name + '). Repair the isolated runtime; Chatterbox is unaffected.'
    if 'bitsandbytes is required for a quantized Mimi layer' in text:
        return 'dependency_incompatible', 'The official Mimi checkpoint exposed a quantized layer, but this Apple Silicon runtime has no supported bitsandbytes wheel. The unquantized official checkpoint is required; no alternate model was substituted.'
    if 'mps' in text or 'float64' in text or 'bfloat16' in text:
        return 'device_unsupported', 'Official CSM failed on this device/dtype. MPS is experimental; select CPU and explicitly retry. No fallback occurred.'
    if 'out of memory' in text or isinstance(error, MemoryError):
        return 'insufficient_memory', 'CSM ran out of memory. Unload other models and retry with shorter context.'
    if 'cuda' in text:
        return 'device_unsupported', 'CUDA is unavailable on this machine. Select CPU or explicitly test Apple MPS.'
    if 'reference speaker mismatch' in text:
        return 'invalid_reference', 'The selected Sesame speaker does not match the enrolled reference speaker. Select the matching speaker or a different reference.'
    if 'reference must' in text:
        return 'invalid_reference', 'Reference audio must be a valid, non-silent WAV lasting 1–20 seconds, with its matching transcript.'
    if 'duration cap' in text:
        return 'duration_limit', 'CSM reached its duration limit. Use a shorter spoken sentence; no truncated audio was returned.'
    if 'inputs too long' in text:
        return 'context_limit', 'CSM’s 2048-token context limit was exceeded. Shorten the reference transcript or disable previous speech context.'
    if 'offline' in text or 'cache' in text or isinstance(error, FileNotFoundError):
        return 'model_missing', 'Required official model files are missing. Use Download official models after authorizing gated access.'
    return 'official_csm_failed', 'Official CSM failed (' + name + '). No other speech engine was substituted.'


def load(device):
    global MODEL, DEVICE
    if MODEL is not None and DEVICE == device:
        return 0
    import torch
    _ensure_unquantized_moshi_compatibility()
    from generator import load_csm_1b
    from huggingface_hub import hf_hub_download
    # Hub 0.28 can swallow a missing config then call Model() without its required
    # config argument. Diagnose missing assets before entering that official loader.
    for repo, files in [('sesame/csm-1b', ['config.json', 'model.safetensors']),
                        ('meta-llama/Llama-3.2-1B', ['tokenizer.json', 'tokenizer_config.json'])]:
        for filename in files:
            hf_hub_download(repo, filename, local_files_only=True)
    torch.set_num_threads(4)
    if device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS unavailable')
    if device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA device unsupported')
    start = time.perf_counter()
    MODEL = load_csm_1b(device=device)
    DEVICE = device
    REFERENCE_CACHE.clear()
    return (time.perf_counter() - start) * 1000


def reference(path):
    import numpy as np
    import torchaudio
    # torchaudio's installed soundfile backend reads both WAV custom references
    # and Athena's bundled US-English MP3 anchor without ffmpeg or a network
    # service. Keep decoding inside the isolated official CSM worker.
    audio, rate = torchaudio.load(str(path))
    audio = audio.float().mean(dim=0).cpu().numpy()
    seconds = len(audio) / rate
    if not 1 <= seconds <= 20 or not np.isfinite(audio).all() or not np.any(audio):
        raise ValueError('Reference must be finite, non-silent audio between 1 and 20 seconds')
    return audio, rate, seconds


def reference_segment(ref_id, speaker):
    import torch
    import torchaudio
    from generator import Segment
    import uuid
    ref_id = str(uuid.UUID(ref_id))
    folder = ROOT / 'references'
    wav = folder / (ref_id + '.wav')
    mp3 = folder / (ref_id + '.mp3')
    path = (wav if wav.exists() else mp3).resolve()
    if path.parent != folder.resolve():
        raise ValueError('Invalid reference')
    meta = json.loads((folder / (ref_id + '.json')).read_text())
    # User references must keep their enrolled speaker ID. The bundled
    # synthetic Athena anchor may be assigned to either selected CSM speaker.
    if ref_id != ATHENA_REFERENCE_ID and meta['speaker'] != speaker:
        raise ValueError('Reference speaker mismatch')
    cache_key = (ref_id, speaker)
    if cache_key not in REFERENCE_CACHE:
        audio, rate, _ = reference(path)
        tensor = torchaudio.functional.resample(torch.from_numpy(audio), rate, MODEL.sample_rate)
        REFERENCE_CACHE[cache_key] = Segment(text=meta['transcript'], speaker=speaker, audio=tensor)
    return REFERENCE_CACHE[cache_key]


def synthesize(request):
    import torch
    import torchaudio
    import soundfile as sf
    from generator import Segment
    start = time.perf_counter()
    text = request['text']
    if not isinstance(text, str) or not 1 <= len(text) <= 4000:
        raise ValueError('Speech text length')
    device = request['device']
    if device not in ('cpu', 'mps', 'cuda') or request['speaker'] not in (0, 1):
        raise ValueError('Invalid device or speaker')
    load_ms = load(device)
    ref_id = request.get('referenceId')
    refs = [reference_segment(ref_id, request['speaker'])] if ref_id else []
    # Keep the enrolled reference as the voice identity anchor on every
    # response. Feeding previously generated segments back into CSM can make
    # a short conversational turn drift toward another speaker/accent (this
    # is especially audible in a long-running floating session). We still use
    # generated chunks within this one request below so long responses remain
    # continuous, but never carry audio from an earlier turn into a new one.
    history = []
    generation_start = time.perf_counter()
    # Text chunks are sequential complete generations, NOT native streaming.
    # All pieces retain the official watermark; none is discarded.
    pieces = textwrap.wrap(text, width=300, break_long_words=True, break_on_hyphens=False)
    generated = []
    initial_context_count = len(refs)
    recent = history
    # CSM samples discrete audio tokens. A profile-keyed seed prevents a new
    # random draw from changing the apparent speaker on every short turn,
    # while still allowing different reference profiles to remain distinct.
    seed_material = f"{ref_id or 'unanchored'}:{request['speaker']}".encode()
    torch.manual_seed(int.from_bytes(hashlib.sha256(seed_material).digest()[:8], 'big') & 0x7fffffff)
    for piece in pieces:
        audio = MODEL.generate(text=piece, speaker=request['speaker'], context=refs + recent, max_audio_length_ms=30_000, temperature=ATHENA_TEMPERATURE, topk=ATHENA_TOPK)
        audio = audio.detach().float().cpu()
        if audio.ndim != 1 or not audio.numel() or not torch.isfinite(audio).all() or not torch.any(audio):
            raise ValueError('Invalid generated audio')
        if audio.numel() / MODEL.sample_rate >= 29.9:
            raise ValueError('Generation reached duration cap; use a shorter sentence')
        generated.append(audio)
        if sum(item.numel() for item in generated) > MODEL.sample_rate * 80:
            raise ValueError('Generation reached duration cap')
        recent.append(Segment(text=piece, speaker=request['speaker'], audio=audio))
        while len(recent) > 2 or sum(s.audio.numel() for s in recent) > MODEL.sample_rate * 20:
            recent.pop(0)
    audio = torch.cat(generated)
    seconds = audio.numel() / MODEL.sample_rate
    output = io.BytesIO()
    sf.write(output, audio.numpy(), MODEL.sample_rate, format='WAV', subtype='PCM_16')
    end = time.perf_counter()
    return {'wav': base64.b64encode(output.getvalue()).decode(), 'metrics': {
        'loadMs': load_ms, 'generationMs': (end - generation_start) * 1000,
        'totalMs': (end - start) * 1000, 'audioSeconds': seconds,
        'peakProcessBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
        'device': device, 'contextSegments': initial_context_count}}


def download():
    from huggingface_hub import snapshot_download, hf_hub_download
    from moshi.models import loaders
    from huggingface_hub import get_hf_file_metadata, hf_hub_url, get_token
    # Validate both gates before transferring large assets; never accept terms.
    for repo, filename in [('sesame/csm-1b', 'model.safetensors'), ('meta-llama/Llama-3.2-1B', 'tokenizer.json')]:
        emit({'stage': 'Checking authorized access to ' + repo})
        try:
            get_hf_file_metadata(hf_hub_url(repo, filename), token=get_token())
        except Exception as error:
            code, message = diagnostic(error)
            emit({'ok': False, 'code': code, 'message': repo + ': ' + message})
            sys.exit(1)
    # Official loader resources only; never download an alternative checkpoint.
    for repo, patterns in [('sesame/csm-1b', ['config.json', 'model.safetensors']),
                           ('meta-llama/Llama-3.2-1B', ['tokenizer*', 'special_tokens_map.json', 'config.json'])]:
        emit({'stage': 'Downloading ' + repo + ' (indeterminate)'})
        snapshot_download(repo, allow_patterns=patterns, max_workers=1)
    emit({'stage': 'Downloading official Mimi tokenizer'})
    hf_hub_download(loaders.DEFAULT_REPO, loaders.MIMI_NAME)
    emit({'stage': 'Preparing official audio watermark model'})
    from watermarking import load_watermarker
    load_watermarker(device='cpu')
    (ROOT / 'downloaded.json').write_text(json.dumps({'source': 'sesame/csm-1b', 'downloadedAt': time.time()}))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'worker'
    if mode == 'reference':
        with contextlib.redirect_stdout(sys.stderr):
            _, _, seconds = reference(Path(sys.argv[2]))
        emit({'ok': True, 'seconds': seconds})
        return
    if mode == 'download':
        download()
        emit({'ok': True, 'stage': 'Official model files downloaded; inference still needs verification'})
        return
    if mode == 'inspect':
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            from generator import load_csm_1b, Segment
        ROOT.mkdir(parents=True, exist_ok=True)
        (ROOT / 'runtime-ready.json').write_text(json.dumps({'torch': torch.__version__, 'source': 'SesameAILabs/csm'}))
        emit({'ok': True, 'mpsAvailable': torch.backends.mps.is_available(), 'torch': torch.__version__, 'inferenceVerified': False})
        return
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 20000:
                raise ValueError('Request too large')
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = synthesize(request)
            emit({'id': request['id'], 'ok': True, **result})
        except Exception as error:
            code, message = diagnostic(error)
            emit({'id': request.get('id'), 'ok': False, 'code': code, 'message': message})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code, message = diagnostic(error)
        emit({'ok': False, 'code': code, 'message': message})
        sys.exit(1)
