// @vitest-environment node
import {mkdtemp,mkdir,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CodexCLIService, codexAppServerCapabilities, codexLoginUsesChatGPT, normalizeCodexModel } from '../electron/main/ai/codexCLIService'

describe('official Codex CLI status normalization', () => {
  it('recognizes the documented local login status even when the CLI writes it to stderr', () => {
    expect(codexLoginUsesChatGPT('', 'Logged in using ChatGPT\n')).toBe(true)
    expect(codexLoginUsesChatGPT('Logged in using ChatGPT\n', '')).toBe(true)
    expect(codexLoginUsesChatGPT('', 'Not logged in')).toBe(false)
  })

  it('negotiates native app-server capability gates without attestation requests', () => {
    expect(codexAppServerCapabilities).toEqual({ experimentalApi: true, requestAttestation: false })
  })

  it('uses provider model metadata for defaults and supported efforts without inventing catalog entries', () => {
    expect(normalizeCodexModel({ id: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }], defaultReasoningEffort: 'medium' })).toEqual({
      id: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium',
    })
    expect(normalizeCodexModel({ id: 'unsupported model', displayName: 'Unsupported' })).toBeNull()
    expect(normalizeCodexModel({ id: 'gpt-hidden', hidden: true })).toBeNull()
  })
})

describe('native chat history isolation',()=>{
  it('excludes the reserved voice workspace and aliases when native threadSource is null, and checks each read again',async()=>{
    const root=await mkdtemp(join(tmpdir(),'athena-codex-scope-'))
    try {
      const voice=join(root,'codex-voice-workspaces')
      const chat=voice+'-project',alias=join(root,'voice-link')
      await Promise.all([mkdir(voice),mkdir(chat)])
      await symlink(voice,alias,'dir')
      const rows=[
        {id:'chat',cwd:chat,threadSource:null},
        {id:'voice',cwd:voice,threadSource:null},
        {id:'alias',cwd:join(alias,'gone-child'),threadSource:null},
        {id:'tag',cwd:chat,threadSource:'athena_voice_automation'},
      ]
      let stored=rows[0]
      const request=vi.fn(async(method:string)=>{
        if(method==='thread/list')return {data:structuredClone(rows),readStates:{voice:{},chat:{}},nextCursor:'next'}
        if(method==='thread/read')return {thread:stored}
        throw Error('Unexpected method')
      })
      const service=new CodexCLIService('test',voice)
      vi.spyOn(service,'connection').mockResolvedValue({rpc:{request},accountId:'account',accountEmail:'fixture@example.test'} as never)
      vi.spyOn(service,'account').mockResolvedValue({type:'chatgpt',email:'fixture@example.test'} as never)
      const result=await service.listThreads()
      expect(result.data.map(t=>t.id)).toEqual(['chat'])
      expect(result.readStates).toEqual({chat:{}})
      expect(result.nextCursor).toBe('next')
      await expect(service.readThread('voice')).rejects.toThrow('Refresh')
      expect((await service.readThread('chat')).thread.cwd).toBe(chat)
      stored={id:'chat',cwd:alias,threadSource:null}
      await expect(service.readThread('chat')).rejects.toThrow('voice automation history')
      await expect(service.assertChatThread('chat')).rejects.toThrow('voice automation history')
    } finally {await rm(root,{recursive:true,force:true})}
  })
})
