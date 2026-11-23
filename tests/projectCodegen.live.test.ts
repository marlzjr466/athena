// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { CursorTerminalBridge } from '../electron/main/ai/cursorTerminal'
import { WorkspaceService } from '../electron/main/ai/workspaceService'
import { ChatController } from '../electron/main/ai/chatController'
import { ConversationRepository } from '../electron/main/ai/conversationRepository'
vi.mock('../electron/main/logger',()=>({log:vi.fn()}))
// Explicit opt-in: executes only the user's requested generation and verification.
it.runIf(Boolean(process.env.ATHENA_CODEGEN_PROJECT))('generates and verifies the authorized real project through the Cursor bridge and central Full Access approval',async()=>{
 const root=await realpath(process.env.ATHENA_CODEGEN_PROJECT!), storage=await mkdtemp(join(tmpdir(),'athena-codegen-report-'))
 const git=(...args:string[])=>execFileSync('git',['--no-optional-locks',...args],{cwd:root,encoding:'utf8'})
 const statusBefore=git('status','--short'),indexBefore=git('diff','--cached','--binary')
 const generatedDirty=git('status','--porcelain','--','src/api/generated')
 if(!process.env.ATHENA_CODEGEN_VERIFY_ONLY) expect(generatedDirty,'Do not overwrite pre-existing generated-file edits').toBe('')
 const protectedPaths=['contracts/openapi.yaml','src/api/endpoints/endpoints.ts','package.json','src/api/openapi-codegen.config.cjs']
 const hashes=async()=>Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,createHash('sha256').update(await readFile(join(root,p))).digest('hex')])))
 const protectedBefore=await hashes(),health=join(root,'src/api/generated/health-api.ts'),healthBefore=await stat(health)
 const workspaces=new WorkspaceService(()=>true),workspace=await workspaces.connect(root),report:any={root,statusBefore,protectedBefore,commands:[]}
 let chat!:ChatController, failure:unknown
 chat=new ChatController({authorized:id=>workspaces.authorized(id),workspaceOnly:()=>true,changed:vi.fn(),phase:vi.fn(),provider:async()=>({testConnection:async()=>true,async *streamMessage(_messages,options){
  const bridge=new CursorTerminalBridge(root,options!.signal!,options!.requestApproval,async()=>{expect(await workspaces.authorizedRoot(workspace.id)).toBe(root);expect(chat.current().config.agentMode).toBe('full-access')})
  try {
   const commands = [
    ['run','generate:api'],
    ['run','typecheck'],
    ['test','--','--runInBand','--watchman=false','--coverage=false','__tests__/src/api/openapiCodegen.test.ts','__tests__/src/api/openapiContract.test.ts','__tests__/src/api/governance/governanceCertificationReviewApi.test.ts'],
   ]
   if(process.env.ATHENA_CODEGEN_VERIFY_ONLY) commands.shift()

   for(const args of commands) {
    const {terminalId}=await bridge.create({sessionId:'real-codegen',cwd:root,command:'npm',args},'real-codegen')
    const status=await bridge.waitForExit({sessionId:'real-codegen',terminalId},'real-codegen')
    const output=bridge.output({sessionId:'real-codegen',terminalId},'real-codegen')
    report.commands.push({args,status,...output}); console.log(JSON.stringify({args,status,output:output.output}))
    bridge.release({sessionId:'real-codegen',terminalId},'real-codegen')
    if(status.exitCode !== 0) { failure ??= new Error(`Verification failed: npm ${args.join(' ')}`); if(args[1] === 'generate:api') break }
   }
   const code = "const fs=require('fs'),ts=require('typescript');let count=0;for(const f of fs.readdirSync('src/api/generated').filter(f=>f.endsWith('.ts'))){const r=ts.transpileModule(fs.readFileSync('src/api/generated/'+f,'utf8'),{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});if(r.diagnostics.some(d=>d.category===ts.DiagnosticCategory.Error))throw Error(f+' has invalid syntax');count++}console.log('Validated generated TypeScript syntax: '+count+' files')"
   const syntax=await bridge.create({sessionId:'real-codegen',cwd:root,command:'node',args:['-e',code],workspace_write:false},'real-codegen')
   const syntaxStatus=await bridge.waitForExit({sessionId:'real-codegen',terminalId:syntax.terminalId},'real-codegen')
   report.syntax={...syntaxStatus,...bridge.output({sessionId:'real-codegen',terminalId:syntax.terminalId},'real-codegen')}
   console.log(JSON.stringify(report.syntax));expect(syntaxStatus).toMatchObject({exitCode:0})
  }catch(error){failure=error}finally{bridge.dispose()}
  yield {type:'done'}
 }})},new ConversationRepository(storage))
 chat.addWorkspace(chat.current().id,workspace)
 chat.command({action:'agent-mode',id:chat.current().id,mode:'full-access',confirmed:true})
 try{
  expect(chat.send({text:'Run the authorized API generator, typecheck and API tests. Do not commit or stage.'}).ok).toBe(true)
  await vi.waitFor(()=>expect(chat.snapshot().phase).toBe('idle'),{timeout:350000,interval:100})
  report.statusAfter=git('status','--short');report.protectedAfter=await hashes();report.decisions=chat.snapshot().messages.at(-1)?.execution?.permissionDecisions
  expect(report.protectedAfter).toEqual(protectedBefore);expect(git('diff','--cached','--binary')).toBe(indexBefore)
  if(!process.env.ATHENA_CODEGEN_VERIFY_ONLY) expect((await stat(health)).mtimeMs).toBeGreaterThan(healthBefore.mtimeMs)
  expect(await readFile(health,'utf8')).toContain('injectEndpoints')
  report.generatedDiff=git('diff','--stat','--','src/api/generated')
  await mkdir('artifacts/sandbox-codegen',{recursive:true});await writeFile(process.env.ATHENA_CODEGEN_VERIFY_ONLY ? 'artifacts/sandbox-codegen/verification.json' : 'artifacts/sandbox-codegen/real-project.json',JSON.stringify(report,null,2))
  if(failure)throw failure
 }finally{chat.dispose()}
},360000)
