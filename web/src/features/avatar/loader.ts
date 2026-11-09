import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AnimationMixer, Box3, Vector3, SkinnedMesh, Mesh, Texture, LoadingManager, type Object3D, type AnimationClip } from 'three';
import { animations } from './catalog';
import { validateModelFile, validateVrmBytes } from './importValidation';

// Web adapter of src/three/vroidAssets.ts. Embedded textures are decoded by GLTFLoader;
// no Electron bridge, Vite ?url imports, or desktop filesystem reads are retained.
export function createLoader(manager?: LoadingManager) {
  const loader = new GLTFLoader(manager);
  loader.register(parser => new VRMLoaderPlugin(parser));
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  return loader;
}
export async function loadClip(vrm: VRM, name: string): Promise<AnimationClip> {
  const file = animations[name]?.file;
  if (!file) throw new Error(`No clip for ${name}`);
  const gltf = await createLoader().loadAsync(`/animations/${encodeURIComponent(file)}`);
  const animation = gltf.userData.vrmAnimations?.[0];
  if (!animation) throw new Error(`Invalid VRMA: ${file}`);
  const clip = createVRMAnimationClip(animation, vrm);
  if (!clip.tracks.length || !clip.validate() || clip.duration <= 0) throw new Error(`Invalid tracks: ${file}`);
  return clip;
}
export async function loadAthena(onProgress: (percent: number) => void) {
  const gltf = await createLoader().loadAsync('/models/model.vrm', event => onProgress(event.total ? Math.round(event.loaded / event.total * 90) : 0));
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error('Athena model does not contain a VRM');
  const instance = await prepareAvatar(vrm);
  onProgress(100);
  return instance;
}

export async function loadLocalAvatar(file: File) {
  validateModelFile(file);
  const bytes = await file.arrayBuffer();
  validateVrmBytes(bytes);
  // Defense in depth: even extension resource URLs cannot leave this browser.
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('External avatar resources are not supported.');
    return url;
  });
  try {
    const gltf = await createLoader(manager).parseAsync(bytes, '');
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) { disposeScene(gltf.scene); throw new Error('VRM unavailable'); }
    return await prepareAvatar(vrm);
  } catch { throw new Error('This avatar could not be prepared. Re-export a complete humanoid VRM with embedded textures from VRoid Studio.'); }
}

async function prepareAvatar(vrm: VRM) {
  try {
    VRMUtils.rotateVRM0(vrm);
    if (!vrm.humanoid.getNormalizedBoneNode('hips') || !vrm.humanoid.getNormalizedBoneNode('head')) throw new Error('Humanoid rig unavailable');
    const idle = await loadClip(vrm, 'idle');
    const primer = new AnimationMixer(vrm.scene);
    primer.clipAction(idle).play(); primer.update(0); vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    vrm.scene.traverse(node => { if (node instanceof SkinnedMesh) { node.computeBoundingBox(); node.computeBoundingSphere(); node.frustumCulled = false; } });
    const box = new Box3().setFromObject(vrm.scene);
    const height = box.getSize(new Vector3()).y;
    if (!Number.isFinite(height) || height < .1) throw new Error('Invalid model bounds');
    const scale = 2.8 / height;
    const center = box.getCenter(new Vector3());
    primer.stopAllAction(); primer.uncacheRoot(vrm.scene);
    return { vrm, idle, scale, offset: new Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale) };
  } catch (error) { disposeAthena(vrm); throw error; }
}
export function disposeAthena(vrm: VRM) {
  disposeScene(vrm.scene);
}
function disposeScene(scene: Object3D) {
  const bitmaps = new Set<ImageBitmap>();
  scene.traverse(node => {
    if (!(node instanceof Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      const values = [...Object.values(material), ...Object.values(material.uniforms ?? {}).map(uniform => (uniform as { value: unknown }).value)];
      for (const value of values) if (value instanceof Texture && typeof value.image?.close === 'function') bitmaps.add(value.image);
    }
  });
  VRMUtils.deepDispose(scene);
  bitmaps.forEach(bitmap => bitmap.close());
}
export type AthenaInstance = Awaited<ReturnType<typeof loadAthena>>;
