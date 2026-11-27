// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ChatController } from '../electron/main/ai/chatController'
import { ScreenCaptureTools } from '../electron/main/screenCapture/screenCaptureTools'
import type { ScreenCapturePlatform } from '../electron/main/screenCapture/screenCapturePlatform'

function setup() {
  let allowed = true, selected = 'session'
  const display = { id: '1', name: 'Display 1', width: 1920, height: 1080 }
  const image = { display, dataURL: 'data:image/jpeg;base64,c2NyZWVu', width: 1600, height: 900, capturedAt: 1000 }
  const platform: ScreenCapturePlatform = { displays: vi.fn(() => [display]), capture: vi.fn(async () => [image]), dispose: vi.fn() }
  const session = { contextCheckpoint: { old: 'checkpoint' } as unknown }
  const chat = { current: () => ({ id: selected, config: { model: 'gpt-4.1', agentMode: 'advanced' } }), getSession: () => session, sessionChanged: vi.fn(), activity: vi.fn(() => 'activity'), finishActivity: vi.fn(), approve: vi.fn<ChatController['approve']>(async () => true), beforeAction: vi.fn(async () => {}) }
  const registry = new ScreenCaptureTools(platform, () => true, () => allowed)
  const tools = registry.create(chat as unknown as ChatController, 'session'), abort = new AbortController()
  const call = (name = 'read_screen', input: unknown = {}) => tools.execute(name, input, abort.signal)
  return { platform, tools, chat, session, registry, abort, call, image, allow: (value: boolean) => { allowed = value }, select: (value: string) => { selected = value } }
}

describe('screen awareness permission and lifetime', () => {
  it('does not capture on construction, registration, or disabled access', async () => {
    const f = setup()
    expect(f.tools.definitions.map(({ name }) => name)).toEqual(['capture_screen', 'read_screen'])
    expect(f.platform.capture).not.toHaveBeenCalled()
    f.allow(false)
    expect(JSON.parse(await f.call()).ok).toBe(false)
    expect(f.chat.approve).not.toHaveBeenCalled(); expect(f.platform.capture).not.toHaveBeenCalled()
  })
  it.each(['changed pixels','revoked permission','outside window','unchanged outcome','verified action'])('checks the live target and outcome for %s',async scenario=>{
    const f=setup(), display={...f.image.display,id:'window:45:0'}, image={...f.image,display,capturedAt:Date.now()}
    const changed={...image,dataURL:'data:image/jpeg;base64,bmV3'}
    f.platform.windows=async()=>[display]
    f.platform.point=vi.fn(async()=>{})
    f.platform.captureWindow=vi.fn().mockResolvedValueOnce([image])
      .mockResolvedValueOnce([scenario==='changed pixels'?changed:image])
      .mockResolvedValue([scenario==='verified action'?changed:image])
    let grant=true
    const tools=f.registry.create(f.chat as unknown as ChatController,'session',{allowed:()=>true,mayPoint:()=>grant})
    const call=(name:string,input:unknown)=>tools.execute(name,input,f.abort.signal)
    const shot=JSON.parse(await call('capture_screen',{windowId:display.id}))
    f.chat.approve.mockImplementation(async()=>{if(scenario==='revoked permission')grant=false;return true})
    const args={app:'calculator',label:'Seven',from:{x:scenario==='outside window'?9999:42,y:24},captureId:shot.captureId}
    if(scenario==='revoked permission')await expect(call('point_at_window',args)).rejects.toThrow(/permission/i)
    else expect(JSON.parse(await call('point_at_window',args)).ok).toBe(scenario==='verified action')
    expect(f.platform.point).toHaveBeenCalledTimes(['unchanged outcome','verified action'].includes(scenario)?1:0)
    if(scenario==='verified action'){
      expect(JSON.parse(await call('point_at_window',args)).ok).toBe(false)
      const verified=await call('verify_window',{})
      expect(tools.formatOutput?.(verified)).toContainEqual({type:'input_image',detail:'high',image_url:changed.dataURL})
      expect(f.chat.approve).toHaveBeenCalledTimes(3)
    }
  })
  it('requires approval even in advanced mode and names the destination and displays', async () => {
    const f = setup()
    vi.mocked(f.chat.approve).mockResolvedValue(false)
    expect(JSON.parse(await f.call()).message).toContain('declined')
    expect(f.chat.approve.mock.calls[0]?.[0]).toMatchObject({ title: 'Capture and share your screens?', description: expect.stringContaining('OpenAI') })
    expect(f.platform.capture).not.toHaveBeenCalled()
    await f.call('capture_screen')
    expect(f.chat.approve).toHaveBeenCalledTimes(1)
  })
  it('uses one capture across both names, yields real image parts only in main, and clears durable checkpoints', async () => {
    const f = setup()
    const output = await f.call()
    expect(output).not.toContain('base64')
    expect(f.tools.formatOutput?.(output)).toContainEqual({ type: 'input_image', detail: 'high', image_url: f.image.dataURL })
    expect(await f.call('capture_screen')).toBe(output)
    expect(f.platform.capture).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.tools.formatOutput?.(output))).not.toContain('base64')
    f.tools.invalidate?.()
    expect(JSON.stringify(f.tools.formatOutput?.(output))).toContain(f.image.dataURL)
    expect(f.session.contextCheckpoint).toBeUndefined(); expect(f.tools.hasEphemeralContext?.()).toBe(true)
    expect(JSON.stringify(f.chat.finishActivity.mock.calls)).not.toContain('base64')
    f.tools.dispose?.()
    expect(f.tools.formatOutput?.(output)).toBeUndefined()
  })
  it('rechecks access after approval before capturing', async () => {
    const f = setup()
    f.chat.approve.mockImplementation(async () => { f.allow(false); return true })
    expect(JSON.parse(await f.call()).message).toContain('changed after approval')
    expect(f.platform.capture).not.toHaveBeenCalled()
  })
  it('discards images if permission changes during capture', async () => {
    const f = setup()
    vi.mocked(f.platform.capture).mockImplementation(async () => { f.allow(false); return [f.image] })
    const output = await f.call()
    expect(JSON.parse(output).message).toContain('discarded')
    expect(f.tools.formatOutput?.(output)).toBeUndefined()
    expect(f.tools.hasEphemeralContext?.()).toBe(false)
    expect(f.chat.finishActivity.mock.calls.every(([, result]) => result.status !== 'running')).toBe(true)
  })
  it('blocks transmission and further provider requests after revocation', async () => {
    const f = setup(), output = await f.call()
    f.allow(false)
    expect(() => f.tools.formatOutput?.(output)).toThrow('disabled')
    expect(() => f.tools.assertAccess()).toThrow('disabled')
  })
  it('rejects stale conversations and cancelled requests', async () => {
    const f = setup(); f.select('other')
    await expect(f.call()).rejects.toThrow('conversation changed')
    f.select('session'); f.abort.abort()
    await expect(f.call()).rejects.toThrow()
    expect(f.platform.capture).not.toHaveBeenCalled()
  })
  it('discards late captures after cancellation', async () => {
    const f = setup()
    vi.mocked(f.platform.capture).mockImplementation(async () => { f.abort.abort(); return [f.image] })
    const output = await f.call()
    expect(JSON.parse(output).message).toContain('cancelled')
    expect(f.tools.formatOutput?.(output)).toBeUndefined()
  })
  it('validates arguments and bounds display count before approval', async () => {
    const f = setup()
    expect(JSON.parse(await f.call('read_screen', { path: '/private' })).ok).toBe(false)
    vi.mocked(f.platform.displays).mockReturnValue(Array(5).fill(f.image.display))
    expect(JSON.parse(await f.call()).message).toContain('1–4')
    expect(f.chat.approve).not.toHaveBeenCalled(); expect(f.platform.capture).not.toHaveBeenCalled()
  })
})
