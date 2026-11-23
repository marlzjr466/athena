import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { inferenceConnectionSchema } from '../shared/thirdPartyInference'

const api = vi.hoisted(() => ({ inferenceConnections: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api, isDesktop: true }))
import { ThirdPartyInferenceSettings } from '../src/features/settings/ThirdPartyInferenceSettings'

it('edits reasoning levels for the chosen model in the existing inference settings', async () => {
  const profile = inferenceConnectionSchema.parse({
    id:'11111111-1111-4111-8111-111111111111',name:'Reasoning gateway',provider:'openai-compatible',protocol:'openai-chat-completions',auth:'api-key',
    baseUrl:'https://example.com/v1',models:[{id:'model-a',configuredCapabilities:{reasoning:true,reasoningEfforts:['high']}},{id:'model-b',configuredCapabilities:{reasoning:true,reasoningEfforts:['low']}}],defaultModel:'model-a',createdAt:1,updatedAt:1,
  })
  api.inferenceConnections.mockImplementation(async (command: {action:string;connection?:typeof profile}) => ({ok:true,message:'Saved',connections:command.action==='save'&&command.connection?[inferenceConnectionSchema.parse({...profile,...command.connection})]:[profile],activeConnectionId:profile.id}))
  render(<ThirdPartyInferenceSettings active />)
  await screen.findByRole('combobox',{name:'Capability model'})
  expect(screen.getByRole('checkbox',{name:'High'})).toBeChecked()
  fireEvent.click(screen.getByRole('combobox',{name:'Capability model'}))
  fireEvent.click(screen.getByRole('option',{name:'model-b'}))
  expect(screen.getByRole('checkbox',{name:'Low'})).toBeChecked()
  fireEvent.click(screen.getByRole('button',{name:'Test this model'}))
  await waitFor(()=>expect(api.inferenceConnections).toHaveBeenCalledWith({action:'test',id:profile.id,model:'model-b'}))
  fireEvent.click(screen.getByRole('checkbox',{name:'High'}))
  await waitFor(()=>expect(api.inferenceConnections).toHaveBeenCalledWith(expect.objectContaining({action:'save',connection:expect.objectContaining({models:expect.arrayContaining([expect.objectContaining({id:'model-b',configuredCapabilities:expect.objectContaining({reasoningEfforts:['low','high']})})])})})))
})
