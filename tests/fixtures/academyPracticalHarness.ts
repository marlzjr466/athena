import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { AcademyService } from '../../electron/main/ai/academyService'
import { academyCommandSchema } from '../../shared/academy'

const directory = process.env.ATHENA_ACADEMY_FIXTURE_DIR
if (!directory) throw new Error('An isolated Academy test directory is required.')
app.setPath('userData', join(directory, 'electron-profile'))
let requests = 0
const model = { name: 'qwen2.5-coder:3b', digest: 'fixture-v1', size: 1, capabilities: ['completion'] }
const service = new AcademyService(directory, {
  modelDetails: async () => model,
  call: async (_endpoint, body) => {
    requests++
    const prompt = (body as { messages: Array<{ content: string }> }).messages[0].content
    const content = prompt.includes('sum of the numbers') ? '```js\nfunction solve(values) { return values.reduce((a,b)=>a+b,0) }\n```' : '"2, 5"'
    return new Response(JSON.stringify({ message: { content } }))
  },
})
ipcMain.handle('academy-test:snapshot', () => service.snapshot())
ipcMain.handle('academy-test:request-count', () => requests)
ipcMain.handle('academy-test:command', async (_event, input) => {
  const command = academyCommandSchema.parse(input)
  if (!('model' in command) || command.model !== model.name) throw new Error('Fixture model only.')
  if (command.action === 'retry-course-exercise') await service.retryCourseExercise(model, command.courseId, command.resultId, command.exerciseId)
  else if (command.action === 'course-stage' && command.stage === 'practical') await service.courseStage(model, command.courseId, command.stage, command.threshold)
  else throw new Error('Unsupported fixture operation.')
  return service.snapshot()
})
app.on('window-all-closed', () => app.quit())
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1400, height: 1000, webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadFile(join(directory, 'index.html'))
})
