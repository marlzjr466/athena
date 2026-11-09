import { LocalAISettings } from '../settings/LocalAISettings'
import { AthenaChat } from './AthenaChat'
import { AthenaAcademy } from './AthenaAcademy'
import '../../styles/ai.css'
import '../../styles/myAthena.css'

type MyAthenaTab = 'local' | 'chat' | 'academy'

export function MyAthenaPage({ tab }: { tab: MyAthenaTab }) {
  return <div className={`${tab === 'chat' ? 'conversation-page is-chat' : 'settings-page'} my-athena-page ${tab === 'academy' ? 'is-academy' : ''}`}>
    {tab === 'local' ? <section id="my-athena-local-panel" aria-label="Local AI setup"><LocalAISettings /></section>
      : tab === 'chat' ? <section id="my-athena-chat-panel" aria-label="Athena Chat"><AthenaChat /></section> : <section id="my-athena-academy-panel" aria-label="Athena Academy"><AthenaAcademy /></section>}
  </div>
}
