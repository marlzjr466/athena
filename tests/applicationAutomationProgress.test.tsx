import { render, screen, fireEvent } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ApplicationAutomationProgress } from '../src/features/chat/ApplicationAutomationProgress'
import { desktop } from '../src/services/desktop'
import type { AutomationProgress } from '../shared/automation'

it('shows the active engine and sends controls only for the displayed task',()=>{
  const control=vi.spyOn(desktop,'computerUseCheck').mockResolvedValue({browser:'',locked:false,recent:[]})
  const task:AutomationProgress={id:'active-task',phase:'running',task:'Inspecting a control',engine:'OpenAI',application:'Calculator',steps:[],
    startedAt:Date.now(),updatedAt:Date.now(),verifiedSteps:1,apiRequests:2}
  const view=render(<ApplicationAutomationProgress progress={task}/>)
  expect(screen.getByText(/OpenAI · Calculator/)).toHaveTextContent('2 API requests')
  fireEvent.click(screen.getByRole('button',{name:'Pause'}))
  view.rerender(<ApplicationAutomationProgress progress={{...task,paused:true}}/>)
  fireEvent.click(screen.getByRole('button',{name:'Resume'}))
  fireEvent.click(screen.getByRole('button',{name:'Stop'}))
  expect(control.mock.calls.map(([command])=>command)).toEqual(['pause','resume','stop'].map(action=>({taskId:'active-task',action})))
  view.rerender(<ApplicationAutomationProgress progress={{...task,phase:'complete'}}/>)
  expect(screen.queryByRole('button')).toBeNull()
  control.mockRestore()
})
