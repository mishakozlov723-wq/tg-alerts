/* Intro animations. playIntro(stageEl, name) -> Promise (resolves when finished; final frame stays on screen) */
;(function () {
  const CSS = `
.in-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;overflow:hidden;font-family:'Outfit','Poppins',sans-serif;color:#f2f2f0}
.in-word{font-weight:200;font-size:54px;letter-spacing:.02em;line-height:1.25;white-space:nowrap;display:flex;position:relative}
.in-mask{display:inline-block;overflow:hidden;padding:.12em .03em;margin:-.12em -.03em}
.in-l{display:inline-block;will-change:transform,opacity,filter}
.in-sub{font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-top:18px;opacity:0;font-weight:300;padding-left:.34em}
.in-line{width:132px;height:1px;background:rgba(255,255,255,.11);margin-top:34px;position:relative;overflow:hidden;opacity:0}
.in-line i{position:absolute;inset:0;background:#fff;transform:translateX(-101%)}
.in-digits{position:absolute;font-weight:200;font-size:64px;letter-spacing:-.02em;font-variant-numeric:tabular-nums;font-feature-settings:'tnum';white-space:nowrap}
.in-small{position:absolute;font-weight:200;font-size:46px;white-space:nowrap}
.in-cut{position:absolute;left:50%;top:50%;height:1px;background:#fff;transform:translate(-50%,-50%) scaleX(0)}
`
  const EASE = 'cubic-bezier(.22,.61,.36,1)'
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const run = (el, kf, o) => el.animate(kf, { fill: 'forwards', easing: EASE, ...o }).finished
  const rnd = (a, b) => a + Math.random() * (b - a)
  const cubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    if (parent) parent.appendChild(e)
    return e
  }

  function buildWord(stage, text, masked) {
    const w = el('div', 'in-word', stage)
    const letters = [...text].map((ch) => {
      const host = masked ? el('span', 'in-mask', w) : w
      return el('span', 'in-l', host, ch === ' ' ? '\u00a0' : ch)
    })
    if (!stage.querySelector('.in-sub')) {
      el('div', 'in-sub', stage, 'EUR \u00b7 GBP \u00b7 DXY')
      el('i', '', el('div', 'in-line', stage))
    }
    return { w, letters }
  }

  // sub-caption + hairline that fills like a progress bar
  async function tail(stage) {
    const sub = stage.querySelector('.in-sub')
    const line = stage.querySelector('.in-line')
    const bar = line.querySelector('i')
    run(sub, [{ opacity: 0 }, { opacity: 1 }], { duration: 1000 })
    await wait(150)
    run(line, [{ opacity: 0 }, { opacity: 1 }], { duration: 700 })
    await run(bar, [{ transform: 'translateX(-101%)' }, { transform: 'translateX(0)' }], { duration: 1200, easing: 'cubic-bezier(.65,0,.35,1)' })
    await wait(100)
  }

  // 1) letters rise from behind an invisible line
  async function lettersRise(stage, withTail = true) {
    const { letters } = buildWord(stage, 'Alerts', true)
    letters.forEach((l) => (l.style.transform = 'translateY(115%)'))
    const ps = letters.map((l, i) =>
      run(l, [{ transform: 'translateY(115%)' }, { transform: 'translateY(0)' }], { duration: 1000, delay: i * 70 }),
    )
    if (withTail) { await wait(750); await Promise.all([Promise.all(ps), tail(stage)]) } else await Promise.all(ps)
  }

  // 2) letters fly in blurred from all around and settle, then the spacing exhales
  async function scatter(stage) {
    const { w, letters } = buildWord(stage, 'Alerts', false)
    w.style.letterSpacing = '.14em'
    letters.forEach((l) => (l.style.opacity = 0))
    const ps = letters.map((l, i) =>
      run(
        l,
        [
          { opacity: 0, filter: 'blur(18px)', transform: `translate(${rnd(-90, 90)}px,${rnd(-70, 70)}px) rotate(${rnd(-14, 14)}deg) scale(1.3)` },
          { opacity: 1, filter: 'blur(0)', transform: 'none' },
        ],
        { duration: 1500, delay: i * 70 },
      ),
    )
    await Promise.all(ps)
    await run(w, [{ letterSpacing: '.14em' }, { letterSpacing: '.02em' }], { duration: 900 })
    await tail(stage)
  }

  // 3) a thin line appears, then opens up and reveals the word
  async function lineOpens(stage) {
    const { w } = buildWord(stage, 'Alerts', false)
    w.style.clipPath = 'inset(50% 0 50% 0)'
    const cut = el('div', 'in-cut', w)
    cut.style.width = '100%'
    await run(cut, [{ transform: 'translate(-50%,-50%) scaleX(0)' }, { transform: 'translate(-50%,-50%) scaleX(1)' }], { duration: 1000, easing: 'cubic-bezier(.65,0,.35,1)' })
    const open = run(w, [{ clipPath: 'inset(50% 0 50% 0)' }, { clipPath: 'inset(-10% 0 -10% 0)' }], { duration: 1300, easing: 'cubic-bezier(.65,0,.35,1)' })
    run(cut, [{ opacity: 1 }, { opacity: 0 }], { duration: 900, delay: 400 })
    await open
    await tail(stage)
  }

  // 4) outline letters appear one by one, then fill with white
  async function outline(stage) {
    const { letters } = buildWord(stage, 'Alerts', false)
    letters.forEach((l) => {
      l.style.webkitTextStroke = '1px #f2f2f0'
      l.style.color = 'transparent'
      l.style.opacity = 0
    })
    await Promise.all(letters.map((l, i) => run(l, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay: i * 120 })))
    await wait(200)
    await Promise.all(letters.map((l, i) => run(l, [{ color: 'transparent' }, { color: '#f2f2f0' }], { duration: 900, delay: i * 70 })))
    await tail(stage)
  }

  // 5a) digits count up like a price, then dissolve upwards (not used by the app any more)
  async function digits(stage) {
    const d = el('div', 'in-digits', stage, '0.00000')
    d.style.opacity = 0
    await run(d, [{ opacity: 0 }, { opacity: 1 }], { duration: 500 })
    const target = 1.085, dur = 1400, t0 = performance.now()
    await new Promise((res) => {
      const step = (now) => {
        const x = Math.min(1, (now - t0) / dur)
        d.textContent = (target * cubic(x)).toFixed(5)
        x < 1 ? requestAnimationFrame(step) : res()
      }
      requestAnimationFrame(step)
    })
    await wait(150)
    await run(d, [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-26px)', filter: 'blur(12px)' }], { duration: 650, easing: 'cubic-bezier(.65,0,.35,1)' })
    d.remove()
  }

  // simple blurred fade of the whole word
  async function blurIn(stage) {
    const { w } = buildWord(stage, 'Alerts', false)
    await run(w, [{ opacity: 0, filter: 'blur(16px)', transform: 'scale(.97)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 1500 })
    await tail(stage)
  }

  // 6) words appear one after another, then collapse into the name
  async function words(stage) {
    for (const t of ['Set.', 'Track.', 'Trade.']) {
      const s = el('div', 'in-small', stage, t)
      await run(s, [{ opacity: 0, transform: 'translateY(18px)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 700 })
      await wait(300)
      await run(s, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-14px)', filter: 'blur(8px)' }], { duration: 500 })
      s.remove()
    }
    await lettersRise(stage)
  }

  const VARIANTS = {
    combo: (s) => lettersRise(s), // app intro: no counting digits, just Alerts + EUR/GBP/DXY + progress line
    letters: (s) => lettersRise(s),
    scatter,
    line: lineOpens,
    outline,
    digits: async (s) => { await digits(s); await blurIn(s) },
    words,
  }

  window.playIntro = async function (stage, name = 'combo') {
    if (!document.getElementById('in-css')) {
      const st = document.createElement('style')
      st.id = 'in-css'
      st.textContent = CSS
      document.head.appendChild(st)
    }
    stage.innerHTML = ''
    if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative'
    stage = el('div', 'in-stage', stage)
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      buildWord(stage, 'Alerts', false)
      return wait(500)
    }
    // make sure the font is ready so letters do not jump while animating
    try { await Promise.race([document.fonts.load('200 54px Outfit'), wait(600)]) } catch (_) {}
    await (VARIANTS[name] || VARIANTS.combo)(stage)
  }
})()
