# Alerts interaction refinements

- Saved chart levels are not draggable until explicitly selected by a tap/click or the existing-alert picker. Only the current selected draft is editable; other saved levels remain fixed. Save performs the existing server-side mutation; Cancel does not save.
- Crosshair lines and their axis labels are hidden. Native touch tracking still supplies the price for creating a new draft. Pan, pinch, price-axis scaling and actual broker quotes remain unchanged.
- The chart + has explicit positioning and geometric centering, a smaller desktop icon and the existing mobile touch target. Its SVG mask is cleared to avoid conflicting with the global icon stylesheet.
- Optional notification text is available directly below the create/edit actions, including the manual form. Existing server validation and the Alerts-tab note editor are retained.
- The chart ticket expands/collapses using an animated real grid track; deleting a list row has an exit animation. Reduced-motion preferences are respected.
- H4 dependent settings are dimmed, inert and disabled while the master is off. The master and error retry remain usable. Failed saves restore the previous state. If no valid selection has ever been saved, explicitly enabling H4 uses EUR/USD and candle-close delivery so the user can then customize it; it never enables itself on load.
- The intro finishes before access-code entry appears. Authentication waits for the intro, not for protected app readiness, avoiding a deadlock. A 15-second safety fallback handles a stuck/missing intro.
- Empty code field: Paste. Six-digit code: Sign in, with a smooth visual transition. Clipboard reads happen only on a user gesture; browser clipboard is preferred, Telegram clipboard is a fallback when supported, and manual paste/typing always remains available. Codes animate visually without auto-submission or logging. Typing cancels stale animations.

## Companion Access change

`retocker-access` must also ship `fix/alerts-session-96h`. Access issues Alerts tokens with an exact 96-hour signed lifetime, independent of the existing global session setting. Calendar/login/code TTLs are unchanged. The Alerts app still verifies the server-issued token; it does not extend a token in localStorage.

Existing 24-hour tokens are **not** retroactively extended. The next successful code login receives the new lifetime. Clearing app/browser storage, using another device/WebView, or losing persistent storage can require login sooner. Clipboard support/permissions still depend on Telegram and the device.

## Checks

```sh
node --test test/access-gate.test.js test/chart-ui.test.js test/notes-ui.test.js
# Local-only browser fixture; requires playwright-core and Chromium:
CHROMIUM_PATH=/path/to/chromium node test/refinements-browser.mjs
```

The browser fixture runs the real chart library and `index.html` exactly as served (no runtime HTML transforms), but uses synthetic APIs, clipboard values and identities. It covers desktop and touch-emulated mobile layouts, not physical iOS/Android Telegram or production brokers. The rest of the server/network test suite was not run as part of this isolated UI verification.

Status: merged into `main` and deployed to Cloudflare Workers (production branch `main`, auto-deploy on every push). Render is no longer used.
