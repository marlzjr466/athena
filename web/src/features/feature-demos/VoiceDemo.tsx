'use client';
import { useEffect, useRef, useState } from 'react';
import { AudioLines, Play, Square, Volume2 } from 'lucide-react';
import { useExperience } from '@/features/scroll-experience/ExperienceProvider';
import { CustomSelect } from '@/components/ui/CustomSelect';
export function VoiceDemo() {
  const { play } = useExperience();
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState('“Hey Athena, let’s make today a little brighter.”');
  const [rate, setRate] = useState(1);
  const [voice, setVoice] = useState('');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [supported, setSupported] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    if ('speechSynthesis' in window) {
      setSupported(true);
      const update = () => setVoices(speechSynthesis.getVoices().filter(v => v.lang.startsWith('en')));
      update(); speechSynthesis.addEventListener('voiceschanged', update);
      return () => { speechSynthesis.removeEventListener('voiceschanged', update); speechSynthesis.cancel(); timers.current.forEach(clearTimeout); };
    }
    return () => timers.current.forEach(clearTimeout);
  }, []);
  const stop = () => { timers.current.forEach(clearTimeout); timers.current = []; if ('speechSynthesis' in window) speechSynthesis.cancel(); setActive(false); play('idle'); };
  function preview() {
    if (active) { stop(); return; }
    setActive(true); setMessage('Wake phrase recognized · simulated'); play('thinking');
    timers.current.push(setTimeout(() => { setMessage('“I’m here. What shall we create together?”'); play('gestures'); }, 900));
    timers.current.push(setTimeout(() => { setActive(false); play('idle'); }, 4200));
  }
  function speak() {
    stop();
    if (!supported) return;
    const utterance = new SpeechSynthesisUtterance('Hi, I’m Athena. Your ideas, your projects, your everyday. Let’s make something wonderful together.');
    utterance.rate = rate; utterance.voice = voices.find(v => v.voiceURI === voice) ?? null;
    utterance.onstart = () => { setActive(true); play('gestures'); setMessage('Playing a browser voice preview…'); };
    utterance.onend = () => { setActive(false); play('idle'); setMessage('A voice that feels a little more like you.'); };
    utterance.onerror = () => { setActive(false); play('idle'); setMessage('Voice playback is unavailable. Try the visual conversation demo.'); };
    speechSynthesis.speak(utterance);
  }
  return <div className="glass voice-demo" data-reveal><div className="panel-heading"><span><AudioLines size={15} /> A VOICE, NOT JUST A RESPONSE</span><span className="demo-label">PREVIEW</span></div><div className={`waveform ${active ? 'speaking' : ''}`} aria-hidden="true">{Array.from({ length: 45 }, (_, i) => <i key={i} style={{ height: `${Math.round(10 + Math.sin(i * 1.8) ** 2 * (1 - Math.abs(i - 22) / 25) * 70)}px`, animationDelay: `${(i * -.08).toFixed(2)}s` }} />)}</div><p className="voice-transcript" role="status">{message}</p><div className="voice-actions"><button className="button-primary" onClick={preview}>{active ? <Square size={14} /> : <Play size={14} />}{active ? 'Stop preview' : 'Try a conversation'}</button><button className="button-secondary" disabled={!supported} onClick={speak}><Volume2 size={15} /> Hear a voice</button></div><div className="select-row"><span>Browser voice</span><CustomSelect ariaLabel="Browser voice" value={voice} onChange={setVoice} disabled={!supported} options={[{ value: '', label: 'System default' }, ...voices.map(v => ({ value: v.voiceURI, label: v.name }))]} /></div><label className="range-label" htmlFor="voice-speed">Speaking pace <output>{rate.toFixed(1)}×</output></label><input id="voice-speed" type="range" min=".7" max="1.3" step=".1" value={rate} onChange={e => setRate(+e.target.value)} /><p className="tiny">Wake word and speech recognition are simulated. “Hear a voice” uses your browser’s speech synthesis, which may use its vendor’s online service. It is not Athena’s desktop voice. No microphone is activated.</p></div>;
}
