'use client';
import { useState } from 'react';
import { MoveHorizontal, Play, Sparkles } from 'lucide-react';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { animations } from './catalog';
import { defaults, useExperience } from '@/features/scroll-experience/ExperienceProvider';
export function AvatarControls() {
  const { play, status, reduced } = useExperience();
  const [selected, setSelected] = useState('idle');
  return <div className="glass avatar-console" data-reveal><div className="panel-heading"><span><Sparkles size={15} /> A LITTLE PERSONALITY</span><span className="live-badge">LIVE 3D</span></div><div className="animation-grid">{['idle', 'wave', 'jump', 'thinking', 'clapping', 'blush', 'bow', 'peace-sign'].map(name => <button key={name} disabled={reduced && name !== 'idle'} aria-pressed={selected === name} onClick={() => { setSelected(name); play(name); }}><Play size={12} />{animations[name].label.split(' ·')[0]}{!animations[name].file && <small>RIG</small>}</button>)}</div><div className="select-row"><span>More expressions</span><CustomSelect ariaLabel="More expressions" value={selected} onChange={name => { setSelected(name); play(name); }} disabled={reduced} options={Object.entries(animations).map(([value, animation]) => ({ value, label: animation.label }))} /></div><div className="console-footer"><MoveHorizontal size={14} /><span>Drag Athena to rotate · use + / − to zoom</span></div><p className="tiny" role="status">{reduced ? 'Reduced motion is on. Athena is shown in a resting pose.' : `Playing: ${status}. All actions use Athena’s original animation clips.`}</p></div>;
}
export function Personalization() {
  const { settings, setSettings, play, reduced } = useExperience();
  return <div className="glass settings-panel" data-reveal><div className="panel-heading"><span>YOUR ATHENA, YOUR WAY</span><span className="live-badge">LIVE PREVIEW</span></div>
    <label className="range-label" htmlFor="avatar-size">Avatar size <output>{Math.round(settings.size * 100)}%</output></label><input id="avatar-size" type="range" min=".7" max="1.15" step=".05" value={settings.size} onChange={e => setSettings(s => ({ ...s, size: +e.target.value }))} />
    <label className="range-label" htmlFor="animation-speed">Animation speed <output>{settings.speed.toFixed(1)}×</output></label><input id="animation-speed" type="range" min=".5" max="2" step=".1" disabled={reduced} value={settings.speed} onChange={e => setSettings(s => ({ ...s, speed: +e.target.value }))} />
    <div className="setting-row"><span>Floating position</span><div className="segmented">{(['left', 'center', 'right'] as const).map(position => <button key={position} aria-pressed={settings.position === position} onClick={() => setSettings(s => ({ ...s, position }))}>{position}</button>)}</div></div>
    <div className="setting-row"><span>Ambient light</span><div className="swatches">{[['#66e5ff', 'Cyan'], ['#a79bff', 'Violet'], ['#ffad79', 'Amber'], ['#ef8bc7', 'Rose']].map(([color, label]) => <button key={color} aria-label={`${label} lighting`} aria-pressed={settings.color === color} style={{ background: color }} onClick={() => setSettings(s => ({ ...s, color }))} />)}</div></div>
    <div className="setting-row"><span>Gentle hovering</span><button className="toggle" role="switch" aria-checked={settings.hover} aria-label="Gentle hovering" onClick={() => setSettings(s => ({ ...s, hover: !s.hover }))}><span /></button></div>
    <div className="select-row"><span>Personality</span><CustomSelect ariaLabel="Personality" value={settings.expression} onChange={expression => setSettings(s => ({ ...s, expression: expression as typeof s.expression }))} options={[{ value: "neutral", label: "Calm & curious" }, { value: "happy", label: "Bright & cheerful" }, { value: "relaxed", label: "Soft & thoughtful" }]} /></div>
    <div className="setting-actions"><button className="text-button" onClick={() => play('wave')} disabled={reduced}>Say hello <Sparkles size={14} /></button><button className="text-button muted" onClick={() => { setSettings(defaults); play('idle'); }}>Reset settings</button></div><p className="tiny">Preview settings stay in this website. Your desktop configuration is untouched.</p>
  </div>;
}
