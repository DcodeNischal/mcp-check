// Cloudflare Turnstile, rendered explicitly so it can be reset after every request
// (each token works once). Invisible unless Cloudflare needs the visitor to click.
import { onBeforeUnmount, onMounted, ref } from 'vue'

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string
      reset(id: string): void
      remove(id: string): void
    }
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
// Cloudflare's always-pass test key can be set for local builds; production uses the real key.
export const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITEKEY || '0x4AAAAAAGNh1cw0Scr1z3PV'

let loading: Promise<NonNullable<Window['turnstile']>> | undefined
function load() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SCRIPT
    s.async = true
    s.defer = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable')))
    s.onerror = () => {
      loading = undefined
      reject(new Error('Turnstile failed to load'))
    }
    document.head.appendChild(s)
  })
  return loading
}

export function useTurnstile(action: string) {
  const el = ref<HTMLElement | null>(null)
  let widget: string | undefined
  let token = ''
  let waiters: ((t: string) => void)[] = []

  const settle = (t: string) => {
    token = t
    waiters.forEach((w) => w(t))
    waiters = []
  }

  const getToken = (ms = 15_000): Promise<string> =>
    token
      ? Promise.resolve(token)
      : new Promise((resolve) => {
          waiters.push(resolve)
          setTimeout(() => resolve(token), ms)
        })

  const reset = () => {
    token = ''
    if (widget && window.turnstile) window.turnstile.reset(widget)
  }

  onMounted(async () => {
    try {
      const ts = await load()
      if (!el.value) return
      widget = ts.render(el.value, {
        sitekey: SITE_KEY,
        action,
        theme: 'dark',
        size: 'flexible',
        appearance: 'interaction-only',
        callback: settle,
        'expired-callback': () => (token = ''),
        'error-callback': () => (token = ''),
      })
    } catch {
      // Blocked or offline: requests fail verification and the page says so.
    }
  })
  onBeforeUnmount(() => {
    if (widget && window.turnstile) window.turnstile.remove(widget)
  })

  return { el, getToken, reset }
}
