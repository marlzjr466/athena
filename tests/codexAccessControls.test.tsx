import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyAIStatus } from '../shared/ai'
import { emptyChatSnapshot } from '../shared/chat'
import { useChat } from '../src/store/chatStore'
const api=vi.hoisted(()=>({chatSession:vi.fn(),getPermissions:vi.fn(),setFilesystemAccess:vi.fn()}))
vi.mock('../src/services/desktop',()=>({desktop:api}))
import { ConversationControls } from '../src/features/chat/ConversationControls'
const id='11111111-1111-4111-8111-111111111111'
const config={...emptyAIStatus(),provider:'Codex CLI' as const,active:true,model:'gpt-6-astra',models:['gpt-6-astra']}
beforeEach(()=>{
  vi.clearAllMocks();api.chatSession.mockResolvedValue({ok:true})
  useChat.setState({snapshot:{...emptyChatSnapshot(),sessionId:id,config:{provider:'OpenAI',model:'gpt-6-astra',effort:'high',agentMode:'ask'}},pending:false,issue:null})
})
afterEach(()=>vi.restoreAllMocks())
const choose=(name:string)=>{fireEvent.click(screen.getByRole('combobox',{name:'Coding agent permissions'}));fireEvent.click(screen.getByRole('option',{name:new RegExp(name)}))}
it('warns explicitly before unrestricted access, including non-project chats, without changing host filesystem scope',async()=>{
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
  render(<ConversationControls config={config}/>);choose('Full Access')
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('danger-full-access / never'))
  expect(api.chatSession).not.toHaveBeenCalled()
  confirm.mockReturnValue(true);choose('Full Access')
  await waitFor(()=>expect(api.chatSession).toHaveBeenCalledWith({action:'agent-mode',id,mode:'full-access',confirmed:true}))
  expect(api.getPermissions).not.toHaveBeenCalled();expect(api.setFilesystemAccess).not.toHaveBeenCalled()
})
it('changes the next turn without a stop confirmation or a redundant status line',async()=>{
  const confirm=vi.spyOn(window,'confirm')
  act(()=>useChat.setState({snapshot:{...useChat.getState().snapshot,phase:'thinking',codexAccess:{mode:'ask',status:'verified'},config:{...useChat.getState().snapshot.config!,agentMode:'read-only'}}}))
  render(<ConversationControls config={config}/>);expect(screen.queryByRole('status')).not.toBeInTheDocument()
  choose('Ask Before Changes');await waitFor(()=>expect(api.chatSession).toHaveBeenCalledWith({action:'agent-mode',id,mode:'ask'}))
  expect(confirm).not.toHaveBeenCalled()
})
it('does not present rejected Full Access as effective',()=>{
  act(()=>useChat.setState({snapshot:{...useChat.getState().snapshot,config:{...useChat.getState().snapshot.config!,agentMode:'full-access',codexFullAccessConfirmed:true},codexAccess:{mode:'full-access',status:'rejected',error:'Organization requires read-only'}}}))
  render(<ConversationControls config={config}/>);
  expect(screen.getByRole('combobox',{name:'Coding agent permissions'})).toHaveTextContent('Full Access · blocked')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
it('does not apply Codex permission behavior to an explicitly selected API provider',()=>{
  act(()=>useChat.setState({snapshot:{...useChat.getState().snapshot,config:{...useChat.getState().snapshot.config!,accountRoute:{provider:'cloud',accountId:'api'}}}}))
  render(<ConversationControls config={config}/>);expect(screen.queryByRole('combobox',{name:'Coding agent permissions'})).not.toBeInTheDocument()
})
