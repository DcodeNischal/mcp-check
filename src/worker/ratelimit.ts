// Keys for the rate limiter. A visitor is keyed by IP, but an IPv6 subscriber usually holds a whole
// /64, so IPv6 addresses are keyed by their /64: otherwise rotating addresses would mean no limit.

/** The rate-limit key for a visitor's IP: IPv4 as is, IPv6 by its /64. */
export function rateKey(ip: string | null | undefined): string {
  if (!ip) return 'unknown'
  if (!ip.includes(':')) return ip
  const [head = '', tail = ''] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = ip.includes('::') && tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** The rate-limit key for a target server: checks against one host are capped across all visitors. */
export function targetKey(url: string): string {
  try {
    return `target:${new URL(url).hostname}`
  } catch {
    return 'target:invalid'
  }
}
