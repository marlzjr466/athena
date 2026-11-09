"""Opt-in real CSM anchor check. Generates audio; it never trains or downloads.

Example: <CSM venv>/bin/python voice-service/verify_stable_voice.py
  --installed-root ~/.athena/models/csm-official
  --reference voice-service/assets/athena-us-amy-reference.mp3
  --output artifacts/official-csm/stable-voice
"""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--installed-root', type=Path, required=True)
parser.add_argument('--reference', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--device', choices=['cpu', 'mps'], default='cpu')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parent.parent / 'vendor' / 'sesame-csm-official'
reference_id = 'b4b34c95-7b6f-4ea9-b2f8-17cc9d3b3cf4'
transcript = 'A rainbow is a meteorological phenomenon that is caused by reflection, refraction, and dispersion of light in water droplets resulting in a spectrum of light appearing in the sky.'

with tempfile.TemporaryDirectory(prefix='athena-csm-anchor-') as temp:
    root = Path(temp)
    (root / 'hub').symlink_to(args.installed_root.resolve() / 'hub', target_is_directory=True)
    folder = root / 'references'
    folder.mkdir()
    extension = '.mp3' if args.reference.suffix.lower() == '.mp3' else '.wav'
    shutil.copyfile(args.reference, folder / (reference_id + extension))
    (folder / (reference_id + '.json')).write_text(json.dumps({
        'id': reference_id, 'name': 'Athena synthetic voice',
        'transcript': transcript, 'speaker': 0, 'seconds': 10.4,
    }))
    os.environ['ATHENA_CSM_ROOT'] = str(root)
    os.environ['ATHENA_CSM_SOURCE'] = str(source)
    from official_csm import synthesize

    metrics = []
    for index, text in enumerate(("I'm listening.", 'I can help with that. Tell me what you need.')):
        result = synthesize({
            'text': text, 'device': args.device, 'speaker': 0,
            'referenceId': reference_id, 'contextKey': 'handsfree:test',
        })
        (args.output / f'anchored-{index + 1}.wav').write_bytes(base64.b64decode(result['wav']))
        metrics.append(result['metrics'])
        print(json.dumps({'sample': index + 1, 'metrics': result['metrics']}), flush=True)
    (args.output / 'metrics.json').write_text(json.dumps(metrics, indent=2))
