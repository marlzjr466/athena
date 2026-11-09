/** Offline, single-request worker. Process termination is cancellation and releases Metal memory. */
export const mlxWorker = String.raw`
import sys, json, traceback, re

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)
try:
    request = json.loads(sys.stdin.read())
    import mlx.core as mx
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler
    from mlx_lm.tuner.utils import load_adapters
    from mlx.utils import tree_flatten
    model, tokenizer = load(request['checkpointPath'], trust_remote_code=False)
    if model.args.model_type != 'qwen2': raise ValueError('Native adapter inference currently verifies qwen2 checkpoints only.')
    if not tokenizer.chat_template: raise ValueError('Source tokenizer has no chat template.')
    vocab = tokenizer.get_vocab()
    if max(vocab.values()) >= model.args.vocab_size: raise ValueError('Tokenizer token IDs exceed the source model vocabulary.')
    def prompt_tokens(messages, tools=None):
        kwargs = {'tokenize':True, 'add_generation_prompt':True}
        if tools: kwargs['tools'] = tools
        tokens = tokenizer.apply_chat_template(messages, **kwargs)
        if len(tokens) + request.get('maxTokens', 256) > request.get('contextLength', 32768): raise ValueError('MLX context limit exceeded. Reduce conversation history or output length.')
        return tokens
    def tool_calls(text, tools):
        def unique_object(pairs):
            value = {}
            for key, item in pairs:
                if key in value: raise ValueError('Duplicate key in MLX tool request.')
                value[key] = item
            return value
        tagged = '<tool_call>' in text or '</tool_call>' in text
        if tagged and not re.fullmatch(r'\s*(?:<tool_call>.*?</tool_call>\s*)+', text, re.S):
            raise ValueError('Mixed or incomplete MLX tool output; no tool executed.')
        blocks = re.findall(r'<tool_call>\s*(.*?)\s*</tool_call>', text, re.S)
        if not blocks:
            candidate = text.strip()
            fence = re.fullmatch(chr(96)*3 + r'(?:json)?\s*\n(.*?)\n' + chr(96)*3, candidate, re.S)
            if fence: candidate = fence.group(1).strip()
            if candidate.startswith('{'):
                try:
                    value = json.loads(candidate)
                    if isinstance(value, dict) and 'name' in value and 'arguments' in value: blocks = [candidate]
                except ValueError: pass
        parsed = []
        names = {t['function']['name'] for t in tools}
        for raw in blocks:
            call = json.loads(raw, object_pairs_hook=unique_object)
            if set(call) != {'name','arguments'} or call['name'] not in names or not isinstance(call['arguments'],dict): raise ValueError('Unsupported or malformed MLX tool call; no tool executed.')
            parsed.append(call)
        if len(parsed) > 20: raise ValueError('Too many MLX tool calls in one response.')
        return parsed
    def generate(messages, tools=None, streaming=False, prefix=''):
        tokens = prompt_tokens(messages, tools)
        if prefix: tokens += tokenizer.encode(prefix, add_special_tokens=False)
        if len(tokens) + request.get('maxTokens', 256) > request.get('contextLength', 32768): raise ValueError('MLX structured request exceeds context limit.')
        chunks = []
        last = None
        for chunk in stream_generate(model, tokenizer, tokens, max_tokens=request.get('maxTokens', 256), sampler=make_sampler(temp=request.get('temperature', 0))):
            chunks.append(chunk.text); last = chunk
            if streaming: emit({'message':{'content':chunk.text}})
        text = prefix + ''.join(chunks)
        if not text.strip(): raise ValueError('MLX generated an empty response.')
        return text, last
    if request.get('verify'):
        messages = [{'role':'user', 'content':'Write a Python function add(a, b) that returns their sum. Reply with code only.'}]
        tokens = prompt_tokens(messages)
        before = model(mx.array([tokens]))[0,-1,:].astype(mx.float32)
        mx.eval(before)
        base, _ = generate(messages)
    if request.get('adapterPath'):
        load_adapters(model, request['adapterPath'])
        stored = mx.load(request['adapterPath'] + '/adapters.safetensors')
        params = dict(tree_flatten(model.parameters()))
        expected = {k for k in params if k.rsplit('.',1)[-1] in {'lora_a','lora_b'}}
        if set(stored) != expected: raise ValueError('Adapter tensor set does not exactly match the configured LoRA layers.')
        if not any(bool(mx.any(v != 0).item()) for k,v in stored.items() if k.endswith('lora_b')): raise ValueError('Adapter has no nonzero learned LoRA B tensors.')
        for k,v in stored.items():
            if not bool(mx.all(params[k] == v).item()): raise ValueError('Loaded adapter tensor mismatch: '+k)
    if request.get('verify'):
        after = model(mx.array([tokens]))[0,-1,:].astype(mx.float32)
        difference = float(mx.max(mx.abs(after-before)).item())
        if not difference > 0: raise ValueError('Adapter did not change model logits.')
        adapted, last = generate(messages)
        tool = {'type':'function','function':{'name':'athena_probe','description':'Return a harmless test value.','parameters':{'type':'object','properties':{'value':{'type':'string'}},'required':['value']}}}
        tool_response, _ = generate([{'role':'user','content':'Call athena_probe with value "ok". Do not answer in prose.'}], [tool])
        tools_verified = False
        try:
            calls = tool_calls(tool_response, [tool])
            tools_verified = calls == [{'name':'athena_probe','arguments':{'value':'ok'}}]
        except Exception: pass
        emit({'verification':{'baseResponse':base,'adapterResponse':adapted,'adapterTensorCount':len(stored),'logitDifference':difference,'toolsVerified':tools_verified,'toolProbeResponse':tool_response}, 'memoryGB':mx.get_peak_memory()/1024**3, 'done':True})
    else:
        emit({'loaded':True})
        messages = request['messages']
        for message in messages:
            if message.get('images'): raise ValueError('This MLX model does not support image input.')
        # The native Qwen template uses name on tool replies.
        messages = [{**m, **({'name':m['tool_name']} if 'tool_name' in m else {})} for m in messages]
        tools = request.get('tools')
        if tools:
            # A structured adapter, not inferred execution from prose. The model
            # chooses the name/arguments; only validated calls reach the host.
            finish = {'type':'function','function':{'name':'athena_finish','description':'Finish or request missing information. Summarize only actual results.','parameters':{'type':'object','properties':{'message':{'type':'string'}},'required':['message'],'additionalProperties':False}}}
            tools = tools + [finish]
            messages = messages + [{'role':'user','content':'Choose the next tool action. Complete exactly one JSON object with name and arguments. Do not use Markdown or tool tags. If finished or blocked, choose athena_finish with a message explaining actual results or what is missing. Format example only (not an executed action): {"name":"read_file","arguments":{"path":"README.md","start_line":1,"end_line":40}}.'}]
        text, last = generate(messages, tools, streaming=not bool(tools), prefix='{"name":' if tools else '')
        calls = tool_calls(text, tools) if tools else []
        if tools and not calls: raise ValueError('MLX returned malformed structured output; no tool from this response was executed.')
        if calls and any(call['name'] == 'athena_finish' for call in calls):
            if len(calls) != 1 or set(calls[0]['arguments']) != {'message'} or not isinstance(calls[0]['arguments']['message'], str): raise ValueError('Invalid MLX finish response.')
            emit({'message':{'content':calls[0]['arguments']['message']}})
        elif calls:
            emit({'message':{'content':'','tool_calls':[{'function':call} for call in calls]}})
        elif tools: emit({'message':{'content':text}})
        emit({'done':True,'done_reason':'length' if last.finish_reason == 'length' else 'stop','prompt_eval_count':last.prompt_tokens,'eval_count':last.generation_tokens,'memoryGB':mx.get_peak_memory()/1024**3})
except Exception as error:
    emit({'error':str(error), 'errorType':type(error).__name__})
    sys.exit(1)
`
