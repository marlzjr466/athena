// Browser adapter of shared/avatarModels.ts and electron/main/avatarModelRepository.ts.
// Keep the desktop files independent; use a smaller limit for the browser preview.
export const MODEL_NAME_LIMIT = 60;
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
export const VROID_DOWNLOAD_URL = 'https://vroid.com/en/studio';

export function validateModelName(input: string) {
  const name = input.trim();
  if (!name) throw new Error('Enter a model name.');
  if (name.length > MODEL_NAME_LIMIT) throw new Error('Use at most 60 characters.');
  if (/[\p{Cc}\p{Cf}]/u.test(name)) throw new Error('Control characters are not allowed in model names.');
  if (['athena', 'athena classic', 'athena enhanced'].includes(name.normalize('NFKC').toLocaleLowerCase())) throw new Error('Athena is a built-in model name. Choose a different name.');
  return name;
}

export function validateModelFile(file: Pick<File, 'name' | 'size'>) {
  if (!/\.vrm$/i.test(file.name)) throw new Error('Choose an exported .vrm file. Export your .vroid project from VRoid Studio first.');
  if (!file.size || file.size > MAX_PREVIEW_BYTES) throw new Error('Choose a VRM file between 1 byte and 50 MB for this browser preview.');
}

interface VrmMetadata {
  extensions?: {
    VRMC_vrm?: { specVersion?: string; humanoid?: { humanBones?: Record<string, { node: number }> } };
    VRM?: { specVersion?: string; humanoid?: { humanBones?: { bone: string; node: number }[] } };
  };
  nodes?: unknown[]; meshes?: unknown[]; skins?: unknown[];
  buffers?: { uri?: string }[]; images?: { uri?: string }[];
}

export function validateVrmBytes(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 24 || bytes.byteLength > MAX_PREVIEW_BYTES || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new Error('This is not a valid VRM file. Export the model again from VRoid Studio.');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length > 8 * 1024 * 1024 || 20 + length > bytes.byteLength) throw new Error('The VRM metadata is invalid.');
  let json: VrmMetadata;
  try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length))); }
  catch { throw new Error('The VRM metadata could not be read.'); }
  const vrm1 = json?.extensions?.VRMC_vrm;
  const vrm0 = json?.extensions?.VRM;
  if (!vrm1 && !vrm0) throw new Error('This file does not contain a VRM avatar.');
  if ((vrm1 && vrm1.specVersion !== '1.0') || (vrm0 && !String(vrm0.specVersion ?? '0.0').startsWith('0.'))) throw new Error('Export as VRM 0.x or VRM 1.0.');
  const bones = vrm1 ? Object.entries(vrm1.humanoid?.humanBones ?? {}).map(([bone, data]) => ({ bone, ...data })) : vrm0?.humanoid?.humanBones;
  if (!Array.isArray(json.nodes) || !json.meshes?.length || !json.skins?.length || !Array.isArray(bones)) throw new Error('The avatar needs a humanoid skeleton and skinned geometry.');
  for (const required of ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg']) {
    const bone = bones.find(entry => entry?.bone === required);
    if (!bone || !Number.isInteger(bone.node) || !json.nodes[bone.node]) throw new Error(`Missing humanoid bone: ${required}.`);
  }
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (item.uri && !/^data:(image\/(png|jpeg|webp)|application\/octet-stream);base64,/i.test(item.uri)) throw new Error('Export a self-contained VRM with embedded textures. External asset links are not supported.');
  }
}
