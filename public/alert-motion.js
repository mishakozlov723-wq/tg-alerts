// Animate layout changes without forced scrolling or replacing backend state.
(() => {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const options = { duration: 460, easing: 'cubic-bezier(.22,1,.36,1)' }
  const running = new WeakMap()
  const stop = el => { for (const a of running.get(el) || []) a.cancel(); running.delete(el) }
  function animate(el, frames, settings = options) {
    const animation = el.animate(frames, settings)
    const group = running.get(el) || []
    group.push(animation); running.set(el, group)
    animation.finished.then(() => {
      const active = (running.get(el) || []).filter(a => a !== animation)
      if (active.length) running.set(el, active); else running.delete(el)
    }, () => {})
    return animation
  }
  const key = row => row.dataset.id || 'empty'
  window.AlertMotion = {
    capture(list) {
      if (!list || reduced() || !list.getClientRects().length) return () => {}
      // Capture visual positions before cancelling our previous animations, so
      // quick updates continue from the current frame instead of jumping back.
      const before = new Map([...list.children].map(el => [key(el), el.getBoundingClientRect()]))
      const height = list.getBoundingClientRect().height
      stop(list); for (const row of list.children) stop(row)
      return () => {
        if (!list.getClientRects().length || reduced()) return
        const nextHeight = list.getBoundingClientRect().height
        if (Math.abs(height - nextHeight) > 1) animate(list, [{ height: `${height}px` }, { height: `${nextHeight}px` }])
        let entering = 0
        for (const row of list.children) {
          const old = before.get(key(row)), next = row.getBoundingClientRect()
          if (old) {
            const moved = Math.abs(old.top - next.top) > 1, resized = Math.abs(old.height - next.height) > 1
            if (moved || resized) animate(row, [
              { transform: `translateY(${old.top - next.top}px)`, height: `${old.height}px`, overflow: 'hidden', minHeight: '0', boxSizing: 'border-box' },
              { transform: 'translateY(0)', height: `${next.height}px`, overflow: 'hidden', minHeight: '0', boxSizing: 'border-box' }
            ])
          } else {
            // Keep the final opacity of triggered/paused rows instead of flashing
            // them fully bright and snapping back to their muted CSS state.
            const opacity = getComputedStyle(row).opacity
            animate(row, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity, transform: 'translateY(0)' }],
              { ...options, delay: Math.min(entering++ * 35, 105), fill: 'backwards' })
          }
        }
      }
    },
    async remove(row) {
      if (!row || reduced() || !row.getClientRects().length) { row?.remove(); return }
      const rect = row.getBoundingClientRect(), style = getComputedStyle(row)
      const from = { opacity: style.opacity, height: `${rect.height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
        borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth }
      stop(row); row.inert = true
      const clip = { overflow: 'hidden', minHeight: '0', boxSizing: 'border-box' }
      const animation = animate(row, [
        { ...clip, ...from },
        { ...clip, ...from, opacity: 0, offset: .32 },
        { ...clip, opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px' }
      ], { ...options, duration: 520, fill: 'forwards' })
      await animation.finished.catch(() => {})
      row.remove(); stop(row)
    }
  }
})()
