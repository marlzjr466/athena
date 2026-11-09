"""Offline regression tests. These do not claim model inference or playback."""
import contextlib
import importlib.util
import io
import json
import os
import struct
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


class HiggsWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='athena-higgs-test-')
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {'ATHENA_HIGGS_ROOT': self.temp.name, 'HF_HOME': '/authorized/hf-home'})
        self.env.start()
        self.addCleanup(self.env.stop)
        spec = importlib.util.spec_from_file_location('higgs_worker_test', Path(__file__).parents[1] / 'voice-service/higgs_tts.py')
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'config.json').write_text(json.dumps({'model_type': 'higgs_multimodal_qwen3', 'architectures': ['HiggsMultimodalQwen3ForConditionalGeneration']}))

    def test_catalog_and_unrecognized_controls(self):
        self.assertEqual(sum(map(len, self.worker.DOCUMENTED.values())), 43)
        for category, values in self.worker.DOCUMENTED.items():
            for value in values:
                self.worker.validate_controls(f'<|{category}:{value}|>Hello')
        for tag in ['<|style:conversational|>', '<|sfx:chuckle|>', '<|emotion:happy|>', '<|unknown:value|>']:
            with self.assertRaisesRegex(ValueError, 'Unsupported Higgs speech control'):
                self.worker.validate_controls(tag)

    def test_auth_location_and_no_device_fallback(self):
        self.assertEqual(os.environ['HF_HOME'], '/authorized/hf-home')
        self.assertEqual(os.environ['PYTORCH_ENABLE_MPS_FALLBACK'], '0')
        self.assertEqual(os.environ['HF_HUB_CACHE'], str(self.root / 'hub'))

    def test_tokenizer_cannot_whitelist_invented_tags(self):
        (self.root / 'tokenizer.json').write_text('{"extra":"<|style:conversational|>"}')
        self.assertNotIn('conversational', self.worker.tokenizer_tokens(self.root)['style'])

    def test_download_stops_after_pinned_config_before_weights(self):
        info = types.SimpleNamespace(sha='verified-revision', siblings=[types.SimpleNamespace(rfilename='model.safetensors', size=9300000000)])
        hub = types.SimpleNamespace(
            HfApi=lambda: types.SimpleNamespace(repo_info=lambda *a, **kw: info),
            hf_hub_download=unittest.mock.Mock(return_value=str(self.root / 'config.json')),
            hf_hub_url=lambda *a: 'https://huggingface.co/config.json',
            get_hf_file_metadata=lambda *a, **kw: None, get_token=lambda: None,
        )
        with patch.dict('sys.modules', {'huggingface_hub': hub}), patch.object(self.worker, 'check_compatibility', side_effect=self.worker.HiggsCompatibilityError('unsupported architecture')), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(self.worker.HiggsCompatibilityError, 'unsupported architecture'):
                self.worker.download()
        hub.hf_hub_download.assert_called_once_with(self.worker.REPO, 'config.json', revision='verified-revision')
        self.assertFalse((self.root / 'downloaded.json').exists())

    def test_verify_does_not_mark_missing_weights_valid(self):
        with patch.object(self.worker, 'model_dir', return_value=self.root):
            with self.assertRaisesRegex(FileNotFoundError, 'weight files'):
                self.worker.verify()
        self.assertFalse((self.root / 'verified.json').exists())

    def test_verify_response_reaches_stdout_protocol(self):
        # File verification and inference verification are deliberately separate.
        header = json.dumps({'weight': {'dtype': 'F32', 'shape': [1], 'data_offsets': [0, 4]}}).encode()
        header += b' ' * (-len(header) % 8)
        (self.root / 'model.safetensors').write_bytes(struct.pack('<Q', len(header)) + header + struct.pack('<f', 1.0))
        output = io.StringIO()
        with patch.object(self.worker, 'model_dir', return_value=self.root), patch('sys.argv', ['worker', 'verify']), contextlib.redirect_stdout(output):
            self.worker.main()
        self.assertTrue(json.loads(output.getvalue())['ok'])
        self.assertFalse(json.loads((self.root / 'verified.json').read_text())['inferenceVerified'])

    def test_verify_rejects_corrupt_checkpoint(self):
        (self.root / 'verified.json').write_text('{"inferenceVerified":false}')
        (self.root / 'model.safetensors').write_bytes(b'not-a-model')
        with patch.object(self.worker, 'model_dir', return_value=self.root):
            with self.assertRaises(Exception):
                self.worker.verify()
        self.assertFalse((self.root / 'verified.json').exists())

    def test_unknown_architecture_exposes_exact_cause(self):
        config = types.SimpleNamespace(from_pretrained=unittest.mock.Mock(side_effect=ValueError('Transformers does not recognize this architecture')))
        with patch.dict('sys.modules', {'transformers': types.SimpleNamespace(__version__='test', AutoConfig=config)}):
            with self.assertRaisesRegex(self.worker.HiggsCompatibilityError, 'does not recognize this architecture'):
                self.worker.check_compatibility(self.root)


if __name__ == '__main__':
    unittest.main()
