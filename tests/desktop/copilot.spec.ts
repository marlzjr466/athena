import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('Copilot settings and real unauthenticated runtime work in Electron', async()=>{
  const profile=await mkdtemp(join(tmpdir(),'athena-copilot-desktop-'))
  const app=await electron.launch({...(process.env.ATHENA_PACKAGED_TEST ? {executablePath:process.env.ATHENA_PACKAGED_TEST,args:[`--user-data-dir=${profile}`]} : {args:['.']}),env:{...process.env,ATHENA_TEST_DATA:profile}})
  try {
    expect(await realpath(await app.evaluate(({app})=>app.getPath('userData')))).toBe(await realpath(profile))
    await expect.poll(()=>app.windows().some(p=>p.url().includes('surface=control'))).toBe(true)
    const page=app.windows().find(p=>p.url().includes('surface=control'))!
    await page.getByRole('button',{name:'AI',exact:true}).click()
    await expect(page.getByRole('button',{name:/GitHub Copilot Subscription/})).toBeVisible()
    await page.getByRole('button',{name:/GitHub Copilot Subscription/}).click()
    await expect(page.getByRole('button',{name:'Connect Existing Copilot CLI'})).toBeVisible()
    await expect(page.getByRole('button',{name:'Sign in with GitHub (Browser)'})).toBeVisible()
    if (process.env.ATHENA_COPILOT_LOGIN_TEST === '1') {
      await page.getByRole('button',{name:'Check CLI installation'}).click()
      await expect(page.getByText(/Copilot CLI installation verified/)).toBeVisible({timeout:20000})
      await page.getByRole('button',{name:'Sign in with GitHub (Device Code)'}).click()
      await expect(page.getByRole('button',{name:'Copy code',exact:true})).toBeVisible({timeout:30000})
      await page.getByRole('button',{name:'Cancel GitHub sign-in'}).click()
      await expect(page.getByText(/GitHub sign-in cancelled/)).toBeVisible()
    }
    await page.getByText('Advanced: independent OAuth App accounts',{exact:true}).click()
    await expect(page.getByLabel('GitHub OAuth Client ID')).toBeVisible()
    const runtime=await app.evaluate(async({app},root)=>{
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
      const {CopilotClient,RuntimeConnection}=require(`${app.getAppPath()}/node_modules/@github/copilot-sdk/dist/cjs/index.js`)
      const connection = app.isPackaged ? RuntimeConnection.forStdio({path: `${process.resourcesPath}/app.asar.unpacked/node_modules/@github/copilot-sdk-${process.platform}-${process.arch}/prebuilds/${process.platform}-${process.arch}/copilot-runtime${process.platform === 'win32' ? '.exe' : ''}`}) : undefined
      const client=new CopilotClient({connection,mode:'empty',baseDirectory:root,workingDirectory:root,useLoggedInUser:false,env:{PATH:process.env.PATH,HOME:root},logLevel:'none'})
      try {await client.start();return {status:await client.getStatus(),auth:await client.getAuthStatus()}} finally {await client.stop()}
    },profile)
    expect(runtime.status.protocolVersion).toBe(3)
    expect(runtime.auth.isAuthenticated).toBe(false)
  } finally {await app.close()}
})
