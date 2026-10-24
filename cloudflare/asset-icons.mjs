// RetockerAssets custom emoji. Resolve through the bot's runtime token, never a source-code secret.
// This helper is used only by the interactive My alerts list, not delivery queues.
export function createAlertIcons(api) {
  let cachedId = '', retryAt = 0, pending = null, disabled = false
  async function emojiId() {
    if (disabled) return ''
    if (cachedId) return cachedId
    if (Date.now() < retryAt) return ''
    if (!pending) pending = (async () => {
      try {
        const data = await api('getStickerSet', { name: 'RetockerAssets' }, 5000)
        const id = data.result?.sticker_type === 'custom_emoji' && data.result.stickers?.[0]?.custom_emoji_id
        if (typeof id === 'string' && /^\d+$/.test(id)) cachedId = id
        else retryAt = Date.now() + 300000
      } catch { retryAt = Date.now() + 300000 }
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
    try { return await api(method, { ...fields, ...view }) }
    catch (e) {
      // Retry without decoration ONLY after an explicit 400 rejection: the first message was not accepted.
      // Never retry on timeout, unknown outcome, rate limit or server failure.
      if (view === plain || !e.definite || Number(e.telegramCode) !== 400 || e.retrySafe) throw e
      disabled = true
      return api(method, { ...fields, ...plain })
    }
  }
  return { send }
}
