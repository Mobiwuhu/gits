import { createInterface } from 'node:readline/promises'

import type { RouteContext } from './route-runtime.js'

export async function confirmAction(
  context: RouteContext,
  alreadyConfirmed: boolean,
  message: string,
): Promise<boolean> {
  if (alreadyConfirmed) return true
  if (context.agent) return false
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(`${message} [y/N] `)
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    prompt.close()
  }
}
