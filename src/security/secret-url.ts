// Some servers put a secret in the URL path itself (https://mcp.example.com/s/<token>/mcp). Sharing such a
// URL publicly would publish the secret, so reports for URLs that look like they carry one are not listed
// by default.

/** Does any path segment look like a token or key? */
export function looksSecret(url: string): boolean {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    return false
  }
  return path.split('/').some((segment) => {
    const s = decodeURIComponent(segment)
    if (s.length < 20) return false
    const hasLetter = /[a-z]/i.test(s)
    const hasDigit = /\d/.test(s)
    const hexLike = /^[0-9a-f-]{24,}$/i.test(s)
    const tokenLike = /^[A-Za-z0-9_\-.~+=]{20,}$/.test(s) && hasLetter && hasDigit
    return hexLike || tokenLike
  })
}
