import { describe, expect, it } from 'vitest'
import { AdaptiveNoiseFloor, chooseClarification, chooseWakeAcknowledgement, classifyHandsFreeTranscript, encodeHandsFreeWav, extractWakePhrase, handsFreeMicrophoneConstraints, isUsableSpeechSegment, isValidHandsFreeWav, isVoiceInterruption, negativeSpeechConfidenceThreshold, normalizeVoiceCommand, shouldFallbackFromAudioWorklet, silenceEndpointMs, speechConfidenceThreshold, voiceInteractionDefaults, WAKE_ACKNOWLEDGEMENTS } from '../shared/handsFree'

describe('hands-free wake phrase and endpointing', () => {
  it.each([
    ['Athena', ''],
    ['Hey Athena, open Chrome.', 'open Chrome.'],
    ['Hi Athena what time is it?', 'what time is it?'],
    ['Hey there, Athena, explain React.', 'explain React.'],
    ['Hello Athena, open my project.', 'open my project.'],
    ['Okay Athena: stop.', 'stop.'],
  ])('recognizes a leading wake phrase in %s', (utterance, command) => {
    expect(extractWakePhrase(utterance)).toEqual({ activated: true, command })
  })

  it('does not activate for a phrase mentioned later in an utterance', () => {
    expect(extractWakePhrase('I was talking about Athena earlier.')).toEqual({ activated: false, command: 'I was talking about Athena earlier.' })
  })

  it('routes ordinary speech to the AI only during the enabled follow-up window', () => {
    expect(classifyHandsFreeTranscript('What is React?', voiceInteractionDefaults.wakePhrases, true, true)).toEqual({ kind: 'command', text: 'What is React?', includedWakePhrase: false })
    expect(classifyHandsFreeTranscript('What is React?', voiceInteractionDefaults.wakePhrases, false, true)).toEqual({ kind: 'ignore' })
    expect(classifyHandsFreeTranscript('What is React?', voiceInteractionDefaults.wakePhrases, true, false)).toEqual({ kind: 'ignore' })
  })

  it('routes a wake phrase followed by a request immediately, and distinguishes a wake-only greeting', () => {
    expect(classifyHandsFreeTranscript('Hey Athena, explain React.', voiceInteractionDefaults.wakePhrases, false, true)).toEqual({ kind: 'command', text: 'explain React.', includedWakePhrase: true })
    expect(classifyHandsFreeTranscript('Athena', voiceInteractionDefaults.wakePhrases, false, true)).toEqual({ kind: 'wake-only' })
  })

  it('varies wake acknowledgements and avoids repeating the immediately previous one', () => {
    const first = chooseWakeAcknowledgement(undefined, () => 0)
    const second = chooseWakeAcknowledgement(first, () => 0)
    expect(WAKE_ACKNOWLEDGEMENTS).toContain(first)
    expect(WAKE_ACKNOWLEDGEMENTS).toContain(second)
    expect(second).not.toBe(first)
  })

  it('normalizes punctuation and recognizes stop, cancel, and standby separately', () => {
    expect(normalizeVoiceCommand('  Open   Chrome.  ')).toBe('Open Chrome')
    expect(isVoiceInterruption('Athena, stop talking.')).toBe('stop-speech')
    expect(isVoiceInterruption('Athena, wait.')).toBe('stop-speech')
    expect(isVoiceInterruption('Hold on, Athena.')).toBe('stop-speech')
    expect(isVoiceInterruption('Hey Athena, cancel the current task!')).toBe('cancel-task')
    expect(isVoiceInterruption('Athena, stop listening.')).toBe('standby')
  })

  it('uses short endpointing for brief commands and allows more room for long speech', () => {
    expect(silenceEndpointMs(600, 1200)).toBe(600)
    expect(silenceEndpointMs(600, 4000)).toBe(720)
    expect(silenceEndpointMs(600, 8000)).toBe(850)
    expect(silenceEndpointMs(1500, 8000)).toBe(1500)
  })

  it('defaults to explicit opt-in and a conversational 15-second follow-up', () => {
    expect(voiceInteractionDefaults.handsFreeEnabled).toBe(false)
    expect(voiceInteractionDefaults.followUpEnabled).toBe(true)
    expect(voiceInteractionDefaults.followUpTimeoutSeconds).toBe(15)
    expect(voiceInteractionDefaults.endOfSpeechDelayMs).toBeGreaterThanOrEqual(400)
    expect(voiceInteractionDefaults.endOfSpeechDelayMs).toBeLessThanOrEqual(700)
    expect(voiceInteractionDefaults.aiResponseTimeoutSeconds).toBe(120)
    expect(voiceInteractionDefaults.noiseSuppression).toBe(true)
    expect(voiceInteractionDefaults.noiseSuppressionLevel).toBe('balanced')
    expect(voiceInteractionDefaults.automaticNoiseCalibration).toBe(true)
  })

  it('always requests local noise suppression while only requesting voice isolation at High', () => {
    expect(handsFreeMicrophoneConstraints('low', false).audio.noiseSuppression).toEqual({ ideal: true })
    expect(handsFreeMicrophoneConstraints('balanced', false).audio.noiseSuppression).toEqual({ ideal: true })
    expect(handsFreeMicrophoneConstraints('high', false).audio.noiseSuppression).toEqual({ ideal: true })
    expect(handsFreeMicrophoneConstraints('high', true).audio.voiceIsolation).toEqual({ ideal: true })
    expect(handsFreeMicrophoneConstraints('balanced', true).audio.voiceIsolation).toBeUndefined()
  })

  it('falls back to ScriptProcessor only for worklet initialization errors', () => {
    expect(shouldFallbackFromAudioWorklet(new Error('AudioWorklet.addModule failed'))).toBe(true)
    expect(shouldFallbackFromAudioWorklet(new Error('Failed to load worklet module'))).toBe(true)
    expect(shouldFallbackFromAudioWorklet(new DOMException('Permission denied', 'NotAllowedError'))).toBe(false)
    expect(shouldFallbackFromAudioWorklet(new Error('No microphone input'))).toBe(false)
  })

  it('adapts its in-memory floor only from non-speech and raises confidence in noisier rooms', () => {
    const floor = new AdaptiveNoiseFloor()
    const start = floor.current()
    for (let index = 0; index < 100; index++) floor.observe(0.03, 0.02, true)
    expect(floor.current()).toBeGreaterThan(start)
    const learned = floor.current()
    for (let index = 0; index < 100; index++) floor.observe(0.0005, 0.8, true)
    expect(floor.current()).toBe(learned)
    expect(speechConfidenceThreshold('balanced', learned)).toBeGreaterThan(speechConfidenceThreshold('balanced', 0.003))
    expect(speechConfidenceThreshold('high')).toBeLessThan(speechConfidenceThreshold('low'))
    expect(speechConfidenceThreshold('balanced', learned) - negativeSpeechConfidenceThreshold('balanced', learned)).toBeLessThanOrEqual(0.05)
    expect(negativeSpeechConfidenceThreshold('balanced')).toBe(0.38)
  })

  it('rejects empty/noise-like segments and encodes accepted Silero audio as validated 16 kHz PCM WAV', () => {
    const silence = new Float32Array(16_000).fill(0.00001)
    expect(isUsableSpeechSegment(silence)).toBe(false)
    const speech = new Float32Array(16_000).map((_, index) => Math.sin(index * 0.08) * 0.035)
    expect(isUsableSpeechSegment(speech)).toBe(true)
    const wav = encodeHandsFreeWav(speech)
    expect(isValidHandsFreeWav(wav)).toBe(true)
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000)
    wav[24] = 0
    expect(isValidHandsFreeWav(wav)).toBe(false)
    expect(isUsableSpeechSegment(new Float32Array(100))).toBe(false)
  })

  it('varies clarification phrases without repeating the prior response', () => {
    const first = chooseClarification(undefined, () => 0)
    const second = chooseClarification(first, () => 0)
    expect(second).not.toBe(first)
  })
})
