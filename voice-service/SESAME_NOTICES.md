# Sesame CSM local runtime notices

This integration runs CSM-1B speech generation through the official Sesame PyTorch implementation in its isolated runtime. It does not use Sesame's private services, include Maya's voice, or replace Athena's dialogue model.

Components and upstream terms (reviewed 2026-10-21):

- [Sesame CSM architecture](https://github.com/SesameAILabs/csm): Apache-2.0. The public checkpoint is not the conversational demo system.
- Official CSM inference uses the released `sesame/csm-1b` checkpoint and its documented PyTorch dependencies; no MLX conversion is bundled.
- [Kyutai Mimi tokenizer checkpoint](https://huggingface.co/kyutai/moshiko-pytorch-bf16): CC-BY-4.0. Attribution: Kyutai, Moshi/Mimi. Athena downloads only the audio-tokenizer checkpoint, not the full Moshi model.
- [Llama 3.2 tokenizer](https://huggingface.co/unsloth/Llama-3.2-1B): Llama 3.2 Community License and applicable acceptable-use terms. Athena downloads tokenizer/configuration files only, not the Llama inference weights.
- [senstella/csm-mlx](https://github.com/senstella/csm-mlx): Apache-2.0; evaluated but not bundled. Athena does not use that community conversion or install MLX for this voice engine.

Downloads require explicit installation confirmation. Do not redistribute model weights without retaining and complying with their respective upstream terms. Dependency wheels retain their own license files. No universal license is asserted for the complete dependency stack.

The automatic Sesame reference is the bundled `athena-us-amy-reference.mp3`, an authorized US-English sample from the existing Athena voice assets, with its matching transcript. It is not a recording of a real person's private speech or a Maya sample. Any custom audio must come from an adult speaker whose permission the user has. Reference audio conditions generation; it does not train weights. Each new response is anchored to the selected reference; only chunks within that response are used as context, preventing old floating turns from changing the speaker. Voice identity, perceived age, accent, expressiveness, and laughter are not guaranteed by the released base model.

No user speech, transcripts, examples, or feedback are uploaded by the inference worker. Downloading dependencies/models is separate from inference. Saved generated audio is local and can be deleted through the voice studio.
