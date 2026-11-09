'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, MathUtils } from 'three';
import { useExperience } from '@/features/scroll-experience/ExperienceProvider';
import { loadAthena, loadLocalAvatar, disposeAthena, type AthenaInstance } from '@/features/avatar/loader';
import { AnimationController } from '@/features/avatar/AnimationController';
import { useAvatarModels } from '@/features/avatar/AvatarModelProvider';

export function AthenaAvatar({ onReady, onError, onProgress }: { onReady: () => void; onError: () => void; onProgress: (n: number) => void }) {
  const [instance, setInstance] = useState<AthenaInstance>();
  const [custom, setCustom] = useState<AthenaInstance>();
  const { request, setPreview, setImportState } = useAvatarModels();
  const { rotation, setZoom } = useExperience();
  useEffect(() => {
    let alive = true;
    let owned: AthenaInstance | undefined;
    loadAthena(n => { if (alive) onProgress(n); }).then(result => {
      if (!alive) { disposeAthena(result.vrm); return; }
      owned = result; setInstance(result); onReady();
    }).catch(() => { if (alive) onError(); });
    return () => { alive = false; if (owned) disposeAthena(owned.vrm); };
  }, [onError, onProgress, onReady]);
  useEffect(() => {
    if (!request) { setCustom(undefined); return; }
    let alive = true;
    loadLocalAvatar(request.file).then(result => {
      if (!alive) { disposeAthena(result.vrm); return; }
      setCustom(result); setPreview({ name: request.name, custom: true });
      setImportState({ phase: 'ready', message: `${request.name} is ready. Try the avatar controls or say hello.` });
      rotation.current = 0; setZoom(1);
    }).catch(error => { if (alive) setImportState({ phase: 'error', message: error instanceof Error ? error.message : 'Unable to preview this model.' }); });
    return () => { alive = false; };
  }, [request, rotation, setZoom, setPreview, setImportState]);
  // The detached rig's layout cleanup stops its mixer before GPU disposal here.
  useEffect(() => () => { if (custom) disposeAthena(custom.vrm); }, [custom]);
  const active = request && custom ? custom : instance;
  return active ? <AvatarRig instance={active} /> : null;
}

function AvatarRig({ instance }: { instance: AthenaInstance }) {
  const controller = useRef<AnimationController | null>(null);
  const rig = useRef<Group>(null);
  const blinkAt = useRef(3);
  const { action, chapter, progress, reduced, settings, rotation, setStatus } = useExperience();
  const lastUserAction = useRef({ sequence: action.sequence, at: -Infinity });
  useLayoutEffect(() => {
    const next = new AnimationController(instance, setStatus);
    controller.current = next;
    return () => { next.dispose(); controller.current = null; };
  }, [instance, setStatus]);
  useEffect(() => {
    if (!instance) return;
    if (action.sequence !== lastUserAction.current.sequence) lastUserAction.current = { sequence: action.sequence, at: performance.now() };
    const name = reduced ? 'idle' : action.name;
    void controller.current?.play(name);
  }, [instance, action, reduced]);
  useEffect(() => {
    if (!instance) return;
    // A control can scroll into view before ScrollTrigger updates the chapter.
    // Preserve that explicit gesture when its interactive chapter catches up.
    if (!reduced && (chapter === 'meet' || chapter === 'personalization') && performance.now() - lastUserAction.current.at < 1000) return;
    const names: Record<string, string> = { home: 'wave', meet: 'idle', features: 'thinking', voice: 'gestures', intelligence: 'thinking', development: 'thinking', personalization: 'idle', downloads: 'model-pose', academy: 'thinking', meetings: 'gestures', capabilities: 'idle', closing: 'wave' };
    const name = reduced ? 'idle' : names[chapter];
    if (chapter === 'closing') rotation.current = 0;
    void controller.current?.play(name);
  }, [chapter, instance, reduced, rotation]);
  useFrame(({ clock }, delta) => {
    if (!instance || !controller.current || !rig.current) return;
    const dt = Math.min(delta, .05);
    const t = clock.elapsedTime;
    controller.current.update(reduced ? 0 : dt * settings.speed);
    const { vrm } = instance;
    const y = !reduced && settings.hover ? Math.sin(t * 1.6) * .025 : 0;
    const targetX = settings.position === 'left' ? -.45 : settings.position === 'right' ? .45 : 0;
    rig.current.position.x = MathUtils.damp(rig.current.position.x, targetX, 5, dt);
    rig.current.position.y = MathUtils.damp(rig.current.position.y, y, 10, dt);
    rig.current.rotation.y = MathUtils.damp(rig.current.rotation.y, rotation.current + (reduced ? 0 : Math.sin(progress.current.value * .9) * .13), 6, dt);
    rig.current.scale.setScalar(MathUtils.damp(rig.current.scale.x, settings.size, 6, dt));
    // Head/neck motion is owned by the original clips. Never add Euler rotation
    // every frame: clips without a head track would accumulate a full spin.
    const expressions = vrm.expressionManager;
    const expressionFree = (name: string) => { const exp = expressions?.getExpression(name); return exp && !controller.current?.expressionTracks.has(`${exp.name}.weight`); };
    if (t > blinkAt.current + .16) blinkAt.current = t + 3.2 + Math.random() * 2;
    if (expressionFree('blink')) expressions?.setValue('blink', !reduced && t >= blinkAt.current && t < blinkAt.current + .16 ? Math.sin((t - blinkAt.current) / .16 * Math.PI) : 0);
    for (const name of ['happy', 'relaxed']) if (expressionFree(name)) expressions?.setValue(name, settings.expression === name ? .4 : 0);
    vrm.update(reduced ? 0 : dt);
  });
  return <group ref={rig} name="Athena-persistent-avatar"><primitive object={instance.vrm.scene} position={instance.offset} scale={instance.scale} dispose={null} /></group>;
}
