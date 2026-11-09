"""Athena adapter for the official bosonai/higgs-tts-3-4b checkpoint.

Checks the checkpoint against the isolated Transformers installation before
downloading weights or attempting inference. No substitute speech engine.
"""
import base64
import contextlib
import inspect
import io
import json
import os
from pathlib import Path
import re
import resource
import sys
import time
import uuid

ROOT = Path(os.environ['ATHENA_HIGGS_ROOT']).resolve()
REPO = 'bosonai/higgs-tts-3-4b'
os.environ['HF_HUB_CACHE'] = str(ROOT / 'hub')
os.environ['HUGGINGFACE_HUB_CACHE'] = str(ROOT / 'hub')
# Keep HF_HOME/HF_TOKEN_PATH unchanged so the user's existing login is available.
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['NO_TORCH_COMPILE'] = '1'
os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '0'
if len(sys.argv) < 2 or sys.argv[1] not in ('download', 'setup-check', 'inspect'):
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'

MODEL = None
PROCESSOR = None
DEVICE = None
DTYPE = None
ARCHITECTURE = None
SUPPORTED = {'emotion': [], 'style': [], 'prosody': [], 'sfx': []}
SAMPLE_RATE = 24000
STREAMING = False

TOKEN_RE = re.compile(r'<\|([a-z0-9_-]+):([^|<>]*)\|>', re.I)
DOCUMENTED = json.loads(Path(__file__).with_name('higgs_tokens.json').read_text())


class HiggsCompatibilityError(RuntimeError):
    pass


def validate_controls(text):
    for kind, value in TOKEN_RE.findall(text):
        if value not in DOCUMENTED.get(kind, []):
            raise ValueError('Unsupported Higgs speech control: ' + kind + ':' + value)
    return text


def emit(value):
    print(json.dumps(value), flush=True)


def diagnostic(error):
    name = type(error).__name__
    text = str(error).lower()
    if isinstance(error, HiggsCompatibilityError):
        return 'runtime_incompatible', str(error)
    if 'unsupported higgs speech control' in text:
        return 'unsupported_control', str(error)
    if 'gated' in name.lower() or '401' in text or '403' in text:
        return 'gated_access_required', 'Authorize bosonai/higgs-tts-3-4b on Hugging Face, then sign in locally with huggingface-cli login. Do not paste tokens into Athena.'
    if 'sglang' in text or 'cuda' in text and 'unavailable' in text:
        return 'device_unsupported', 'NVIDIA SGLang-Omni is not used on this Mac. Select Apple MPS or CPU for the official Transformers runtime.'
    if isinstance(error, ImportError) or 'no module' in text:
        return 'dependency_incompatible', 'Higgs dependencies could not be imported (' + name + '). Repair the isolated Higgs runtime; Chatterbox and Sesame are unchanged.'
    if 'out of memory' in text or isinstance(error, MemoryError):
        return 'insufficient_memory', 'Higgs TTS 3 ran out of unified memory. Unload other models, including Ollama if needed, and retry. Athena did not switch voice engines.'
    if 'mps' in text or 'bfloat16' in text:
        return 'device_unsupported', 'Higgs failed on this device/dtype. Select CPU and retry explicitly. No fallback engine was used.'
    if 'offline' in text or 'cache' in text or isinstance(error, FileNotFoundError):
        return 'model_missing', 'Official Higgs TTS 3 files are missing. Download bosonai/higgs-tts-3-4b after confirming the research/non-commercial terms.'
    if 'no official generate' in text or 'could not produce audio' in text:
        return 'runtime_incompatible', str(error)
    return 'higgs_failed', 'Higgs TTS 3 failed (' + name + '). No other speech engine was substituted.'


def model_dir():
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(REPO, local_files_only=True))


def tokenizer_tokens(directory):
    # Controls can be regular text tokens, not added/special tokens. The
    # official catalog is authoritative; tokenizer contents cannot extend it.
    return {kind: list(values) for kind, values in DOCUMENTED.items()}


def check_compatibility(directory):
    import transformers
    from transformers import AutoConfig
    architecture = inspect_architecture(directory)
    try:
        AutoConfig.from_pretrained(str(directory), trust_remote_code=True, local_files_only=True)
    except (ValueError, KeyError) as error:
        model_type = architecture['modelType']
        raise HiggsCompatibilityError(
            f'Transformers {transformers.__version__} cannot load model_type={model_type} '
            f'({type(error).__name__}: {str(error).splitlines()[0][:360]}). The official checkpoint supplies '
            f'auto_map={architecture["autoMap"]}. A compatible Higgs TTS 3 architecture, '
            'multi-codebook generator, and audio decoder are required; installing PyTorch '
            'or switching MPS to CPU does not supply them. No speech was generated.'
        ) from error
    # Registration alone is not an audio-generation contract. The previous
    # adapter guessed method names/kwargs and could mistake token IDs for audio.
    raise HiggsCompatibilityError(
        f'Configuration {architecture["modelType"]} is recognized by Transformers '
        f'{transformers.__version__}, but this adapter has no verified Higgs TTS 3 '
        'waveform-generation API. Speech and reference conditioning remain unavailable.'
    )


def inspect_architecture(directory):
    config = json.loads((directory / 'config.json').read_text())
    return {
        'modelType': config.get('model_type'),
        'architectures': config.get('architectures') or [],
        'autoMap': config.get('auto_map') or {},
        'sampleRate': config.get('sampling_rate') or config.get('sample_rate') or SAMPLE_RATE,
    }


def setup_check():
    import shutil
    import torch
    disk = shutil.disk_usage(str(ROOT if ROOT.exists() else Path.home()))
    emit({
        'ok': True,
        'torch': torch.__version__,
        'mpsAvailable': bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available()),
        'cudaAvailable': torch.cuda.is_available(),
        'freeDiskBytes': disk.free,
        'estimatedCheckpointBytes': 9300 * 1024 * 1024,
        'estimatedWeightBytes': 8 * 1024 ** 3,
        'streaming': False,
        'license': 'research/non-commercial; commercial embedding requires a separate Boson license',
        'note': 'Device availability is not model compatibility. Run inspect to check the official architecture before downloading weights.',
    })


def download():
    from huggingface_hub import HfApi, hf_hub_download, hf_hub_url, get_hf_file_metadata, get_token
    ROOT.mkdir(parents=True, exist_ok=True)
    emit({'stage': 'Checking authorized access to ' + REPO, 'progress': 0})
    try:
        get_hf_file_metadata(hf_hub_url(REPO, 'config.json'), token=get_token())
    except Exception as error:
        code, message = diagnostic(error)
        emit({'ok': False, 'code': code, 'message': message})
        sys.exit(1)
    api = HfApi()
    info = api.repo_info(REPO, files_metadata=True)
    # Pin all files to the same snapshot and fail before costly weights if the
    # installed runtime cannot interpret the model's official architecture.
    revision = info.sha
    config_path = Path(hf_hub_download(REPO, 'config.json', revision=revision))
    check_compatibility(config_path.parent)
    files = [item for item in (info.siblings or []) if item.rfilename and not item.rfilename.endswith('/')]
    total = sum(item.size or 0 for item in files) or 1
    done = 0
    for item in files:
        emit({'stage': 'Downloading ' + item.rfilename, 'progress': min(0.99, done / total), 'bytes': done, 'total': total})
        hf_hub_download(REPO, item.rfilename, revision=revision)
        done += item.size or 0
        emit({'stage': 'Downloaded ' + item.rfilename, 'progress': min(1, done / total), 'bytes': done, 'total': total})
    directory = model_dir()
    if not (directory / 'config.json').exists():
        raise FileNotFoundError('config.json missing after download')
    weights = list(directory.glob('*.safetensors')) + list(directory.glob('**/*.safetensors'))
    if not weights:
        raise FileNotFoundError('No safetensors checkpoint found')
    tokens = tokenizer_tokens(directory)
    (ROOT / 'downloaded.json').write_text(json.dumps({
        'source': REPO, 'downloadedAt': time.time(), 'bytes': done, 'architecture': inspect_architecture(directory), 'supportedTokens': tokens,
    }))
    emit({'ok': True, 'stage': 'Official Higgs TTS 3 files downloaded; use Preview Voice to verify speech', 'progress': 1, 'supportedTokens': tokens})


def verify():
    from safetensors import safe_open
    (ROOT / 'verified.json').unlink(missing_ok=True)
    directory = model_dir()
    architecture = inspect_architecture(directory)
    index = directory / 'model.safetensors.index.json'
    weights = set(json.loads(index.read_text()).get('weight_map', {}).values()) if index.exists() else {'model.safetensors'}
    if not weights or any(not (directory / name).is_file() or (directory / name).stat().st_size == 0 for name in weights):
        raise FileNotFoundError('Required checkpoint weight files are missing or empty')
    for name in weights:
        path = (directory / name).resolve()
        # HF snapshot files legitimately resolve to cache blobs. Inspect their
        # tensor headers without allocating the full checkpoint in memory.
        with safe_open(str(path), framework='np') as checkpoint:
            if not list(checkpoint.keys()):
                raise ValueError('Checkpoint contains no tensors')
    tokens = tokenizer_tokens(directory)
    (ROOT / 'verified.json').write_text(json.dumps({
        'source': REPO, 'verifiedAt': time.time(), 'architecture': architecture, 'supportedTokens': tokens, 'inferenceVerified': False,
    }))
    emit({
        'ok': True,
        'stage': 'Checkpoint files verified; speech is confirmed only after Preview Voice succeeds',
        'architecture': architecture.get('modelType') or str(architecture.get('architectures')),
        'supportedTokens': tokens,
        'streaming': False,
        'sampleRate': architecture.get('sampleRate'),
    })


def _move(obj, device, dtype):
    if hasattr(obj, 'to'):
        try:
            return obj.to(device=device, dtype=dtype)
        except TypeError:
            return obj.to(device)
    return obj


def load(device):
    global MODEL, PROCESSOR, DEVICE, DTYPE, ARCHITECTURE, SUPPORTED, SAMPLE_RATE, STREAMING
    if MODEL is not None and DEVICE == device:
        return 0
    import torch
    from transformers import AutoConfig, AutoModel, AutoProcessor
    if device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS unavailable')
    if device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA device unsupported')
    directory = model_dir()
    architecture = inspect_architecture(directory)
    check_compatibility(directory)
    ARCHITECTURE = architecture.get('modelType') or ','.join(architecture.get('architectures') or [])
    SAMPLE_RATE = int(architecture.get('sampleRate') or SAMPLE_RATE)
    SUPPORTED = tokenizer_tokens(directory)
    dtype = torch.float16 if device != 'cpu' else torch.float32
    start = time.perf_counter()
    AutoConfig.from_pretrained(str(directory), trust_remote_code=True, local_files_only=True)
    try:
        PROCESSOR = AutoProcessor.from_pretrained(str(directory), trust_remote_code=True, local_files_only=True)
    except Exception:
        PROCESSOR = None
    MODEL = AutoModel.from_pretrained(str(directory), trust_remote_code=True, local_files_only=True, torch_dtype=dtype)
    MODEL = _move(MODEL, device, dtype)
    MODEL.eval()
    STREAMING = any(hasattr(MODEL, name) for name in ('generate_stream', 'stream_generate')) or (PROCESSOR and any(hasattr(PROCESSOR, name) for name in ('stream_generate',)))
    DEVICE = device
    DTYPE = dtype
    return (time.perf_counter() - start) * 1000


def _as_wav(audio, rate):
    import numpy as np
    import soundfile as sf
    array = audio
    if hasattr(array, 'detach'):
        array = array.detach().float().cpu().numpy()
    array = np.asarray(array, dtype=np.float32)
    if array.ndim > 1:
        array = array.squeeze()
        if array.ndim > 1:
            array = array.mean(axis=0 if array.shape[0] < array.shape[-1] else -1)
    if not array.size or not np.isfinite(array).all() or not np.any(array):
        raise ValueError('could not produce audio from official Higgs output')
    peak = max(float(np.max(np.abs(array))), 1e-6)
    if peak > 1:
        array = array / peak
    output = io.BytesIO()
    sf.write(output, array, int(rate), format='WAV', subtype='PCM_16')
    return output.getvalue(), array.size / float(rate)


def _load_reference(ref_id):
    import numpy as np
    import soundfile as sf
    ref_id = str(uuid.UUID(ref_id))
    folder = ROOT / 'references'
    path = (folder / (ref_id + '.wav')).resolve()
    if path.parent != folder.resolve() or not path.exists():
        raise ValueError('Invalid reference')
    meta = json.loads((folder / (ref_id + '.json')).read_text())
    audio, rate = sf.read(str(path), always_2d=False)
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    seconds = len(audio) / float(rate)
    if not 1 <= seconds <= 20 or not np.isfinite(audio).all() or not np.any(audio):
        raise ValueError('Reference audio must be a valid, non-silent WAV lasting 1–20 seconds, with its matching transcript.')
    return audio, rate, meta['transcript']


def _looks_like_audio(value):
    try:
        array = value.detach().float().cpu().numpy() if hasattr(value, 'detach') else __import__('numpy').asarray(value)
    except Exception:
        return False
    if array is None:
        return False
    array = array.squeeze()
    if array.ndim > 1:
        array = array.reshape(-1)
    if array.size < 1000:
        return False
    if getattr(array, 'dtype', None) is not None and array.dtype.kind in 'iu' and array.size < 16000:
        return False
    return True


def _first_audio(value):
    if value is None:
        return None
    if isinstance(value, dict):
        for key in ('audio', 'audio_values', 'waveform', 'wav', 'speech'):
            if value.get(key) is not None and _looks_like_audio(value[key]):
                return value[key]
        return None
    if hasattr(value, 'audio') and _looks_like_audio(value.audio):
        return value.audio
    if hasattr(value, 'waveform') and _looks_like_audio(value.waveform):
        return value.waveform
    if _looks_like_audio(value):
        return value
    if isinstance(value, (list, tuple)) and value:
        return _first_audio(value[0])
    return None


def _try_call(fn, kwargs):
    if fn is None:
        return None
    signature = None
    try:
        signature = inspect.signature(fn)
        accepted = {key: value for key, value in kwargs.items() if key in signature.parameters or any(param.kind == inspect.Parameter.VAR_KEYWORD for param in signature.parameters.values())}
        if not accepted and 'text' in kwargs:
            accepted = {'text': kwargs['text']}
    except (TypeError, ValueError):
        accepted = {key: kwargs[key] for key in ('text',) if key in kwargs}
    try:
        return fn(**accepted)
    except TypeError:
        try:
            return fn(kwargs.get('text'))
        except Exception:
            return None
    except Exception:
        raise


def _audio_rate(result):
    if isinstance(result, dict) and result.get('sampling_rate'):
        return result['sampling_rate']
    if PROCESSOR is not None and hasattr(PROCESSOR, 'sampling_rate'):
        return PROCESSOR.sampling_rate
    if hasattr(MODEL, 'sampling_rate'):
        return MODEL.sampling_rate
    return SAMPLE_RATE


def generate_audio(text, language, reference):
    import torch
    kwargs = {'text': text, 'language': language}
    if reference:
        audio, rate, transcript = reference
        kwargs.update({
            'ref_audio': audio, 'reference_audio': audio, 'audio_prompt': audio, 'prompt_speech': audio,
            'sampling_rate': rate, 'ref_sr': rate, 'prompt_text': transcript, 'ref_text': transcript,
            'transcript': transcript,
        })
    calls = []
    if PROCESSOR is not None:
        for name in ('generate_speech', 'generate'):
            if hasattr(PROCESSOR, name):
                calls.append(('processor.' + name, getattr(PROCESSOR, name), kwargs))
        processed = _try_call(getattr(PROCESSOR, '__call__', None), {**kwargs, 'return_tensors': 'pt'})
        if isinstance(processed, dict):
            tensors = {key: (value.to(DEVICE) if hasattr(value, 'to') else value) for key, value in processed.items()}
            for name in ('generate_speech', 'generate'):
                if hasattr(MODEL, name):
                    calls.append(('model.' + name + '(processor)', getattr(MODEL, name), tensors))
    for name in ('generate_speech', 'synthesize', 'generate'):
        if hasattr(MODEL, name):
            calls.append(('model.' + name, getattr(MODEL, name), kwargs))
    last_error = None
    for label, fn, payload in calls:
        try:
            with torch.inference_mode():
                result = fn(**payload) if label.endswith('(processor)') else _try_call(fn, payload)
            audio = _first_audio(result)
            if audio is not None:
                return _as_wav(audio, _audio_rate(result))
        except Exception as error:
            last_error = error
            if 'out of memory' in str(error).lower():
                raise
            continue
    methods = [label for label, _fn, _payload in calls]
    raise RuntimeError(
        'no official generate method produced audio from bosonai/higgs-tts-3-4b '
        f'(architecture {ARCHITECTURE or "unknown"}; methods {methods or ["none"]}). '
        + (str(last_error) if last_error else 'Could not produce audio.')
        + ' SGLang-Omni was not used, and no substitute model was loaded.'
    )


def synthesize(request):
    text = request['text']
    if not isinstance(text, str) or not 1 <= len(text) <= 4000:
        raise ValueError('Speech text length')
    validate_controls(text)
    device = request['device']
    if device not in ('cpu', 'mps', 'cuda'):
        raise ValueError('Invalid device')
    start = time.perf_counter()
    load_ms = load(device)
    reference = _load_reference(request['referenceId']) if request.get('referenceId') else None
    generation_start = time.perf_counter()
    wav, seconds = generate_audio(text, request.get('language') or 'en', reference)
    end = time.perf_counter()
    first_audio = (end - generation_start) * 1000
    return {'wav': base64.b64encode(wav).decode(), 'metrics': {
        'loadMs': load_ms, 'generationMs': first_audio, 'totalMs': (end - start) * 1000,
        'firstAudioMs': first_audio, 'audioSeconds': seconds,
        'peakProcessBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
        'device': device, 'streaming': False, 'architecture': ARCHITECTURE,
        'supportedTokens': SUPPORTED,
    }}


def reference_duration(path):
    import numpy as np
    import soundfile as sf
    audio, rate = sf.read(str(path), always_2d=False)
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    seconds = len(audio) / float(rate)
    if not 1 <= seconds <= 20 or not np.isfinite(audio).all() or not np.any(audio):
        raise ValueError('Reference audio must be a valid, non-silent WAV lasting 1–20 seconds, with its matching transcript.')
    return seconds


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'worker'
    if mode == 'setup-check':
        setup_check()
        return
    if mode == 'reference':
        with contextlib.redirect_stdout(sys.stderr):
            seconds = reference_duration(Path(sys.argv[2]))
        emit({'ok': True, 'seconds': seconds})
        return
    if mode == 'download':
        download()
        return
    if mode == 'inspect':
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            import transformers
        ROOT.mkdir(parents=True, exist_ok=True)
        runtime = {
            'torch': torch.__version__, 'transformers': transformers.__version__, 'source': REPO, 'sglang': False,
        }
        (ROOT / 'runtime-ready.json').write_text(json.dumps(runtime))
        mps = bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available())
        from huggingface_hub import hf_hub_download
        config_path = Path(hf_hub_download(REPO, 'config.json'))
        try:
            check_compatibility(config_path.parent)
        except HiggsCompatibilityError as error:
            result = {'compatible': False, 'message': str(error), 'architecture': inspect_architecture(config_path.parent)['modelType']}
        else:
            result = {'compatible': True}
        result.update({'ok': True, 'mpsAvailable': mps, **runtime, 'streaming': False})
        (ROOT / 'compatibility.json').write_text(json.dumps(result))
        emit(result)
        return
    if mode == 'verify':
        verify()
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
