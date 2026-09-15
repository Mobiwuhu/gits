export type GitUrlIdentity = Readonly<{
  host: string
  path: string
}>

export type GitUrlComparison = Readonly<{
  actual: GitUrlIdentity | null
  expected: GitUrlIdentity | null
  isSameRepository: boolean
  isTransportDifferent: boolean
}>

const scpStylePattern = /^(?:[^@/:\s]+@)?(?<host>[^/:\s]+):(?<path>.+)$/u
const protocolPattern = /^[a-z][a-z\d+.-]*:\/\//iu

export function normalizeGitUrl(value: string): GitUrlIdentity | null {
  const input = value.trim()
  if (input.length === 0) {
    return null
  }

  if (protocolPattern.test(input)) {
    try {
      const parsed = new URL(input)
      const host = normalizeHost(
        parsed.protocol === 'file:'
          ? parsed.hostname || 'file'
          : withPort(parsed.hostname, parsed.port, parsed.protocol)
      )
      const path = normalizePath(parsed.pathname)
      return host !== null && path !== null ? { host, path } : null
    } catch {
      return null
    }
  }

  const scpStyle = scpStylePattern.exec(input)
  if (scpStyle?.groups === undefined) {
    return null
  }

  const host = normalizeHost(scpStyle.groups.host)
  const path = normalizePath(scpStyle.groups.path)
  return host !== null && path !== null ? { host, path } : null
}

export function compareGitUrls(
  expectedValue: string,
  actualValue: string
): GitUrlComparison {
  const expected = normalizeGitUrl(expectedValue)
  const actual = normalizeGitUrl(actualValue)
  const isSameRepository =
    expected !== null &&
    actual !== null &&
    expected.host === actual.host &&
    expected.path === actual.path

  return {
    actual,
    expected,
    isSameRepository,
    isTransportDifferent:
      isSameRepository && expectedValue.trim() !== actualValue.trim(),
  }
}

export function getGitUrlHost(value: string): string | null {
  return normalizeGitUrl(value)?.host ?? null
}

function normalizeHost(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase()
  return host === undefined || host.length === 0 ? null : host
}

function normalizePath(value: string | undefined): string | null {
  let path = value?.trim().replaceAll(/^\/+|\/+$/gu, '')
  if (path === undefined || path.length === 0) {
    return null
  }

  path = path.replace(/\.git$/iu, '').replace(/\/+$/u, '')
  return path.length === 0 ? null : path
}

function withPort(hostname: string, port: string, protocol: string): string {
  if (port.length === 0 || isDefaultPort(port, protocol)) {
    return hostname
  }
  return `${hostname}:${port}`
}

function isDefaultPort(port: string, protocol: string): boolean {
  return (
    (protocol === 'ssh:' && port === '22') ||
    (protocol === 'git:' && port === '9418') ||
    (protocol === 'http:' && port === '80') ||
    (protocol === 'https:' && port === '443')
  )
}
