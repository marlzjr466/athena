const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(async () => {
  const icon = readFileSync(join(__dirname, '../public/athena.svg')).toString('base64')
  const window = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const html = `<html><head><style>html,body{margin:0;background:transparent;width:100%;height:100%}img{width:100%;height:100%;display:block}</style></head><body><img src="data:image/svg+xml;base64,${icon}"></body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const image = await window.webContents.capturePage()
  mkdirSync(join(__dirname, '../build'), { recursive: true })
  writeFileSync(join(__dirname, '../build/icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG())
  window.destroy()
  app.quit()
}).catch((error) => { console.error(error); app.exit(1) })
