"""Unit checks only: mocked model output is never hardware/voice verification."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest


class ContextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='athena-csm-unit-')
        os.environ['ATHENA_CSM_ROOT'] = cls.directory.name
        os.environ['ATHENA_CSM_SOURCE'] = str(Path(__file__).resolve().parent.parent / 'vendor/sesame-csm-official')
        spec = importlib.util.spec_from_file_location('adapter', Path(__file__).with_name('official_csm.py'))
        cls.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.adapter)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_diagnostics_hide_credentials(self):
        code, message = self.adapter.diagnostic(RuntimeError('403 secret-token fake-private-url'))
        self.assertEqual(code, 'gated_access_required')
        self.assertNotIn('secret-token', message)
        self.assertEqual(self.adapter.diagnostic(RuntimeError('MPS float64'))[0], 'device_unsupported')

    def test_stable_reference_does_not_mix_previous_sessions(self):
        import torch
        from dataclasses import dataclass
        @dataclass
        class Segment:
            text: str
            speaker: int
            audio: object
        calls = []
        class MockModel:
            sample_rate = 24000
            def generate(self, **args):
                calls.append(args)
                # Test fixture waveform, explicitly NOT real CSM output.
                return torch.ones(24000) * .01
        original = sys.modules.get('generator')
        sys.modules['generator'] = types.SimpleNamespace(Segment=Segment)
        self.adapter.MODEL = MockModel(); self.adapter.DEVICE = 'cpu'
        try:
            def request(key, text='Hello.'):
                return self.adapter.synthesize({'text': text, 'device': 'cpu', 'speaker': 0, 'contextKey': key})
            request('a'); request('a', 'Again.')
            self.assertEqual(len(calls[-1]['context']), 0)
            self.assertEqual(calls[-1]['context'], [])
            self.assertEqual(calls[-1]['temperature'], self.adapter.ATHENA_TEMPERATURE)
            self.assertEqual(calls[-1]['topk'], self.adapter.ATHENA_TOPK)
            request('b'); self.assertEqual(calls[-1]['context'], [])
            request(None); self.assertEqual(calls[-1]['context'], [])
            count = len(calls); request('d', 'A complete thought. ' * 60)
            self.assertGreater(len(calls), count + 1)
            self.assertTrue(all(call['max_audio_length_ms'] == 30000 for call in calls))
        finally:
            if original is None: del sys.modules['generator']
            else: sys.modules['generator'] = original
            self.adapter.MODEL = None

    def test_reference_anchor_is_present_on_every_response_and_mismatched_speaker_fails(self):
        import numpy as np
        import soundfile as sf
        import torch
        from dataclasses import dataclass
        @dataclass
        class Segment:
            text: str
            speaker: int
            audio: object
        calls = []
        class MockModel:
            sample_rate = 24000
            def generate(self, **args):
                calls.append(args)
                return torch.ones(24000) * .01
        ref_id = '18c1b222-327f-4915-96aa-20558ed5c7a1'
        folder = Path(self.directory.name) / 'references'
        folder.mkdir(exist_ok=True)
        sf.write(folder / (ref_id + '.wav'), np.ones(24000, dtype='float32') * .01, 24000)
        (folder / (ref_id + '.json')).write_text(json.dumps({'transcript': 'This is the selected voice.', 'speaker': 0}))
        original = sys.modules.get('generator')
        sys.modules['generator'] = types.SimpleNamespace(Segment=Segment)
        self.adapter.MODEL = MockModel(); self.adapter.DEVICE = 'cpu'
        self.adapter.REFERENCE_CACHE.clear()
        try:
            request = {'device': 'cpu', 'speaker': 0, 'referenceId': ref_id, 'contextKey': 'session'}
            self.adapter.synthesize({**request, 'text': 'First.'})
            self.adapter.synthesize({**request, 'text': 'Second.'})
            self.assertEqual([call['context'][0].text for call in calls], ['This is the selected voice.'] * 2)
            self.assertEqual(len(calls[1]['context']), 1)
            with self.assertRaisesRegex(ValueError, 'speaker mismatch'):
                self.adapter.synthesize({**request, 'speaker': 1, 'text': 'Wrong identity.'})
        finally:
            if original is None: del sys.modules['generator']
            else: sys.modules['generator'] = original
            self.adapter.MODEL = None


if __name__ == '__main__':
    unittest.main()
