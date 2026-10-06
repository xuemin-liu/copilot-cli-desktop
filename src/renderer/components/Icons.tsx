import type { JSX } from 'react'

/** 16px stroke icons that follow the button's text colour; decorative, so the button carries the accessible name. */
function Icon({ children }: { children: JSX.Element[] | JSX.Element }): JSX.Element {
  return <svg className="button-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
}

/** Branching line: fork the conversation into a side chat. */
export function ForkIcon(): JSX.Element {
  return <Icon>
    <circle cx="4" cy="3.5" r="1.5" />
    <circle cx="4" cy="12.5" r="1.5" />
    <circle cx="12" cy="5.5" r="1.5" />
    <path d="M4 5v6M12 7c0 2.5-3 2.5-8 4" />
  </Icon>
}

/** Crosshair on a box corner: pick an element on the page. */
export function PickElementIcon(): JSX.Element {
  return <Icon>
    <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
    <path d="M8 5.5v5M5.5 8h5" />
  </Icon>
}

/** Window with an address bar: the debug browser. */
export function BrowserIcon(): JSX.Element {
  return <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M1.75 6h12.5M4 4.4h.01M6 4.4h.01" />
  </Icon>
}
