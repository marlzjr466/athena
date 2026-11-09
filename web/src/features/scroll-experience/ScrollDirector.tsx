'use client';
import { useEffect, useRef } from 'react';
import { ReactLenis, type LenisRef } from 'lenis/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { chapters, useExperience } from './ExperienceProvider';
gsap.registerPlugin(ScrollTrigger);
export function ScrollDirector() {
  const lenis = useRef<LenisRef>(null);
  const { progress, setChapter, reduced, setReduced } = useExperience();
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [setReduced]);
  useEffect(() => {
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
    const ticker = (time: number) => lenis.current?.lenis?.raf(time * 1000);
    if (!reduced) gsap.ticker.add(ticker);
    const context = gsap.context(() => {
      const sections = chapters.map(id => document.getElementById(id)!);
      sections.forEach((section, index) => {
        ScrollTrigger.create({ trigger: section, start: 'top center', end: 'bottom center', onToggle: self => { if (self.isActive) setChapter(chapters[index]); } });
        const reveals = Array.from(section.querySelectorAll('[data-reveal]'));
        if (!reduced && reveals.length) {
          gsap.fromTo(reveals, { y: 25, opacity: .25 }, { y: 0, opacity: 1, stagger: .08, ease: 'power2.out', scrollTrigger: { trigger: section, start: 'top 78%', end: 'top 22%', scrub: .6 } });
        }
      });
      gsap.to(progress.current, { value: chapters.length - 1, ease: 'none', scrollTrigger: { trigger: 'main', start: 'top top', end: 'bottom bottom', scrub: reduced ? true : .7 } });
      gsap.to('.nav-progress', { scaleX: 1, ease: 'none', scrollTrigger: { trigger: 'main', start: 'top top', end: 'bottom bottom', scrub: true } });
    });
    // Interactive demo tabs can change chapter height, especially on phones.
    // Keep navigation and camera progress aligned with the actual document.
    let refreshFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(refreshFrame);
      refreshFrame = requestAnimationFrame(() => ScrollTrigger.refresh());
    });
    chapters.forEach(id => { const section = document.getElementById(id); if (section) observer.observe(section); });
    ScrollTrigger.refresh();
    return () => { observer.disconnect(); cancelAnimationFrame(refreshFrame); context.revert(); gsap.ticker.remove(ticker); };
  }, [progress, reduced, setChapter]);
  return reduced ? null : <ReactLenis root ref={lenis} options={{ autoRaf: false, duration: 1, smoothWheel: true, syncTouch: false, anchors: true, prevent: node => node.closest('[data-lenis-prevent]') !== null }} />;
}
