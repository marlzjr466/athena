import { MeetingView } from '../features/meetings/MeetingView'
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, BrainCircuit, ChevronRight, CircleHelp, Command, Focus, Info, MessageCircle, Moon, NotebookPen, Orbit, Palette, Settings2, ShieldCheck, Sparkles, Volume2, VolumeX, X } from 'lucide-react'
import { Logo } from '../components/shared/Logo'
import { CompanionPage } from '../features/athena/CompanionPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { ChatView } from '../features/chat/ChatView'
import { MyAthenaPage } from '../features/athena-ai/MyAthenaPage'
import { useAthena } from '../store/athenaStore'
import { isDesktop } from '../services/desktop'

const mainNav = [{ id: 'companion', label: 'My companion', icon: Orbit }, { id: 'conversation', label: 'Conversation', icon: MessageCircle }, { id: 'my-athena', label: 'My Athena', icon: BrainCircuit }]
const myAthenaNav = [{ id: 'my-athena-chat', label: 'Athena Chat', icon: MessageCircle }, { id: 'meetings', label: 'Meeting Intelligence', icon: NotebookPen }, { id: 'my-athena-local', label: 'Local AI setup', icon: Settings2 }, { id: 'my-athena-academy', label: 'Athena Academy', icon: Sparkles }]
const settingsNav = [{ id: 'general', label: 'General', icon: Settings2 }, { id: 'appearance', label: 'Appearance', icon: Palette }, { id: 'floating', label: 'Floating & movement', icon: Focus }, { id: 'ai', label: 'AI', icon: Sparkles }, { id: 'notifications', label: 'Notifications', icon: Bell }, { id: 'voice', label: 'Voice', icon: Volume2 }, { id: 'shortcuts', label: 'Shortcuts', icon: Command }, { id: 'privacy', label: 'Privacy', icon: ShieldCheck }]
const isMyAthenaPage = (page: string) => page === 'my-athena' || myAthenaNav.some((item) => item.id === page)

export function ControlCenter() {
  const { page, setPage, snapshot, update, error, dismissError } = useAthena()
  useEffect(() => { if (page === 'my-athena-voice') setPage('voice') }, [page, setPage])
  const [myAthenaExpanded, setMyAthenaExpanded] = useState(() => isMyAthenaPage(page))
  useEffect(() => { setMyAthenaExpanded(isMyAthenaPage(page)) }, [page])
  const myAthenaLabel = myAthenaNav.find((item) => item.id === page)?.label ?? (page === 'my-athena' ? 'Athena Chat' : undefined)
  const label = myAthenaLabel ? `My Athena / ${myAthenaLabel}` : [...mainNav, ...settingsNav, { id: 'about', label: 'About Athena' }].find((item) => item.id === page)?.label ?? 'My companion'
  const uiScale = snapshot?.settings.uiScale ?? 1
  return <div className="control-center" style={{ zoom: uiScale, height: `calc(100vh / ${uiScale})` }}>
    <aside className="sidebar" data-reduce-motion={snapshot?.settings.reducedMotion || undefined}><div className="window-drag-area" /><div className="brand"><Logo /><div><span>ATHENA</span><small>ALWAYS A LITTLE CLOSER</small></div></div>
      <nav aria-label="Main navigation"><div className="nav-group">{mainNav.map(({ id, label: name, icon: Icon }) => {
        const parent = id === 'my-athena'
        const active = page === id || (parent && isMyAthenaPage(page))
        return <div key={id} className="nav-entry">
          <button className={`nav-item ${active ? 'active' : ''}`} onClick={() => {
            if (parent && active) setMyAthenaExpanded((expanded) => !expanded)
            else setPage(id)
          }} aria-current={active ? 'page' : undefined} aria-expanded={parent ? myAthenaExpanded : undefined} aria-controls={parent ? 'my-athena-submenu' : undefined}>
            <Icon size={18} /><span>{name}</span>
            {parent ? <ChevronRight size={15} className={`nav-caret ${myAthenaExpanded ? 'is-expanded' : ''}`} aria-hidden="true" /> : active && <span className="nav-active-dot" />}
          </button>
          {parent && <div id="my-athena-submenu" className={`nav-submenu ${myAthenaExpanded ? 'is-expanded' : ''}`} aria-hidden={!myAthenaExpanded} inert={!myAthenaExpanded}>
            <div className="nav-submenu-clip"><div className="nav-subgroup" role="group" aria-label="My Athena pages">
              {myAthenaNav.map(({ id: subId, label: subName, icon: SubIcon }) => {
                const selected = page === subId || (page === 'my-athena' && subId === 'my-athena-chat')
                return <button key={subId} className={`nav-subitem ${selected ? 'active' : ''}`} onClick={() => setPage(subId)} aria-current={selected ? 'page' : undefined}><SubIcon size={15} /><span>{subName}</span></button>
              })}
            </div></div>
          </div>}
        </div>
      })}</div>
        <div className="nav-group"><span className="nav-label">MAKE IT YOURS</span>{settingsNav.map(({ id, label: name, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}><Icon size={17} /><span>{name}</span></button>)}</div>
      </nav>
      <div className="sidebar-bottom"><button className={`nav-item ${page === 'about' ? 'active' : ''}`} onClick={() => setPage('about')}><CircleHelp size={17} /><span>About Athena</span><span className="nav-version">v0.1</span></button><div className="profile"><span className="profile-avatar">Y</span><div><strong>Your personal space</strong><span>Local · Private · Yours</span></div><ShieldCheck size={14} /></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb">Your workspace <ChevronRight size={13} /><span>{label}</span></div><div className="topbar-actions"><span className="connection-status"><span className="status-dot" />{isDesktop ? 'Companion ready' : 'Browser preview'}</span><span className="topbar-divider" /><button className={`icon-button ${snapshot?.settings.voiceMuted ? 'is-active' : ''}`} aria-label="Mute Athena" aria-pressed={snapshot?.settings.voiceMuted ?? false} title={snapshot?.settings.voiceMuted ? 'Unmute Athena' : 'Mute Athena'} onClick={() => void update({ voiceMuted: !snapshot?.settings.voiceMuted })}>{snapshot?.settings.voiceMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button><button className={`icon-button ${snapshot?.settings.doNotDisturb ? 'is-active' : ''}`} aria-label="Do not disturb" aria-pressed={snapshot?.settings.doNotDisturb ?? false} title="Do not disturb" onClick={() => void update({ doNotDisturb: !snapshot?.settings.doNotDisturb })}><Moon size={17} /></button></div></header>
      <main className={`main-content ${page === 'conversation' || page === 'my-athena' || page === 'my-athena-chat' ? 'conversation-content' : ''}`}><AnimatePresence mode="wait"><motion.div className={page === 'conversation' || page === 'my-athena' || page === 'my-athena-chat' ? 'conversation-route' : undefined} key={page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>{page === 'meetings' ? <div className="settings-page meeting-page-shell"><MeetingView /></div> : page === 'companion' ? <CompanionPage /> : page === 'conversation' ? <div className="conversation-page"><ChatView /></div> : isMyAthenaPage(page) ? <MyAthenaPage tab={page === 'my-athena-academy' ? 'academy' : page === 'my-athena-local' ? 'local' : 'chat'} /> : <SettingsPage page={page} />}</motion.div></AnimatePresence></main>
      {(error || snapshot?.error) && <div className="error-toast" role="alert"><Info size={18} /><span>{error || snapshot?.error}</span><button aria-label="Dismiss error" className="icon-button" onClick={dismissError}><X size={15} /></button></div>}
      {!isDesktop && <div className="browser-notice">Design preview · Run the Electron app for desktop floating, dragging, tray, and saved preferences.</div>}
    </div>
  </div>
}
