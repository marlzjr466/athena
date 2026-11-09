"""Explicit live verification. No substitute audio or automatic model downloads.

Run after gated access/download succeeds with the isolated runtime, e.g.
python verify_official_csm.py --device mps --output artifacts/csm-mps
Then explicitly run --device cpu if MPS fails. Saves two actual generated WAVs.
"""
import argparse
import base64
import contextlib
import json
from pathlib import Path
import sys
import time
from official_csm import synthesize, diagnostic

parser = argparse.ArgumentParser()
parser.add_argument('--device', choices=['cpu', 'mps', 'cuda'], required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
start = time.perf_counter()
results = []
try:
    for index, text in enumerate(['Hello from Athena. It is good to hear from you.', 'That made me smile. What would you like to do next?']):
        with contextlib.redirect_stdout(sys.stderr):
            result = synthesize({'text': text, 'speaker': 0, 'device': args.device, 'contextKey': 'explicit-live-verification'})
        (args.output / f'official-{index + 1}.wav').write_bytes(base64.b64decode(result['wav']))
        results.append(result['metrics'])
        print(json.dumps({'actualGeneration': index + 1, 'metrics': result['metrics']}), flush=True)
    report = {'ok': True, 'device': args.device, 'results': results, 'wallSeconds': time.perf_counter() - start,
              'subjectiveQualityVerified': False, 'microphoneLipSyncVerified': False}
except Exception as error:
    code, message = diagnostic(error)
    report = {'ok': False, 'device': args.device, 'errorCode': code, 'message': message, 'completedResults': results}
(args.output / 'report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report), flush=True)
sys.exit(0 if report['ok'] else 1)
