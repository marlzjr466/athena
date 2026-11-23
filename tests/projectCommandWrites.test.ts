// @vitest-environment node
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCommands } from '../electron/main/ai/agentCommands'
import { CursorTerminalBridge } from '../electron/main/ai/cursorTerminal'
import { validateCommandWritePaths } from '../electron/main/ai/commandFileAccess'
import { projectCommandLease } from '../electron/main/ai/projectCommandLease'
import { AgentTools } from '../electron/main/ai/agentTools'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
import { ChatController } from '../electron/main/ai/chatController'
vi.mock('../electron/main/logger', () => ({ log: vi.fn() }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'athena-project-write-'))); roots.push(parent)
  const root = join(parent, 'map-governance-ui'); await mkdir(root)
  return { parent, root }
}
const generate = `const fs=require('fs');fs.mkdirSync('src/api/generated/nested',{recursive:true});fs.writeFileSync('src/api/generated/health-api.ts','export const health = 1;\\n');fs.appendFileSync('src/api/generated/health-api.ts','// updated\\n');fs.writeFileSync('src/api/generated/nested/client.ts','export {}');console.log('generated')`
const request = (code: string) => ({ executable: 'node', args: ['-e', code], network: false, install: false, gitWrite: false })
describe('authorized project writes through the actual macOS sandbox', () => {
  it('reproduces EPERM without a grant, then permits new nested output and child/package-script writes', async () => {
    const {root} = await fixture(), commands = new AgentCommands(), signal = AbortSignal.timeout(20000)
    const denied = await commands.execute(root, request(generate), signal)
    expect(denied.exitCode).not.toBe(0); expect(denied.output).toMatch(/EPERM|EACCES/)
    await writeFile(join(root,'generator.cjs'), generate)
    await writeFile(join(root,'parent.cjs'), `require('child_process').execFileSync(process.execPath,['generator.cjs'],{stdio:'inherit'})`)
    await writeFile(join(root,'package.json'), JSON.stringify({scripts:{'generate:api':'node parent.cjs'}}))
    const bridge = new CursorTerminalBridge(root, signal, async (_title, description, _signal, _changes, scope) => {
      expect(description).toContain('Source writes: allowed within this project'); expect(scope).toBeUndefined(); return true
    }, async () => {})
    try {
      const {terminalId}=await bridge.create({sessionId:'test',cwd:root,command:'npm',args:['run','generate:api']},'test')
      expect(await bridge.waitForExit({sessionId:'test',terminalId},'test')).toMatchObject({exitCode:0})
      expect(await readFile(join(root,'src/api/generated/health-api.ts'),'utf8')).toContain('// updated')
      expect(await readFile(join(root,'src/api/generated/nested/client.ts'),'utf8')).toBe('export {}')
    } finally { bridge.dispose() }
  },30000)
  it('denies outside writes, traversal, symlink escapes, protected paths and unapproved deletion',async()=>{
    const {root,parent}=await fixture(), commands=new AgentCommands(), signal=AbortSignal.timeout(20000)
    const outside=join(parent,'outside');await mkdir(outside);await symlink(outside,join(root,'escape'))
    await mkdir(join(root,'.git'));await mkdir(join(root,'.claude'));await mkdir(join(root,'node_modules'))
    await writeFile(join(root,'keep.ts'),'keep')
    for(const target of ['../outside/new.ts','escape/new.ts','.git/config','.claude/settings.json','.env','private.key','node_modules/injected.js','package.json']) {
      const result=await commands.execute(root,{...request(`require('fs').writeFileSync(${JSON.stringify(target)},'blocked')`),projectWrite:true,projectDelete:true},signal)
      expect(result.exitCode,`${target}: ${result.output}`).not.toBe(0)
    }
    const deletion=await commands.execute(root,{...request("require('fs').unlinkSync('keep.ts')"),projectWrite:true},signal)
    expect(deletion.exitCode).not.toBe(0);expect(await readFile(join(root,'keep.ts'),'utf8')).toBe('keep')
    const allowed=await commands.execute(root,{...request("require('fs').unlinkSync('keep.ts')"),projectWrite:true,projectDelete:true},signal)
    expect(allowed.exitCode,allowed.output).toBe(0)
    for(const path of ['../outside','escape/subdir','.git','/tmp']) expect(()=>validateCommandWritePaths(root,[path])).toThrow()
  },30000)
  it('supports new scoped output directories and rejects stale queued authorization',async()=>{
    const {root}=await fixture(),commands=new AgentCommands(),signal=AbortSignal.timeout(10000)
    const result=await commands.execute(root,{...request(generate),approvedWritePaths:['src']},signal)
    expect(result.exitCode,result.output).toBe(0)
    const release=await projectCommandLease.acquire(root,signal)
    let allowed=true
    const pending=commands.execute(root,{...request("require('fs').writeFileSync('stale.ts','bad')"),projectWrite:true,assertAuthorization:()=>{if(!allowed)throw new Error('Authorization revoked')}},signal)
    allowed=false;release()
    await expect(pending).rejects.toThrow('Authorization revoked')
    const readonly=await commands.execute(root,request("require('fs').writeFileSync('src/new.ts','bad')"),signal)
    expect(readonly.exitCode).not.toBe(0)
  })
  it('refuses read-only write grants and declined commands, then rebuilds the grant after restart', async () => {
    const { root } = await fixture(), commands = new AgentCommands(), signal = AbortSignal.timeout(15000)
    for (const grant of [{ projectWrite: true }, { approvedWritePaths: ['src'] }]) {
      await expect(commands.execute(root, { ...request(generate), ...grant, filesystemMode: 'full-read-only' }, signal)).rejects.toThrow('cannot receive workspace write permission')
    }
    const declined = new CursorTerminalBridge(root, signal, async () => false, async () => {})
    try {
      await expect(declined.create({ sessionId: 'test', cwd: root, command: 'node', args: ['-e', generate] }, 'test')).rejects.toMatchObject({ userMessage: expect.stringContaining('declined') })
      await expect(readFile(join(root, 'src/api/generated/health-api.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { declined.dispose() }
    // Fresh runner instances never retain a previous command's wider profile.
    const restarted = new AgentCommands()
    expect((await restarted.execute(root, { ...request(generate), projectWrite: true }, signal)).exitCode).toBe(0)
    expect((await new AgentCommands().execute(root, request("require('fs').writeFileSync('src/new.ts','blocked')"), signal)).exitCode).not.toBe(0)
  }, 20000)
  it.each(['ask','advanced','full-access'] as const)('propagates %s through the shared project tools and central approval', async(mode)=>{
    const {root,parent}=await fixture(), workspaces=new WorkspaceService(()=>true), workspace=await workspaces.connect(root)
    const agent=new AgentTools(workspaces,join(parent,'storage')),repository=new ConversationRepository(join(parent,'storage'))
    let result: any,chat!:ChatController
    chat=new ChatController({authorized:id=>workspaces.authorized(id),workspaceOnly:()=>true,changed:vi.fn(),phase:vi.fn(),provider:async()=>({testConnection:async()=>true,async *streamMessage(_messages,options){
      const tools=agent.create(chat,chat.current().id,workspace.id,workspace.name,mode,[],()=>true,chat.current().config.contextSettings)
      result=JSON.parse(await tools.execute('execute_command',{executable:'node',args:['-e',generate],network:false,install_dependencies:false},options!.signal!))
      yield {type:'done'}
    }})},repository)
    chat.addWorkspace(chat.current().id,workspace)
    chat.command({action:'agent-mode',id:chat.current().id,mode,...(mode==='full-access'?{confirmed:true as const}:{})})
    try{
      chat.send({text:'Generate project files'})
      if(mode!=='full-access'){
        await vi.waitFor(()=>expect(chat.snapshot().messages.at(-1)?.execution?.approval).toBeDefined())
        const approval=chat.snapshot().messages.at(-1)!.execution!.approval!
        expect(approval.description).toContain('Source writes: allowed within this project')
        chat.command({action:'agent-approval',id:chat.current().id,approvalId:approval.id,allow:true})
      }
      await vi.waitFor(()=>expect(chat.snapshot().phase).toBe('idle'),{timeout:10000})
      expect(result.result.exitCode,JSON.stringify(result)).toBe(0)
      expect(await readFile(join(root,'src/api/generated/health-api.ts'),'utf8')).toContain('health = 1')
      expect(chat.snapshot().messages.at(-1)?.execution?.permissionDecisions?.[0]?.decision).toBe(mode==='full-access'?'automatic':'manual')
    }finally{chat.dispose();await agent.dispose()}
  },15000)
})
