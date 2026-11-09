'use client';
import { useState } from 'react';
import { ArrowDownToLine, Menu, X } from 'lucide-react';
import { useExperience } from '@/features/scroll-experience/ExperienceProvider';
const links = [['home', 'Home'], ['features', 'Features'], ['intelligence', 'Intelligence'], ['voice', 'Voice'], ['academy', 'Academy'], ['meetings', 'Meetings'], ['personalization', 'Personalization'], ['downloads', 'Downloads']] as const;
export function Navigation() {
  const [open, setOpen] = useState(false);
  const { chapter } = useExperience();
  return <header className="site-header"><a href="#home" className="brand" aria-label="Athena home"><img src="/assets/athena.svg" width="34" height="34" alt="" /><span>ATHENA<span className="brand-period">.</span></span></a>
    <nav id="primary-navigation" aria-label="Main navigation" className={open ? 'nav-open' : ''}>{links.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={chapter === id ? 'location' : undefined} onClick={() => setOpen(false)}>{label}</a>)}</nav>
    <a className="nav-download" href="#downloads">Get Athena <ArrowDownToLine size={14} /></a>
    <button className="mobile-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls="primary-navigation" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
    <div className="nav-progress" />
  </header>;
}
