/** Bounds the whole cleanup chain, including a stuck session, config write, or diagnostic sink. */
export async function withShutdownDeadline(work: Promise<unknown>, timeoutMs = 30_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Shutdown cleanup deadline exceeded; committed data is retained')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
