'use client';
// Web adapter of Athena's src/components/ui/CustomSelect.tsx. Preserves its
// options API, checkmark/chevron UI and styling; portals avoid clipped glass panels.
import { Check, ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface CustomSelectOption { value: string; label: string; disabled?: boolean }
export function CustomSelect({ ariaLabel, value, options, onChange, disabled = false, className = '', menuPlacement = 'auto' }: {
  ariaLabel: string; value: string; options: CustomSelectOption[];
  onChange?(value: string): void; disabled?: boolean; className?: string;
  menuPlacement?: 'up' | 'down' | 'auto';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState({ left: 0, top: 0, width: 200, maxHeight: 260, up: false });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', time: 0 });
  const id = useId();
  const selected = options.find(option => option.value === value);
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index !== -1);
  const show = () => { if (!disabled && enabled.length) { setActive(Math.max(0, options.findIndex(option => option.value === value && !option.disabled))); setOpen(true); } };
  const choose = (index: number) => { if (!options[index] || options[index].disabled) return; onChange?.(options[index].value); setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    let frame = 0;
    const position = () => {
      if (!trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 210), innerWidth - 24);
      const rowHeight = matchMedia('(max-width: 800px)').matches ? 42 : 38;
      const below = innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const up = menuPlacement === 'up' || (menuPlacement === 'auto' && below < Math.min(260, options.length * rowHeight + 12) && above > below);
      const maxHeight = Math.min(260, Math.max(50, up ? above : below));
      const height = Math.min(maxHeight, options.length * rowHeight + 12);
      const next = { left: Math.round(Math.max(12, Math.min(rect.left, innerWidth - width - 12))), top: Math.round(Math.max(12, Math.min(innerHeight - height - 12, up ? rect.top - height - 6 : rect.bottom + 6))), width, maxHeight, up };
      setPlacement(previous => Object.keys(next).every(key => next[key as keyof typeof next] === previous[key as keyof typeof previous]) ? previous : next);
      // Follow smooth scrolling and GSAP transforms rather than closing on a
      // pending scroll event immediately after the visitor opens the menu.
      frame = requestAnimationFrame(position);
    };
    position();
    return () => cancelAnimationFrame(frame);
  }, [open, menuPlacement, options.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !enabled.length) return;
    if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); if (event.key === 'Escape') event.preventDefault(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { show(); return; }
      const index = enabled.indexOf(active), direction = event.key === 'ArrowDown' ? 1 : -1;
      setActive(enabled[(index + direction + enabled.length) % enabled.length]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); setOpen(true); setActive(event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); if (open) choose(active); else show();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now(); typed.current = { text: (now - typed.current.time < 700 ? typed.current.text : '') + event.key.toLowerCase(), time: now };
      const match = enabled.find(index => options[index].label.toLowerCase().startsWith(typed.current.text));
      if (match !== undefined) { setOpen(true); setActive(match); }
    }
  };
  return <div ref={root} className={`custom-select ${open ? 'is-open' : ''} ${className}`}>
    <button ref={trigger} type="button" role="combobox" className="custom-select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined} value={value} disabled={disabled || !enabled.length} onClick={() => open ? setOpen(false) : show()} onKeyDown={keyDown} onBlur={event => { if (!menu.current?.contains(event.relatedTarget)) setOpen(false); }}>
      <span>{selected?.label ?? 'Select'}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} className={`custom-select-menu ${placement.up ? 'opens-up' : ''}`} role="listbox" aria-label={`${ariaLabel} options`} data-lenis-prevent style={{ left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight }}>
      {options.map((option, index) => <button id={`${id}-${index}`} data-index={index} type="button" tabIndex={-1} role="option" aria-selected={option.value === value} className={`${option.value === value ? 'selected' : ''} ${active === index ? 'active' : ''}`} key={option.value} disabled={option.disabled} onPointerDown={event => event.preventDefault()} onMouseEnter={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
