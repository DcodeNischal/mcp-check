// Keys for the rate limiter. A visitor is keyed by IP. An IPv6 subscriber usually holds a whole /64
// and often a /48, so IPv6 addresses are limited by both: rotating addresses within them doesn't help.

function ipv6Groups(ip: string): string[] {
  const lower = ip.toLowerCase()
  const [head = '', tail = ''] = lower.split('::')
  const h = head ? head.split(':') : []
  const t = lower.includes('::') && tail ? tail.split(':') : []
  return lower.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
}
const prefix = (groups: string[], n: number) => groups.slice(0, n).map((g) => g.replace(/^0+(?=.)/, '')).join(':')

/** The main rate-limit key for a visitor's IP: IPv4 as is, IPv6 by its /64. */
export function rateKey(ip: string | null | undefined): string {
  if (!ip) return 'unknown'
  if (!ip.includes(':')) return ip
  return `${prefix(ipv6Groups(ip), 4)}::/64`
}

/** Every key a visitor is limited under: the address (or /64), and for IPv6 also the /48. */
export function rateKeys(ip: string | null | undefined): string[] {
  if (!ip || !ip.includes(':')) return [rateKey(ip)]
  return [rateKey(ip), `${prefix(ipv6Groups(ip), 3)}::/48`]
}

/** Is this visitor within the limit under every key? `scope` keeps separate budgets apart. */
export async function withinLimit(limiter: RateLimit, ip: string | null | undefined, scope = ''): Promise<boolean> {
  for (const key of rateKeys(ip)) {
    const { success } = await limiter.limit({ key: scope ? `${scope}:${key}` : key })
    if (!success) return false
  }
  return true
}

/** The rate-limit key for a target server: checks against one host are capped across all visitors. */
export function targetKey(url: string): string {
  try {
    return `target:${new URL(url).hostname.toLowerCase().replace(/\.$/, '')}`
  } catch {
    return 'target:invalid'
  }
}
