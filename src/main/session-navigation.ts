import { visibleSessionTabs, type TabsState } from './session-tab-machine.js'

export type SessionNavigationDirection = 'back' | 'forward'

const MAX_VISITS = 100

/** Visit order in the main window, with a linked side chat sharing its parent's entry. */
export class SessionNavigation {
  private visits: string[] = []
  private position = -1

  record(state: TabsState): void {
    const tabId = visibleSessionTabs(state).main?.id
    if (tabId === undefined || this.visits[this.position] === tabId) return
    this.visits = [...this.visits.slice(0, this.position + 1), tabId].slice(-MAX_VISITS)
    this.position = this.visits.length - 1
  }

  canMove(direction: SessionNavigationDirection, available: ReadonlySet<string>): boolean {
    return this.find(direction, available) !== null
  }

  move(direction: SessionNavigationDirection, available: ReadonlySet<string>): string | null {
    const next = this.find(direction, available)
    if (next === null) return null
    this.position = next.index
    return next.tabId
  }

  private find(direction: SessionNavigationDirection, available: ReadonlySet<string>): { index: number; tabId: string } | null {
    const step = direction === 'back' ? -1 : 1
    const current = this.visits[this.position]
    for (let index = this.position + step; index >= 0 && index < this.visits.length; index += step) {
      const tabId = this.visits[index]
      if (tabId !== undefined && tabId !== current && available.has(tabId)) return { index, tabId }
    }
    return null
  }
}
