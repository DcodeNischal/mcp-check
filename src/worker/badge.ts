// README badges in the familiar shields style: "MCP Check | A · 95".

const COLORS: Record<string, string> = { A: '#10b981', B: '#65a30d', C: '#d97706', D: '#ea580c', F: '#e11d48' }

// Approximate width of 11px Verdana, which badges are traditionally set in.
const width = (text: string) => Math.round([...text].reduce((w, ch) => w + (/[A-Z0-9]/.test(ch) ? 7.4 : /[·\s]/.test(ch) ? 3.6 : 6.3), 0)) + 12

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)

export function badgeSvg(value: string, color: string, label = 'MCP Check'): string {
  const lw = width(label)
  const vw = width(value)
  const total = lw + vw
  const title = escapeXml(`${label}: ${value}`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${title}"><title>${title}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#222"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text><text x="${lw / 2}" y="14">${escapeXml(label)}</text>
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text><text x="${lw + vw / 2}" y="14">${escapeXml(value)}</text>
</g></svg>`
}

export function gradeBadge(grade: string, score: number, partial: boolean): string {
  return badgeSvg(`${grade} · ${score}${partial ? '*' : ''}`, COLORS[grade] ?? '#6b7280')
}

export const unknownBadge = () => badgeSvg('not checked', '#6b7280')
