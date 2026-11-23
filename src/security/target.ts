// Which URLs the checker is allowed to contact. The Worker checks every URL a user enters, and
// every URL a server hands back (OAuth metadata, SSE endpoints), so neither can point us at
// internal addresses. The CLI relaxes this so developers can check servers on localhost.

export interface TargetPolicy {
  /** Allow http:// and private/loopback hosts (CLI only). */
  allowLocal?: boolean
}

export type TargetVerdict = { ok: true; url: URL } | { ok: false; reason: string }

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp']

// Hosts the deployment keeps out of reach (its own zone), except the ones listed as allowed. Set once
// by the Worker at startup; the CLI never sets it.
let reserved: { zone: string; allow: Set<string> } | undefined
export function reserveZone(zone: string, allow: string[] = []): void {
  reserved = { zone: zone.toLowerCase(), allow: new Set(allow.map((h) => h.toLowerCase())) }
}

export function checkTarget(raw: string, policy: TargetPolicy = {}): TargetVerdict {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' }
  }
  if (url.username || url.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed. Use the token field instead.' }
  if (policy.allowLocal) {
    return url.protocol === 'https:' || url.protocol === 'http:' ? { ok: true, url } : { ok: false, reason: 'Only http and https URLs are supported.' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Only https:// URLs can be checked online. Use the CLI for local servers.' }
  if (url.port && url.port !== '443') return { ok: false, reason: 'Only the standard HTTPS port (443) can be checked online.' }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isIpLiteral(host)) {
    return isPrivateIp(host) ? { ok: false, reason: 'Private and reserved IP addresses can only be checked with the CLI.' } : { ok: true, url }
  }
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    return { ok: false, reason: 'Local and internal hostnames can only be checked with the CLI.' }
  }
  if (reserved && (host === reserved.zone || host.endsWith(`.${reserved.zone}`)) && !reserved.allow.has(host)) {
    return { ok: false, reason: "This host can't be checked from here." }
  }
  return { ok: true, url }
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')
}

export function isPrivateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/) ?? h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  // IPv6: loopback, unspecified, IPv4-compatible and IPv4-mapped (::/96, ::ffff:0:0/96), NAT64,
  // 6to4, unique-local, link-local, site-local and multicast.
  return h === '::1' || h === '::' || /^::[0-9a-f]/.test(h) || h.startsWith('64:ff9b:') || h.startsWith('2002:') ||
    /^f[cd]/.test(h) || /^fe[89a-f]/.test(h) || /^ff/.test(h)
}
