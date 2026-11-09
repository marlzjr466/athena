export function Logo({ small = false }: { small?: boolean }) {
  return <span className={`logo ${small ? 'logo-small' : ''}`} aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M5 25 14 6h4l9 19h-5L16 12l-6 13Z" fill="currentColor" /><path d="m11 21 5-3 5 3-5 3Z" fill="currentColor" /></svg></span>
}
