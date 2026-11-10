import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const code = read('../public/price-chart.js'), html = read('../public/index.html'), css = read('../public/price-chart.css')

test('+ keeps tracking under the pointer and a drag on + never opens the ticket', () => {
 assert.match(code, /plus\.addEventListener\('pointermove'/)
 assert.match(code, /plusSkipClick = plusDrag\.moved/)
 assert.match(code, /if \(plusSkipClick\) \{ plusSkipClick = false; return \}/)
 // Touch drag on + must not pan the page before pointer capture.
 assert.match(css, /#chartPlus\{[^}]*touch-action:none/)
})

test('hover level is dashed like a crosshair; picked level turns solid', () => {
 assert.match(code, /const lineStyle = title \? 0 : 2/)
})

test('full-screen toggle: button, body layer, placeholder, Esc/Telegram back, reduced motion, no page zoom', () => {
 assert.match(html, /<button id="chartExpand" class="chart-action" type="button" aria-label="Full screen chart" aria-pressed="false"/)
 assert.match(code, /document\.body\.append\(section\)/)
 assert.match(code, /placeholder\.replaceWith\(section\)/)
 assert.match(code, /e\.key === 'Escape'/)
 assert.match(code, /BackButton/)
 assert.match(code, /prefers-reduced-motion: reduce/)
 assert.match(code, /'gesturestart'/)
 assert.match(css, /#gbpChart\.is-expanded\{position:fixed;inset:0;z-index:8;/)
 assert.match(css, /touch-action:pan-y/)
 // Leaving the chart asset collapses full screen first.
 assert.match(code, /if \(!active\) \{ generation\+\+; touchActive = false; setExpanded\(false\)/)
})
