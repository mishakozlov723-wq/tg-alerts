// RetockerAssets custom emoji. Resolve through the bot's runtime token, never a source-code secret.
// This helper is used only by the interactive My alerts list, not delivery queues.
export function createAlertIcons(api) {
  let cachedId = '', retryAt = 0, pending = null, disabled = false
  const diagnostics = { version: 2, stage: 'idle', reason: '', resolved: false, lastDelivery: 'none', detail: '' }
  const reason = e => /premium|not enough rights|not allowed|forbidden/i.test(e.telegramDescription || '') ? 'telegram_permissions' : /emoji|sticker/i.test(e.telegramDescription || '') ? 'telegram_emoji_rejected' : e.telegramCode ? 'telegram_http_' + e.telegramCode : 'lookup_or_network_failed'
  async function emojiId() {
    if (disabled) return ''
    if (cachedId) return cachedId
    if (Date.now() < retryAt) return ''
    if (!pending) pending = (async () => {
      try {
        diagnostics.stage = 'pack_lookup'
        const data = await api('getStickerSet', { name: 'RetockerAssets' }, 5000)
        const id = data.result?.sticker_type === 'custom_emoji' && data.result.stickers?.[0]?.custom_emoji_id
        if (typeof id === 'string' && /^\d+$/.test(id)) { cachedId = id; diagnostics.resolved = true; diagnostics.stage = 'pack_ready'; diagnostics.reason = '' }
        else { retryAt = Date.now() + 300000; diagnostics.reason = 'unexpected_pack_format'; diagnostics.detail = 'type=' + String(data.result?.sticker_type) + ', stickers=' + String(data.result?.stickers?.length) + ', emojiIdPresent=' + Boolean(data.result?.stickers?.[0]?.custom_emoji_id); diagnostics.stage = 'pack_failed' }
      } catch (e) { retryAt = Date.now() + 300000; diagnostics.reason = reason(e); diagnostics.detail = String(e.telegramDescription || e.message || '').slice(0, 240); diagnostics.stage = 'pack_failed' }
      finally { pending = null }
      return cachedId
    })()
    return pending
  }
  function decorate(plain, assets, id) {
    // Only list rows we generated receive icons. Notes may contain newlines or emoji.
    const keyboard = plain.reply_markup?.inline_keyboard
    if (!id || !assets.some(a => a.symbol === 'EURUSD') || !keyboard) return plain
    const text = plain.text, entities = [], inserts = []
    // The exact row string lives in its corresponding delete button, except for its leading cross.
    let cursor = text.indexOf('\n\n') + 2
    assets.forEach((asset, i) => {
      const buttonText = keyboard[i]?.[0]?.text || ''
      const stem = `${i + 1}. ${buttonText.replace(/^✕ /, '')}${asset.note ? ' · ' + asset.note : ''}`
      const at = text.indexOf(stem, cursor)
      if (at < 0) return
      cursor = at + stem.length
      if (asset.symbol === 'EURUSD') inserts.push(at + `${i + 1}. `.length)
    })
    let result = '', offset = 0
    for (const at of inserts) {
      result += text.slice(offset, at)
      entities.push({ type: 'custom_emoji', offset: result.length, length: 2, custom_emoji_id: id })
      result += '💶 '; offset = at
    }
    result += text.slice(offset)
    const inline_keyboard = keyboard.map((row, i) => row.map(button => assets[i]?.symbol === 'EURUSD' ? { ...button, icon_custom_emoji_id: id } : { ...button }))
    return { ...plain, text: result, ...(entities.length ? { entities } : {}), reply_markup: { ...plain.reply_markup, inline_keyboard } }
  }
  async function send(method, fields, plain, assets) {
    const id = assets.some(a => a.symbol === 'EURUSD') ? await emojiId() : ''
    const view = decorate(plain, assets, id)
    try { const result = await api(method, { ...fields, ...view }); diagnostics.lastDelivery = view === plain ? 'plain' : 'custom_emoji_accepted'; return result }
    catch (e) {
      // Retry without decoration ONLY after an explicit 400 rejection: the first message was not accepted.
      // Never retry on timeout, unknown outcome, rate limit or server failure.
      if (view === plain || !e.definite || Number(e.telegramCode) !== 400 || e.retrySafe) throw e
      diagnostics.reason = reason(e); diagnostics.detail = String(e.telegramDescription || e.message || '').slice(0, 240); diagnostics.lastDelivery = 'custom_emoji_rejected'; disabled = true
      return api(method, { ...fields, ...plain })
    }
  }
  async function test(chatId) {
    // Called only after the owner explicitly sends /emoji_test in their private bot chat.
    disabled = false; retryAt = 0
    const plain = { text: 'EURUSD icon test:\n\n1. EURUSD ◇ 1.00000', reply_markup: { inline_keyboard: [[{ text: '✕ EURUSD ◇ 1.00000', url: 'https://t.me/addemoji/RetockerAssets' }]] } }
    await send('sendMessage', { chat_id: chatId }, plain, [{ symbol: 'EURUSD' }])
    const report = `Emoji check: ${diagnostics.lastDelivery}\nPack: ${diagnostics.resolved ? 'resolved' : 'not resolved'}\n${diagnostics.reason}${diagnostics.detail ? '\n' + diagnostics.detail : ''}`
    return api('sendMessage', { chat_id: chatId, text: report })
  }
  return { send, test }
}
