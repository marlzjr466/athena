'use client';
import { createContext, useContext, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
export const chapters = ['home', 'meet', 'features', 'voice', 'intelligence', 'development', 'academy', 'meetings', 'capabilities', 'personalization', 'downloads', 'closing'] as const;
export type Chapter = typeof chapters[number];
export interface Settings { size: number; speed: number; position: 'center' | 'left' | 'right'; color: string; hover: boolean; expression: 'neutral' | 'happy' | 'relaxed'; }
export const defaults: Settings = { size: 1, speed: 1, position: 'center', color: '#66e5ff', hover: true, expression: 'neutral' };
interface Experience {
  chapter: Chapter; setChapter: (id: Chapter) => void;
  progress: MutableRefObject<{ value: number }>;
  settings: Settings; setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  action: { name: string; sequence: number }; play: (name: string) => void;
  reduced: boolean; setReduced: (value: boolean) => void;
  status: string; setStatus: (value: string) => void;
  rotation: MutableRefObject<number>; zoom: number; setZoom: React.Dispatch<React.SetStateAction<number>>;
}
const Context = createContext<Experience | null>(null);
export function ExperienceProvider({ children }: { children: ReactNode }) {
  const [chapter, setChapter] = useState<Chapter>('home');
  const [settings, setSettings] = useState(defaults);
  const [action, setAction] = useState({ name: 'wave', sequence: 0 });
  const [reduced, setReduced] = useState(false);
  const [status, setStatus] = useState('Preparing Athena');
  const [zoom, setZoom] = useState(1);
  const progress = useRef({ value: 0 });
  const rotation = useRef(0);
  return <Context.Provider value={{ chapter, setChapter, settings, setSettings, action, play: name => setAction(a => ({ name, sequence: a.sequence + 1 })), reduced, setReduced, progress, status, setStatus, rotation, zoom, setZoom }}>{children}</Context.Provider>;
}
export function useExperience() { const value = useContext(Context); if (!value) throw new Error('ExperienceProvider missing'); return value; }
