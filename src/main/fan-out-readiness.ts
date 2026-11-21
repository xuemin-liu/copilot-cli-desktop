/**
 * Whether a fan-out session can take the task in its prompt box:
 * - `ready`: the CLI has drawn its prompt;
 * - `waiting`: it is still starting;
 * - `elsewhere`: it is open in its own window, where the main window cannot paste;
 * - `gone`: it was closed.
 */
export type FanOutReadiness = 'ready' | 'waiting' | 'elsewhere' | 'gone'

/** The CLI's prompt footer. It is on screen once the prompt box takes input. */
const PROMPT_MARK = 'open sidebar'

export function fanOutReadiness(session: { poppedOut: boolean; recentOutput: string } | null): FanOutReadiness {
  if (!session) return 'gone'
  if (session.poppedOut) return 'elsewhere'
  return session.recentOutput.includes(PROMPT_MARK) ? 'ready' : 'waiting'
}
