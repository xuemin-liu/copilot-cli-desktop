interface ParsedCopilotVersion {
  core: [number, number, number]
  prerelease: string[] | null
}

function parseCopilotVersion(value: string): ParsedCopilotVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (!match) return null
  const core = match.slice(1, 4).map(Number) as [number, number, number]
  if (core.some((part) => !Number.isSafeInteger(part))) return null
  return { core, prerelease: match[4]?.split('.') ?? null }
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return Math.sign(left.localeCompare(right))
}

export function compareCopilotVersions(left: string, right: string): number | null {
  const parsedLeft = parseCopilotVersion(left)
  const parsedRight = parseCopilotVersion(right)
  if (!parsedLeft || !parsedRight) return null
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const comparison = Math.sign(parsedLeft.core[index]! - parsedRight.core[index]!)
    if (comparison !== 0) return comparison
  }
  if (parsedLeft.prerelease === null) return parsedRight.prerelease === null ? 0 : 1
  if (parsedRight.prerelease === null) return -1
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index]
    const rightPart = parsedRight.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const comparison = comparePrereleasePart(leftPart, rightPart)
    if (comparison !== 0) return comparison
  }
  return 0
}

export function isCopilotVersionOutdated(sessionVersion: string | null, installedVersion: string | null): boolean {
  if (!sessionVersion || !installedVersion) return false
  return compareCopilotVersions(sessionVersion, installedVersion) === -1
}
