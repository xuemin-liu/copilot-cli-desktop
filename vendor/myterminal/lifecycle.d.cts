export function createBellNotifier(options: { focused(): boolean; notify(title: string, body: string): void; label(): string; now?: () => number }): (data: string) => void
export function createReconnectController(options: { connect(): void; changed?(remaining: number | null): void; exhausted?(): void; attempts?: { current: number }; timers?: { setInterval(callback: () => void, ms: number): unknown; clearInterval(handle: unknown): void } }): {
  readonly remaining: number | null
  readonly attempts: number
  readonly exhausted: boolean
  schedule(): void
  connected(): void
  cancel(): void
  dispose(): void
}
