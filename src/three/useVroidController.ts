import { useLayoutEffect, useRef } from 'react'
import { VroidAnimationController } from './vroidAnimation'
import type { VroidInstance } from './vroidAssets'

/** Allocate in effect setup, not useMemo: StrictMode replays cleanup/setup
 * without recreating memoized values. A disposed mixer must never be reused. */
export function useVroidController(instance: VroidInstance) {
  const controller = useRef<VroidAnimationController | null>(null)
  useLayoutEffect(() => {
    const current = new VroidAnimationController(instance)
    controller.current = current
    return () => {
      controller.current = null
      current.dispose()
    }
  }, [instance])
  return controller
}
