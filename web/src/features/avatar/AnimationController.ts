import { AnimationMixer, LoopOnce, LoopRepeat, type AnimationAction, type AnimationClip } from 'three';
import type { AthenaInstance } from './loader';
import { loadClip } from './loader';
import { animations } from './catalog';

// Same mixer/cross-fade/retirement pattern as Athena's desktop controller,
// with lazy clip loading and request sequencing for rapid control changes.
export class AnimationController {
  readonly mixer: AnimationMixer;
  private cache = new Map<string, Promise<AnimationClip>>();
  private retired = new Map<AnimationAction, number>();
  private current?: AnimationAction;
  private ticket = 0;
  private disposed = false;
  private pendingIdle = false;
  active = 'idle';
  expressionTracks = new Set<string>();
  private finished = (event: { action: AnimationAction }) => { if (event.action === this.current) this.pendingIdle = true; };
  constructor(private instance: AthenaInstance, private report: (message: string) => void) {
    this.mixer = new AnimationMixer(instance.vrm.scene);
    this.cache.set('idle', Promise.resolve(instance.idle));
    this.mixer.addEventListener('finished', this.finished);
    this.switch('idle', instance.idle, 0);
  }
  async play(name: string) {
    const ticket = ++this.ticket;
    const clipName = animations[name]?.file ? name : 'idle';
    if (!this.cache.has(clipName)) this.cache.set(clipName, loadClip(this.instance.vrm, clipName));
    try {
      const clip = await this.cache.get(clipName)!;
      if (this.disposed || ticket !== this.ticket) return;
      this.switch(clipName, clip, .32);
      this.report(animations[name]?.label ?? 'Idle');
    } catch {
      this.cache.delete(clipName);
      if (!this.disposed && ticket === this.ticket) {
        this.switch('idle', this.instance.idle, .32);
        this.report(`${animations[name]?.label ?? name} unavailable · using Idle`);
      }
    }
  }
  private switch(name: string, clip: AnimationClip, fade: number) {
    const next = this.mixer.clipAction(clip);
    this.pendingIdle = false;
    this.retired.delete(next);
    next.stopFading().reset().setEffectiveWeight(1);
    const loop = !!animations[name]?.loop;
    next.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    if (this.current && this.current !== next) { next.crossFadeFrom(this.current, fade, false); this.retired.set(this.current, fade); }
    next.play(); this.current = next; this.active = name;
    this.expressionTracks = new Set(clip.tracks.map(track => track.name));
  }
  update(delta: number) {
    this.mixer.update(delta);
    for (const [action, remaining] of this.retired) {
      if (remaining <= delta) { action.stop(); this.retired.delete(action); } else this.retired.set(action, remaining - delta);
    }
    if (this.pendingIdle) { this.switch('idle', this.instance.idle, .32); this.report('Idle'); }
  }
  dispose() { this.disposed = true; this.ticket++; this.mixer.removeEventListener('finished', this.finished); this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.instance.vrm.scene); this.cache.clear(); }
}
