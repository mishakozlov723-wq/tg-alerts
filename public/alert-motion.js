// Animate layout changes without forced scrolling or replacing backend state.
(() => {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const options = { duration: 300, easing: 'cubic-bezier(.22,.61,.36,1)' }
  window.AlertMotion = {
    capture(list) {
      if (!list || reduced() || !list.getClientRects().length) return () => {}
      const before = new Map([...list.children].map(el => [el.dataset.id, el.getBoundingClientRect()]))
      const height = list.getBoundingClientRect().height
      return () => {
        if (!list.getClientRects().length) return
        const nextHeight = list.getBoundingClientRect().height
        if (height !== nextHeight) list.animate([{ height: `${height}px` }, { height: `${nextHeight}px` }], options)
        for (const row of list.children) {
          const old = before.get(row.dataset.id), next = row.getBoundingClientRect()
          if (old && Math.abs(old.top - next.top) > 1) row.animate([{ transform: `translateY(${old.top - next.top}px)` }, { transform: 'translateY(0)' }], options)
          else if (!old) row.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], options)
        }
      }
    },
    async remove(row) {
      if (!row || reduced() || !row.getClientRects().length) { row?.remove(); return }
      row.inert = true
      await row.animate([
        { opacity: 1, height: `${row.getBoundingClientRect().height}px`, paddingTop: '22px', paddingBottom: '22px' },
        { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px', overflow: 'hidden' }
      ], { ...options, fill: 'forwards' }).finished.catch(() => {})
      row.remove()
    }
  }
})()
