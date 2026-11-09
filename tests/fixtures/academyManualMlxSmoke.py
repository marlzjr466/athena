"""Opt-in local MLX smoke test. Uses a disposable tiny random model; no downloads."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace

import mlx.core as mx
from mlx.utils import tree_flatten
from mlx_lm.models.qwen2 import Model, ModelArgs
from mlx_lm.tuner.datasets import load_local_dataset, ChatDataset
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace
from transformers import PreTrainedTokenizerFast

with tempfile.TemporaryDirectory(prefix='athena-manual-mlx-') as temporary:
    root = Path(temporary)
    checkpoint = root / 'checkpoint'
    checkpoint.mkdir()
    config = dict(model_type='qwen2', hidden_size=16, num_hidden_layers=8,
                  intermediate_size=32, num_attention_heads=2, num_key_value_heads=2,
                  rms_norm_eps=1e-6, vocab_size=128, max_position_embeddings=1024,
                  tie_word_embeddings=True)
    model = Model(ModelArgs(**config))
    mx.save_safetensors(str(checkpoint / 'model.safetensors'), dict(tree_flatten(model.parameters())))
    (checkpoint / 'config.json').write_text(json.dumps(config))
    vocabulary = {'[UNK]': 0, '[EOS]': 1, 'user': 2, 'assistant': 3,
                  'training': 4, 'validation': 5, 'testing': 6, 'question': 7, 'answer': 8}
    vocabulary.update({str(i): i + 9 for i in range(60)})
    backend = Tokenizer(WordLevel(vocabulary, unk_token='[UNK]'))
    backend.pre_tokenizer = Whitespace()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, unk_token='[UNK]', eos_token='[EOS]')
    tokenizer.chat_template = "{% for m in messages %}{{ m['role'] + ' ' + m['content'] + ' ' }}{% endfor %}{{ eos_token }}"
    tokenizer.save_pretrained(checkpoint)
    training = root / 'training'
    final = root / 'final'
    training.mkdir(); final.mkdir()
    for split, count, prefix, folder in [('train', 52, 'training', training), ('valid', 6, 'validation', training), ('test', 7, 'testing', final)]:
        rows = [{'messages': [{'role': 'user', 'content': f'{prefix} question {i}'}, {'role': 'assistant', 'content': f'{prefix} answer {i}'}]} for i in range(count)]
        (folder / f'{split}.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
    train, valid, absent_test = load_local_dataset(training, tokenizer, SimpleNamespace(mask_prompt=False))
    absent_train, absent_valid, test = load_local_dataset(final, tokenizer, SimpleNamespace(mask_prompt=False))
    assert (len(train), len(valid), len(test)) == (52, 6, 7)
    assert not absent_test and not absent_train and not absent_valid
    for dataset, prefix in [(train, 'training'), (valid, 'validation'), (test, 'testing')]:
        assert isinstance(dataset, ChatDataset)
        assert all(row['messages'][0]['content'].startswith(prefix) for row in dataset)
        assert len(dataset.process(dataset[0])[0]) > 0
    adapter = root / 'adapter'
    command = [sys.executable, '-m', 'mlx_lm', 'lora', '--model', str(checkpoint), '--batch-size', '1', '--max-seq-length', '1024']
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1'}
    trained = subprocess.run(command + ['--train', '--data', str(training), '--iters', '10', '--num-layers', '8', '--val-batches', '-1', '--steps-per-eval', '5', '--steps-per-report', '5', '--save-every', '5', '--adapter-path', str(adapter)], env=env, capture_output=True, text=True, timeout=120)
    if trained.returncode:
        raise RuntimeError(trained.stdout + trained.stderr)
    training_log = re.sub(r'\x1b\[[0-9;]*m', '', trained.stdout)
    assert re.search(r'(?:Val loss|\d+\s+val)\s+[0-9.]+', training_log), training_log
    weights = mx.load(str(adapter / 'adapters.safetensors'))
    assert any(bool(mx.any(value != 0).item()) for name, value in weights.items() if 'lora_b' in name), 'No adapter gradient updates'
    evaluated = subprocess.run(command + ['--test', '--data', str(final), '--test-batches', '-1', '--adapter-path', str(adapter)], env=env, capture_output=True, text=True, timeout=120)
    if evaluated.returncode:
        raise RuntimeError(evaluated.stdout + evaluated.stderr)
    assert 'Test loss' in evaluated.stdout
    print(json.dumps({'runtime': 'installed mlx-lm', 'counts': [len(train), len(valid), len(test)], 'adapter_weights_updated': True, 'validation_measured': True, 'independent_test_measured': True, 'temporary_files_removed_on_exit': True}))
