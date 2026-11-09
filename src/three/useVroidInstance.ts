import { useCallback, useEffect, useRef, useState } from 'react'
import { disposeVroid, loadVroidInstance, type VroidInstance } from './vroidAssets'
import { VROID_ACTIONS } from '../../shared/vroidActions'
import { desktop } from '../services/desktop'

/** Canvas-local models: keep the outgoing scene until the transition swaps at
 * zero opacity, including VRM → another imported VRM. */
export function useVroidInstance(active: boolean, thumbnail = false, modelId = 'vroid-athena') {
  const [instance, setInstance] = useState<VroidInstance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const models = useRef(new Map<string, VroidInstance>())
  const generation = useRef(0)
  const release = useCallback(() => {
    generation.current++
    models.current.forEach(value => disposeVroid(value.vrm)); models.current.clear()
    setInstance(null); setStatus('idle')
  }, [])
  const displayed = useCallback((id: string) => {
    for (const [key, value] of models.current) if (key !== id && key !== modelId) { disposeVroid(value.vrm); models.current.delete(key) }
  }, [modelId])
  useEffect(() => {
    if (!active) return
    const run = ++generation.current
    setError(null)
    const cached = models.current.get(modelId)
    setInstance(cached ?? null)
    const register = (result: VroidInstance) => {
      if (!thumbnail && desktop.registerVroidAnimations) void desktop.registerVroidAnimations(VROID_ACTIONS.map(({ id }) => ({ id, duration: result.clips?.[id]?.duration, error: result.animationErrors?.[id] })), modelId).catch(cause => {
        if (generation.current === run) setError(`Animation synchronization unavailable: ${String(cause)}`)
      })
    }
    if (cached) { setStatus('ready'); register(cached); return }
    void loadVroidInstance(thumbnail, stage => { if (generation.current === run) setStatus(stage) }, modelId).then(result => {
      if (generation.current !== run) { disposeVroid(result.vrm); return }
      models.current.set(modelId, result); setInstance(result); setStatus('ready')
      register(result)
    }).catch(cause => {
      if (generation.current !== run) return
      setStatus('error'); setError(cause instanceof Error ? cause.message : 'The model could not be loaded.')
    })
    return () => { generation.current++ }
  }, [active, thumbnail, modelId])
  useEffect(() => () => {
    generation.current++
    models.current.forEach(value => disposeVroid(value.vrm)); models.current.clear()
  }, [])
  return { instance: models.current.get(modelId) === instance ? instance : null, error, release, status, getInstance: (id: string) => models.current.get(id), displayed }
}
