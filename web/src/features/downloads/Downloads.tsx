/** @jsxImportSource react */
import { Apple, ArrowDownToLine, ArrowUpRight } from 'lucide-react';
import { downloads } from './config';
export function PlatformIcon({ platform }: { platform: 'macos' | 'windows' }) {
  return platform === 'macos' ? <Apple size={19} aria-hidden="true" /> : <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M1 3.5 9 2.4V9H1zm9-1.3L19 1v8h-9zM1 10h8v6.6l-8-1zm9 0h9v8l-9-1.2z" /></svg>;
}
export function DownloadButton({ platform }: { platform: 'macos' | 'windows' }) {
  const item = downloads[platform];
  const content = <><PlatformIcon platform={platform} /><span>{item.label}{!item.url && <small>Coming soon</small>}</span>{item.url && <ArrowDownToLine size={15} />}</>;
  return item.url ? <a className="download-button" href={item.url} download rel="noopener noreferrer">{content}</a> : <button className="download-button" disabled aria-label={`${item.label} — coming soon`}>{content}</button>;
}
export function DownloadButtons() { return <div className="download-buttons"><DownloadButton platform="macos" /><DownloadButton platform="windows" /></div>; }
export function DownloadCards() { return <div className="download-cards">{(['macos', 'windows'] as const).map(platform => {
  const item = downloads[platform];
  return <article className="download-card" key={platform}><div className="download-card-top"><PlatformIcon platform={platform} /><span className="mono">.{item.fileType}</span><ArrowUpRight size={16} /></div><h3>{platform === 'macos' ? 'Made for your Mac.' : 'At home on Windows.'}</h3><p>{item.url ? 'Your companion is one download away.' : 'A little closer to your everyday. Installer coming soon.'}</p><dl>{item.version && <div><dt>Version</dt><dd>{item.version}</dd></div>}{item.fileSize && <div><dt>Size</dt><dd>{item.fileSize}</dd></div>}{item.minimumOs && <div><dt>Requires</dt><dd>{item.minimumOs}</dd></div>}{item.architecture && <div><dt>Architecture</dt><dd>{item.architecture}</dd></div>}</dl><DownloadButton platform={platform} /></article>;
})}</div>; }
