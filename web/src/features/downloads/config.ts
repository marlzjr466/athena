export interface PlatformDownload {
  label: string; url?: string; fileType: 'dmg' | 'exe'; version?: string;
  fileSize?: string; minimumOs?: string; architecture?: string;
}
export function safePublicUrl(value?: string): string | undefined {
  if (!value || value.trim() !== value) return undefined;
  if (/^\/(?!\/)[a-zA-Z0-9_\-./%]+$/.test(value) && !value.includes('..')) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export const downloads: Record<'macos' | 'windows', PlatformDownload> = {
  macos: {
    label: 'Download for macOS', fileType: 'dmg',
    url: safePublicUrl(process.env.NEXT_PUBLIC_ATHENA_MACOS_DOWNLOAD_URL),
    version: process.env.NEXT_PUBLIC_ATHENA_MACOS_VERSION,
    fileSize: process.env.NEXT_PUBLIC_ATHENA_MACOS_FILE_SIZE,
    minimumOs: process.env.NEXT_PUBLIC_ATHENA_MACOS_MINIMUM_OS,
    architecture: process.env.NEXT_PUBLIC_ATHENA_MACOS_ARCHITECTURE,
  },
  windows: {
    label: 'Download for Windows', fileType: 'exe',
    url: safePublicUrl(process.env.NEXT_PUBLIC_ATHENA_WINDOWS_DOWNLOAD_URL),
    version: process.env.NEXT_PUBLIC_ATHENA_WINDOWS_VERSION,
    fileSize: process.env.NEXT_PUBLIC_ATHENA_WINDOWS_FILE_SIZE,
    minimumOs: process.env.NEXT_PUBLIC_ATHENA_WINDOWS_MINIMUM_OS,
    architecture: process.env.NEXT_PUBLIC_ATHENA_WINDOWS_ARCHITECTURE,
  },
};
export const repositoryUrl = safePublicUrl(process.env.NEXT_PUBLIC_ATHENA_REPOSITORY_URL);
