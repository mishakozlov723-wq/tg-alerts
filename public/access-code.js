// UI only. Read clipboard only after a user gesture; never log or auto-submit codes.
(() => {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const clean = value => String(value || '').replace(/\s/g, '')
  window.AccessCode = { bind({ form, input, status, tg, submit }) {
    const action = document.getElementById('accessAction'), digits = document.getElementById('accessDigits')
    let busy = false, pasting = false, epoch = 0, animations = []
    function update() {
      const filled = input.value.length > 0
      action.dataset.filled = String(filled)
      action.type = filled ? 'submit' : 'button'
      action.setAttribute('aria-label', filled ? 'Sign in' : 'Paste access code')
      action.disabled = busy || pasting || (filled && !/^\d{6}$/.test(input.value))
      form.setAttribute('aria-busy', String(busy || pasting))
      input.readOnly = busy
    }
    function cancel() {
      epoch++; animations.forEach(a => a.cancel()); animations = []
      digits.replaceChildren(); input.classList.remove('is-animating'); pasting = false
    }
    async function insert(raw) {
      const code = clean(raw)
      if (!/^\d{6}$/.test(code)) { status.textContent = 'Copy the six-digit Alerts code, or enter it manually.'; return }
      cancel(); const version = epoch
      input.value = code; status.textContent = ''; pasting = true; update()
      if (!reduced()) {
        input.classList.add('is-animating')
        for (const [index, digit] of [...code].entries()) {
          const span = document.createElement('span'); span.textContent = digit; digits.append(span)
          animations.push(span.animate([
            { opacity: 0, transform: 'translateY(9px)', filter: 'blur(5px)' },
            { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }
          ], { duration: 260, delay: index * 45, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' }))
        }
        await Promise.allSettled(animations.map(a => a.finished))
      }
      if (version !== epoch) return
      animations.forEach(a => a.cancel()); animations = []; digits.replaceChildren()
      input.classList.remove('is-animating'); pasting = false; update()
    }
    const deadline = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard_unavailable')), 2500))])
    async function paste() {
      if (busy || pasting) return
      cancel(); const version = epoch; pasting = true; status.textContent = ''; update()
      try {
        let text
        try {
          if (!navigator.clipboard?.readText) throw new Error('clipboard_unavailable')
          text = await deadline(navigator.clipboard.readText())
        } catch {
          if (!tg?.isVersionAtLeast?.('6.4') || !tg?.readTextFromClipboard) throw new Error('clipboard_unavailable')
          text = await deadline(new Promise((resolve, reject) => {
            try { tg.readTextFromClipboard(value => value == null ? reject(new Error('clipboard_unavailable')) : resolve(value)) } catch (e) { reject(e) }
          }))
        }
        if (version === epoch) { pasting = false; await insert(text) }
      } catch {
        if (version === epoch) { pasting = false; status.textContent = 'Clipboard unavailable. Tap the field and paste or type the code manually.'; input.focus({ preventScroll: true }) }
      } finally { if (version === epoch) { pasting = false; update() } }
    }
    input.addEventListener('paste', event => {
      if (busy) { event.preventDefault(); return }
      const code = clean(event.clipboardData?.getData('text'))
      if (/^\d{6}$/.test(code)) { event.preventDefault(); insert(code) }
    })
    input.addEventListener('input', event => {
      cancel(); input.value = input.value.replace(/\D/g, '').slice(0, 6); status.textContent = ''; update()
      if (input.value.length === 6 && event.inputType !== 'insertText') insert(input.value)
    })
    action.addEventListener('click', () => { if (!input.value) paste() })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || pasting) return
      if (!input.value) { paste(); return }
      if (/^\d{6}$/.test(input.value)) submit()
      else status.textContent = 'Enter the 6-digit code.'
    })
    update()
    return {
      setBusy(value) { busy = value; update() },
      reset() { cancel(); input.value = ''; status.textContent = ''; update() }
    }
  } }
})()
