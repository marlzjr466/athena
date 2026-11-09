'use client';
import dynamic from 'next/dynamic';
import { ArrowDown, ArrowDownRight, ArrowRight, ArrowUpRight, AudioLines, Braces, Check, Cpu, Heart, Layers, LockKeyhole, MessageCircle, Mouse, Sparkles, Terminal, WandSparkles } from 'lucide-react';
import { ExperienceProvider, chapters, useExperience, type Chapter } from '@/features/scroll-experience/ExperienceProvider';
import { ScrollDirector } from '@/features/scroll-experience/ScrollDirector';
import { Navigation } from '@/components/navigation/Navigation';
import { DownloadButtons, DownloadCards } from '@/features/downloads/Downloads';
import { repositoryUrl } from '@/features/downloads/config';
import { AvatarControls, Personalization } from '@/features/avatar/AvatarControls';
import { AvatarModelProvider } from '@/features/avatar/AvatarModelProvider';
import { ModelImport } from '@/features/avatar/ModelImport';
import { ChatDemo } from '@/features/feature-demos/ChatDemo';
import { VoiceDemo } from '@/features/feature-demos/VoiceDemo';
import { IntelligenceDemo } from '@/features/feature-demos/IntelligenceDemo';
import { DevelopmentDemo } from '@/features/feature-demos/DevelopmentDemo';
import { AcademyDemo } from '@/features/feature-demos/AcademyDemo';
import { MeetingDemo } from '@/features/feature-demos/MeetingDemo';
import { CapabilitiesDemo } from '@/features/feature-demos/CapabilitiesDemo';
import type { ReactNode } from 'react';
const AthenaScene = dynamic(() => import('@/components/three/AthenaScene'), { ssr: false, loading: () => <div className="scene-stage"><div className="scene-loading">Preparing the 3D experience…</div></div> });
function ChapterLabel({ number, children }: { number: string; children: ReactNode }) { return <div className="chapter-label" data-reveal><span>{number}</span><i />{children}</div>; }
function Section({ id, children, className = '' }: { id: Chapter; children: ReactNode; className?: string }) { return <section className={`chapter ${className}`} id={id} aria-labelledby={`${id}-title`}><div className="section-content">{children}</div></section>; }
function ChapterRail() { const { chapter } = useExperience(); return <div className="chapter-rail" aria-label="Experience chapters">{chapters.map((id, i) => <a key={id} href={`#${id}`} aria-label={`Chapter ${i + 1}: ${id}`} aria-current={chapter === id ? 'location' : undefined}><span>{String(i + 1).padStart(2, '0')}</span><i /></a>)}</div>; }
function Content() {
  const { reduced, setReduced } = useExperience();
  return <>
    <a className="skip-link" href="#features">Skip to features</a>
    <Navigation /><ScrollDirector /><AthenaScene /><ChapterRail />
    <main>
      <Section id="home" className="hero">
        <div className="hero-wordmark" aria-hidden="true">ATHENA</div>
        <div className="eyebrow hero-eyebrow"><span className="status-dot" /> YOUR PERSONAL AI DESKTOP COMPANION</div>
        <h1 id="home-title">Meet<br /><span>Athena</span><span className="title-period">.</span></h1>
        <p className="hero-manifesto">Your desktop. Your intelligence.<br /><strong>Your Athena.</strong></p>
        <p className="hero-description">A little presence. A world of possibility.<br />Intelligence that lives alongside you.</p>
        <DownloadButtons />
        <a className="explore-link" href="#meet">Step into her world <ArrowUpRight size={17} /></a>
        <div className="hero-footer"><a href="#meet"><Mouse size={18} /><span>SCROLL TO EXPLORE</span><ArrowDown size={14} /></a><span>BUILT TO FEEL A LITTLE MORE HUMAN</span></div>
      </Section>
      <Section id="meet">
        <ChapterLabel number="01">A PRESENCE, NOT A WINDOW</ChapterLabel>
        <h2 id="meet-title" data-reveal>A little digital.<br /><em>A lot of personality.</em></h2>
        <p className="section-lede" data-reveal>She waves. She wonders. She stays by your side. Meet the very same Athena who lives on your desktop — brought to life right here.</p>
        <AvatarControls />
        <div className="feature-notes" data-reveal><span><Heart /> Expressive by nature</span><span><Sparkles /> Unmistakably Athena</span></div>
      </Section>
      <Section id="features">
        <ChapterLabel number="02">YOUR EVERYDAY, UPGRADED</ChapterLabel>
        <h2 id="features-title" data-reveal>Big ideas.<br /><em>Meet your plus one.</em></h2>
        <p className="section-lede" data-reveal>From a passing thought to your next project. Chat with your favorite models, bring your files, and keep the conversation going.</p>
        <ChatDemo />
        <div className="feature-notes" data-reveal><span><MessageCircle /> Persistent conversations</span><span><Layers /> Project-aware context</span></div>
      </Section>
      <Section id="voice">
        <ChapterLabel number="03">SAY HELLO</ChapterLabel>
        <h2 id="voice-title" data-reveal>A familiar voice.<br /><em>A natural connection.</em></h2>
        <p className="section-lede" data-reveal>Just say “Hey Athena.” Wake-word activation, speech recognition, and expressive synthesis make room for a more natural conversation.</p>
        <VoiceDemo />
        <div className="feature-notes" data-reveal><span><AudioLines /> Voice input & customization</span><span><WandSparkles /> Expressive delivery</span></div>
      </Section>
      <Section id="intelligence">
        <ChapterLabel number="04">THE MIND BEHIND THE MAGIC</ChapterLabel>
        <h2 id="intelligence-title" data-reveal>Powerful thinking.<br /><em>Personal by design.</em></h2>
        <p className="section-lede" data-reveal>Keep intelligence close with Ollama, or connect to online models. Your context, knowledge, and conversations come along for the journey.</p>
        <IntelligenceDemo />
        <div className="feature-notes" data-reveal><span><LockKeyhole /> Local processing options</span><span><Cpu /> Your choice of model</span></div>
      </Section>
      <Section id="development">
        <ChapterLabel number="05">FROM WHAT IF TO WHAT’S NEXT</ChapterLabel>
        <h2 id="development-title" data-reveal>Your next build.<br /><em>Her next adventure.</em></h2>
        <p className="section-lede" data-reveal>A development partner inside your workflow. Explore repositories, untangle bugs, and create with Claude Code or Codex — with every step in view.</p>
        <DevelopmentDemo />
        <div className="feature-notes" data-reveal><span><Braces /> Repository-aware assistance</span><span><Terminal /> Visible tool operations</span></div>
      </Section>
      <Section id="academy">
        <ChapterLabel number="06">ATHENA ACADEMY</ChapterLabel>
        <h2 id="academy-title" data-reveal>Room to learn.<br /><em>Evidence to grow.</em></h2>
        <p className="section-lede" data-reveal>A learning workspace for your local models. Build knowledge, practice real workflows, inspect evaluations, and explore compatible model fine-tuning — all in Athena Academy.</p>
        <AcademyDemo />
        <div className="feature-notes" data-reveal><span><Layers /> Eight course areas</span><span><Check /> Independent evaluation</span></div>
      </Section>
      <Section id="meetings">
        <ChapterLabel number="07">MEETING INTELLIGENCE</ChapterLabel>
        <h2 id="meetings-title" data-reveal>Stay in the moment.<br /><em>Keep what matters.</em></h2>
        <p className="section-lede" data-reveal>From the live transcript to the next action. Athena brings meeting notes, questions, and authorized screen context into a dedicated workspace and floating panel.</p>
        <MeetingDemo />
        <div className="feature-notes" data-reveal><span><AudioLines /> Local transcription</span><span><MessageCircle /> Notes, answers & meeting history</span></div>
      </Section>
      <Section id="capabilities">
        <ChapterLabel number="08">BEYOND THE CONVERSATION</ChapterLabel>
        <h2 id="capabilities-title" data-reveal>More context.<br /><em>More possibility.</em></h2>
        <p className="section-lede" data-reveal>Your documents, verified lessons, and the public web. Bring the right knowledge into each task, then decide what Athena is allowed to do.</p>
        <CapabilitiesDemo />
        <div className="feature-notes" data-reveal><span><Layers /> Knowledge & verified corrections</span><span><LockKeyhole /> Permissions you control</span></div>
      </Section>
      <Section id="personalization">
        <ChapterLabel number="09">MAKE ROOM FOR YOUR KIND OF DIFFERENT</ChapterLabel>
        <h2 id="personalization-title" data-reveal>Athena.<br /><em>With your signature.</em></h2>
        <p className="section-lede" data-reveal>A quiet corner or center stage. A calm presence or a playful spirit. Adjust her world, or bring your own VRoid character and give your companion a name.</p>
        <Personalization />
        <ModelImport />
        <div className="feature-notes" data-reveal><a href="#voice">Tune her voice <ArrowUpRight /></a><a href="#intelligence">Choose her intelligence <ArrowUpRight /></a></div>
      </Section>
      <Section id="downloads" className="download-section">
        <ChapterLabel number="10">A PLACE ON YOUR DESKTOP</ChapterLabel>
        <h2 id="downloads-title" data-reveal>Bring Athena<br /><em>to your desktop.</em></h2>
        <p className="section-lede" data-reveal>Your AI companion, ready to live on your desktop.</p>
        <div data-reveal><DownloadCards /></div>
        <div className="release-note" data-reveal><span className="status-dot amber" /><p>Release details appear here when installers are available. Only configured release links enable downloads.</p></div>
      </Section>
      <Section id="closing" className="closing">
        <ChapterLabel number="11">THIS IS JUST THE BEGINNING</ChapterLabel>
        <h2 id="closing-title" data-reveal>Your AI.<br />Your companion.<br /><em>Your Athena.</em></h2>
        <div className="closing-capabilities" data-reveal><span><Check size={13} /> Think together</span><span><Check size={13} /> Create together</span><span><Check size={13} /> Make it yours</span></div>
        <div data-reveal><DownloadButtons /></div>
        <a className="explore-link" href="#meet" data-reveal>Explore Athena <ArrowRight size={17} /></a>
        {repositoryUrl && <a className="text-button" href={repositoryUrl} rel="noopener noreferrer" target="_blank">Explore the project <ArrowUpRight size={14} /></a>}
        <div className="closing-note" data-reveal><ArrowDownRight size={28} /><span>More than an assistant.<br /><strong>A little company for your journey.</strong></span></div>
      </Section>
    </main>
    <footer className="site-footer"><a className="brand" href="#home"><img src="/assets/athena.svg" width="25" height="25" alt="" /> ATHENA.</a><span>Intelligence with a little personality.</span><button onClick={() => setReduced(!reduced)} aria-pressed={reduced}>{reduced ? 'Motion reduced' : 'Reduce motion'}</button><a href="#home">Back to top ↑</a></footer>
  </>;
}
export function Experience() { return <ExperienceProvider><AvatarModelProvider><Content /></AvatarModelProvider></ExperienceProvider>; }
