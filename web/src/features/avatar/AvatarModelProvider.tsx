'use client';
import { createContext, useContext, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';

interface ModelRequest { file: File; name: string; id: number }
interface Preview { name: string; custom: boolean }
interface ImportState { phase: 'idle' | 'loading' | 'ready' | 'error'; message: string }
interface AvatarModels {
  request: ModelRequest | null; importModel: (file: File, name: string) => void; restore: () => void;
  preview: Preview; setPreview: Dispatch<SetStateAction<Preview>>;
  importState: ImportState; setImportState: Dispatch<SetStateAction<ImportState>>;
  modelReady: boolean; setModelReady: Dispatch<SetStateAction<boolean>>;
}
const Context = createContext<AvatarModels | null>(null);
const athena: Preview = { name: 'Athena', custom: false };
export function AvatarModelProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ModelRequest | null>(null);
  const [preview, setPreview] = useState(athena);
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle', message: '' });
  const [modelReady, setModelReady] = useState(false);
  const sequence = useRef(0);
  return <Context.Provider value={{ request, preview, setPreview, importState, setImportState, modelReady, setModelReady,
    importModel: (file, name) => { setImportState({ phase: 'loading', message: 'Checking your VRM and preparing its animations…' }); setRequest({ file, name, id: ++sequence.current }); },
    restore: () => { setRequest(null); setPreview(athena); setImportState({ phase: 'idle', message: 'Athena restored. Your preview has been cleared.' }); },
  }}>{children}</Context.Provider>;
}
export function useAvatarModels() { const value = useContext(Context); if (!value) throw new Error('AvatarModelProvider missing'); return value; }
