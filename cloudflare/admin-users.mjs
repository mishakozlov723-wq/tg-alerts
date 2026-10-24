// Owner-only Telegram controls. No public HTTP directory and no Access database reads.
export function createUserAdmin({ db, symbols, save, tg, adminId, extraIds = async () => [] }) {
  const admin = /^\d{1,20}$/.test(String(adminId || '')) ? String(adminId) : ''
  const idOK = id => /^\d{1,20}$/.test(String(id || ''))
  const clean = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!db.userProfiles || typeof db.userProfiles !== 'object' || Array.isArray(db.userProfiles)) db.userProfiles = {}
  const profiles = db.userProfiles
  const paid = symbol => Boolean(symbols[symbol]?.premium)
  const label = symbol => symbols[symbol]?.label && symbols[symbol].label !== symbol ? `${symbols[symbol].label} (${symbol})` : symbol
  const owns = (id, symbol) => (db.owned[id] || []).includes(symbol)
  const assets = id => Object.keys(symbols).filter(symbol => !paid(symbol) || owns(id, symbol))
  const authorized = (from, chat) => admin && String(from?.id) === admin && chat?.type === 'private' && String(chat.id) === admin
  async function remember(from) {
    if (!idOK(from?.id)) return
    const id = String(from.id), old = profiles[id] || {}, next = { ...old }
    if ('username' in from || 'first_name' in from) {
      next.username = /^[a-z0-9_]{1,32}$/i.test(from.username || '') ? from.username : ''
      next.name = clean([from.first_name, from.last_name].filter(Boolean).join(' '))
    }
    if (!profiles[id] || next.username !== old.username || next.name !== old.name) {
      profiles[id] = next; await save()
    }
  }
  function name(id) {
    const profile = profiles[id]
    if (profile) return profile.username ? '@' + profile.username : profile.name || id
    const order = Object.values(db.orders).filter(o => String(o.userId) === id).sort((a,b) => (b.ts || 0) - (a.ts || 0))[0]
    return order?.username ? '@' + clean(order.username) : clean(order?.name) || id
  }
  async function ids() {
    return [...new Set([...Object.keys(profiles), ...Object.keys(db.owned), ...Object.keys(db.settings),
      ...db.alerts.map(a => a.userId), ...Object.values(db.orders).map(o => o.userId),
      ...db.events.map(e => e.userId), ...await extraIds()].map(String).filter(idOK))].sort((a,b) => a.length - b.length || a.localeCompare(b))
  }
  async function list(page = 0) {
    const all = await ids(), last = Math.max(0, Math.ceil(all.length / 8) - 1)
    page = Math.min(last, Math.max(0, Number.isSafeInteger(page) ? page : 0))
    const selected = all.slice(page * 8, page * 8 + 8)
    const text = `Пользователи Alerts: ${all.length}\nСтраница ${page + 1}/${last + 1}\n\n` +
      selected.map(id => `${name(id)} · ID ${id}\n${assets(id).join(', ')}`).join('\n\n') +
      '\n\nВыберите пользователя. Базовые EURUSD и GBPUSD не отзываются.'
    const rows = selected.map(id => [{ text: `${name(id)} · ${id}`.slice(0, 100), callback_data: `au:u:${id}:${page}` }])
    const nav = []
    if (page > 0) nav.push({ text: '← Назад', callback_data: `au:l:${page - 1}` })
    nav.push({ text: 'Обновить', callback_data: `au:l:${page}` })
    if (page < last) nav.push({ text: 'Далее →', callback_data: `au:l:${page + 1}` })
    rows.push(nav)
    return { text, reply_markup: { inline_keyboard: rows } }
  }
  function detail(id, page, message = '') {
    const rows = Object.keys(symbols).filter(s => paid(s) && owns(id, s)).map(s => [{ text: `Отозвать ${label(s)}`, callback_data: `au:r:${id}:${s}:${page}` }])
    rows.push([{ text: '← Пользователи', callback_data: `au:l:${page}` }])
    return { text: `${name(id)}\nTelegram ID: ${id}\n\nАктивы:\n${assets(id).map(s => `• ${label(s)}${paid(s) ? '' : ' — базовый'}`).join('\n')}\n\n` +
      (message || 'Отзыв останавливает активные ценовые алерты этого инструмента, не удаляя их. Повторная выдача не возобновляет их автоматически.'), reply_markup: { inline_keyboard: rows } }
  }
  async function revoke(id, list) {
    if (!idOK(id) || !list.length || !list.every(paid)) throw new Error('invalid_quote_revoke')
    db.owned[id] = (db.owned[id] || []).filter(symbol => !list.includes(symbol))
    let paused = 0
    for (const a of db.alerts) if (a.userId === id && list.includes(a.symbol) && a.status === 'active') {
      a.status = 'paused'; a.pausedAt = Date.now(); a.pausedReason = 'access_revoked'; paused++
    }
    await save()
    return paused
  }
  async function command(m) {
    if (!/^\/users(?:@\w+)?(?:\s+\d{1,20})?$/i.test(m.text?.trim() || '')) return false
    if (!authorized(m.from, m.chat)) return true
    const id = m.text.trim().split(/\s+/)[1]
    await tg('sendMessage', { chat_id: admin, ...(id ? detail(id, 0) : await list()) })
    return true
  }
  async function callback(q) {
    if (!q.data?.startsWith('au:')) return false
    const answer = text => tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) })
    if (!authorized(q.from, q.message?.chat)) { await answer('Admin only'); return true }
    const parts = q.data.split(':'), action = parts[1], id = parts[2]
    const page = Number(parts[action === 'l' ? 2 : action === 'u' ? 3 : 4] || 0)
    if (!Number.isSafeInteger(page) || page < 0 || page > 1000000) { await answer('Invalid page'); return true }
    let view
    if (action === 'l' && parts.length === 3) view = await list(page)
    else if (action === 'u' && idOK(id) && parts.length === 4) view = detail(id, page)
    else if (['r','x'].includes(action) && idOK(id) && parts.length === 5) {
      const symbol = parts[3]
      if (!paid(symbol) || !owns(id, symbol)) { await answer('Доступ уже отсутствует или актив базовый'); return true }
      if (action === 'r') view = { text: `Отозвать ${label(symbol)} у ${name(id)} (ID ${id})?\n\nАктивные ценовые алерты этого инструмента будут остановлены, но не удалены.`, reply_markup: { inline_keyboard: [
        [{ text: 'Да, отозвать', callback_data: `au:x:${id}:${symbol}:${page}` }],
        [{ text: 'Отмена', callback_data: `au:u:${id}:${page}` }]] } }
      else {
        const paused = await revoke(id, [symbol])
        view = detail(id, page, `Доступ к ${label(symbol)} отозван. Остановлено алертов: ${paused}. Данные не удалены.`)
      }
    } else { await answer('Invalid action'); return true }
    await answer()
    // A fresh message makes repeated Refresh safe without message-not-modified errors.
    await tg('sendMessage', { chat_id: admin, ...view })
    return true
  }
  return { remember, command, callback, revoke }
}
