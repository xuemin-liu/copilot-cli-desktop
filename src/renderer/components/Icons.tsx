import type { JSX } from 'react'

/** 16px stroke icons that follow the button's text colour; decorative, so the button carries the accessible name. */
function Icon({ children }: { children: JSX.Element[] | JSX.Element }): JSX.Element {
  return <svg className="button-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
}

/** Two speech bubbles, one answering the other: fork the conversation into a side chat. (Not a branching line, which is the Git panel's.) */
export function SideChatIcon(): JSX.Element {
  return <Icon>
    <path d="M2 2.5h7.5v4.5H5.2L3.5 8.5V7H2z" />
    <path d="M6.5 9h7.5v4.5h-1.2V15L11 13.5H6.5z" />
  </Icon>
}

/** Crosshair on a box corner: pick an element on the page. */
export function PickElementIcon(): JSX.Element {
  return <Icon>
    <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
    <path d="M8 5.5v5M5.5 8h5" />
  </Icon>
}

/** Camera: attach a screenshot of the page to the prompt. */
export function ScreenshotIcon(): JSX.Element {
  return <Icon>
    <path d="M2.5 5h2.2l1-1.6h4.6l1 1.6h2.2v7.5h-11z" />
    <circle cx="8" cy="8.6" r="2.2" />
  </Icon>
}

/** Terminal prompt with a warning mark: attach console errors to the prompt. */
export function ConsoleErrorsIcon(): JSX.Element {
  return <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M4.5 6l2 2-2 2M8 10.2h3" />
  </Icon>
}

/** Window with an address bar: the debug browser. */
export function BrowserIcon(): JSX.Element {
  return <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M1.75 6h12.5M4 4.4h.01M6 4.4h.01" />
  </Icon>
}

/** Two commits joined to a branch: the Git panel. */
export function GitBranchIcon(): JSX.Element {
  return <Icon>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5.5" r="1.5" />
    <path d="M4.5 5v6M11.5 7c0 3-4.5 2.2-7 4.2" />
  </Icon>
}
