import {fireEvent,render,screen} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {AutomationPermissionsSettings} from '../src/features/settings/AutomationPermissionsSettings'
import {useAthena} from '../src/store/athenaStore'
import {defaultSettings} from '../shared/settings'
import type {Snapshot} from '../shared/contracts'

vi.mock('../src/services/desktop',()=>({desktop:{computerUseCheck:vi.fn(async()=>({}))}}))

it.each(['native','codex'] as const)('shows the standing chat and voice search permission with %s selected for voice',engine=>{
  const settings={...defaultSettings,applicationAutomation:{...defaultSettings.applicationAutomation,engine}}
  const update=vi.fn(async()=>{})
  useAthena.setState({snapshot:{settings} as Snapshot,update})
  const view=render(<AutomationPermissionsSettings/>)
  try{
    const toggle=screen.getByRole('switch',{name:'Allow routine browser searches'})
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/Codex chat or by voice.*site or tab you name.*share its controls with Codex.*Screenshots and sensitive actions require separate approval/)).toBeVisible()
    fireEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({computerUse:{...defaultSettings.computerUse,handsFreeBrowserSearches:true}})
  }finally{view.unmount()}
})
