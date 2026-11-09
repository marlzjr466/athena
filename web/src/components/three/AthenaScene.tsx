'use client';
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { MathUtils } from 'three';
import { RotateCcw, ZoomIn, ZoomOut, MoveHorizontal } from 'lucide-react';
import { AthenaAvatar } from './AthenaAvatar';
import { Environment } from './Environment';
import { useExperience } from '@/features/scroll-experience/ExperienceProvider';
import { useAvatarModels } from '@/features/avatar/AvatarModelProvider';

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function CameraController() {
  const { progress, reduced, zoom } = useExperience();
  const { camera, size } = useThree();
  useFrame((_, delta) => {
    const p = progress.current.value;
    const mobile = size.width < 600;
    const z = (mobile ? 6.5 : 6.8) / zoom + (reduced ? 0 : Math.sin(p * .8) * .45);
    camera.position.z = MathUtils.damp(camera.position.z, z, 3, delta);
    camera.position.x = MathUtils.damp(camera.position.x, reduced ? 0 : Math.sin(p * 1.3) * .28, 3, delta);
    camera.position.y = MathUtils.damp(camera.position.y, 1.65 + (reduced ? 0 : Math.sin(p) * .12), 3, delta);
    camera.lookAt(0, 1.4, 0);
  });
  return null;
}
function Fallback() { return <div className="scene-fallback"><span className="eyebrow">THE EXPERIENCE CONTINUES</span><p>The 3D preview is unavailable on this device.</p><small>Explore every feature and download option below.</small></div>; }
export default function AthenaScene() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [mobile, setMobile] = useState(false);
  const [lowPower, setLowPower] = useState(false);
  const [visible, setVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [percent, setPercent] = useState(0);
  const { chapter, status, rotation, setZoom, reduced } = useExperience();
  const { preview, setModelReady } = useAvatarModels();
  const drag = useRef<number | null>(null);
  const interactive = chapter === 'meet' || chapter === 'personalization';
  const onReady = useCallback(() => { setReady(true); setModelReady(true); }, [setModelReady]);
  const onError = useCallback(() => { setFailed(true); setModelReady(false); }, [setModelReady]);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    setAvailable(!!gl); gl?.getExtension('WEBGL_lose_context')?.loseContext();
    const device = navigator as Navigator & { deviceMemory?: number };
    setLowPower(navigator.hardwareConcurrency <= 4 || (device.deviceMemory !== undefined && device.deviceMemory <= 4));
    const media = matchMedia('(max-width: 800px)');
    const resize = () => setMobile(media.matches);
    const visibility = () => setVisible(!document.hidden);
    resize(); media.addEventListener('change', resize); document.addEventListener('visibilitychange', visibility);
    return () => { media.removeEventListener('change', resize); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  return <aside className={`scene-stage ${interactive ? 'is-interactive' : ''}`} aria-label={`Interactive ${preview.name} 3D avatar`} data-ready={ready && !failed} data-animation={status} data-model={preview.custom ? 'custom' : 'athena'} data-model-name={preview.name}>
    <div className="stage-halo" />
    <div className="orbit-label orbit-top"><span className="status-dot" /> {preview.custom ? 'YOUR CHARACTER / ATHENA INTELLIGENCE' : 'PERSONAL INTELLIGENCE / ATHENA'}</div>
    {available === false || failed ? <Fallback /> : <SceneBoundary fallback={<Fallback />} onError={onError}>
      {available && <div className="canvas-wrap" role={interactive ? 'group' : undefined} aria-label={interactive ? `Drag horizontally to rotate ${preview.name}. Keyboard controls are below.` : undefined}
        onPointerDown={e => { if (interactive) { drag.current = e.clientX; e.currentTarget.setPointerCapture(e.pointerId); } }}
        onPointerMove={e => { if (drag.current !== null) { rotation.current += (e.clientX - drag.current) * .008; drag.current = e.clientX; } }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <Canvas camera={{ position: [0, 1.65, 7.5], fov: 33, near: .1, far: 40 }} dpr={[1, mobile || lowPower || reduced ? 1 : 1.5]} gl={{ alpha: true, antialias: !mobile && !lowPower, powerPreference: 'high-performance' }} frameloop={visible ? 'always' : 'never'} onCreated={({ gl }) => { gl.domElement.addEventListener('webglcontextlost', onError, { once: true }); }}>
          <CameraController /><Environment mobile={mobile || lowPower} />
          <AthenaAvatar onReady={onReady} onError={onError} onProgress={setPercent} />
        </Canvas>
      </div>}
      {!ready && <div className="scene-loading" role="status"><span className="loader-ring" /><span>AWAKENING ATHENA</span><progress value={percent} max="100" aria-label="Loading Athena avatar" /><small>{percent}% · Original VRM avatar</small></div>}
    </SceneBoundary>}
    <div className="avatar-label"><span className="crosshair">＋</span><div><strong title={preview.name}>{preview.name.toUpperCase()}</strong><span>{ready && !failed ? 'REAL-TIME 3D · ' + status.toUpperCase() : 'YOUR DESKTOP COMPANION'}</span></div><span className="status-dot" /></div>
    {interactive && ready && !failed && <div className="stage-controls" aria-label="Avatar view controls">
      <button aria-label={`Rotate ${preview.name} left`} onClick={() => { rotation.current -= .4; }}><MoveHorizontal size={16} /> Rotate</button>
      <button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(.8, z - .1))}><ZoomOut size={17} /></button>
      <button aria-label="Zoom in" onClick={() => setZoom(z => Math.min(1.35, z + .1))}><ZoomIn size={17} /></button>
      <button aria-label="Reset avatar view" onClick={() => { rotation.current = 0; setZoom(1); }}><RotateCcw size={16} /></button>
    </div>}
  </aside>;
}
