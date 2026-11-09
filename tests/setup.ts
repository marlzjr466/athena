import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom has no Element.scrollTo; chat's frame-scheduled follow-to-bottom uses it.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) Object.defineProperty(Element.prototype, 'scrollTo', {
  configurable: true,
  value(this: Element, options: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === 'number' ? y ?? 0 : options.top ?? this.scrollTop
  },
})

afterEach(cleanup)
