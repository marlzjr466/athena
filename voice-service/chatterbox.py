"""Private stdio worker for Athena's original Chatterbox US-English voice only."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import wave

ROOT = Path(os.environ['ATHENA_TTS_ROOT']).resolve()
os.environ['HF_HOME'] = str(ROOT / 'hub')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
MODEL = None


def synthesize(request):
    global MODEL
    import numpy as np
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
    text = request.get('text')
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError('Invalid speech text')
    reference = Path(request['reference']).resolve(strict=True)
    if not reference.is_relative_to((ROOT / 'profiles').resolve()):
        raise ValueError('Invalid reference path')
    if MODEL is None:
        mx.set_memory_limit(8 * 1024**3)
        mx.set_cache_limit(256 * 1024**2)
        MODEL = load_model(str(ROOT / 'chatterbox-turbo'))
    # Restore the original sampler and reference, not CSM prompting or pitch shifting.
    bias = {'calm': -.06, 'concerned': -.04, 'happy': .04, 'excited': .08}.get(request.get('style'), 0)
    temperature = min(1.0, max(.55, .62 + .28 * float(request.get('expressiveness', .65)) + bias))
    samples, sample_rate, count = [], None, 0
    # Consume every sentence result: stopping at next(generator) drops later sentences.
    for result in MODEL.generate(text=text, ref_audio=str(reference), stream=False, temperature=temperature):
        audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
        rate = int(result.sample_rate)
        if not audio.size or not np.isfinite(audio).all() or (sample_rate and sample_rate != rate):
            raise ValueError('Invalid generated audio')
        sample_rate = rate
        count += audio.size
        if count * 2 > 8 * 1024**2 - 44:
            raise ValueError('Audio limit exceeded')
        samples.append(audio)
    if not samples:
        raise ValueError('No generated audio')
    pcm = (np.clip(np.concatenate(samples), -1, 1) * 32767).astype('<i2').tobytes()
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return base64.b64encode(output.getvalue()).decode('ascii')


def main():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                wav = synthesize(request)
            result = {'id': request['id'], 'ok': True, 'wav': wav}
        except Exception as error:
            result = {'id': request.get('id'), 'ok': False, 'error': type(error).__name__}
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
