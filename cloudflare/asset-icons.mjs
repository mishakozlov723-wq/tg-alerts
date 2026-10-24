// RetockerAssets custom emoji, resolved with the bot's runtime credentials.
// Interactive My alerts only: delivery queues, prices and alert mutations are unchanged.
const PACK = 'RetockerAssets'
const ASSETS = { EURUSD: '💶', GBPUSD: '💷', DXY: '💵', GER40: '📈', XAUUSD: '🥇', XAGUSD: '🥈' }
const normalizeEmoji = value => String(value || '').replace(/[\uFE0E\uFE0F]/g, '')
export function createAlertIcons(api) {
  let cached = {}, refreshAt = 0, pending = null, disabled = false
  const diagnostics = { version: 3, stage: 'idle', reason: '', resolved: [], missing: [], lastDelivery: 'none', detail: '' }
  const reason = e => /premium|not enough rights|not allowed|forbidden/i.test(e.telegramDescription || '') ? 'telegram_permissions' : /emoji|sticker/i.test(e.telegramDescription || '') ? 'telegram_emoji_rejected' : e.telegramCode ? 'telegram_http_' + e.telegramCode : 'lookup_or_network_failed'
  async function emojiIds() {
    if (disabled) return {}
    if (Date.now() < refreshAt) return cached
    if (!pending) pending = (async () => {
      try {
        diagnostics.stage = 'pack_lookup'
        const data = await api('getStickerSet', { name: PACK }, 5000)
        if (data.result?.sticker_type !== 'custom_emoji' || !Array.isArray(data.result.stickers)) throw new Error('unexpected_pack_format')
        const next = {}
        for (const [symbol, emoji] of Object.entries(ASSETS)) {
          const matches = data.result.stickers.filter(sticker => normalizeEmoji(sticker.emoji) === normalizeEmoji(emoji) && typeof sticker.custom_emoji_id === 'string' && /^\d+$/.test(sticker.custom_emoji_id))
          // Never infer identity from pack order. Ambiguous/missing associations stay plain.
          if (matches.length === 1) next[symbol] = matches[0].custom_emoji_id
        }
        cached = next
        diagnostics.resolved = Object.keys(next)
        diagnostics.missing = Object.keys(ASSETS).filter(symbol => !next[symbol])
        diagnostics.stage = diagnostics.missing.length ? 'pack_partial' : 'pack_ready'
        diagnostics.reason = diagnostics.missing.length ? 'missing_or_ambiguous_asset_association' : ''
        diagnostics.detail = ''
        refreshAt = Date.now() + (diagnostics.missing.length ? 60000 : 300000)
      } catch (e) {
        refreshAt = Date.now() + 60000
        diagnostics.reason = reason(e); diagnostics.detail = String(e.telegramDescription || e.message || '').slice(0, 240); diagnostics.stage = 'pack_failed'
      } finally { pending = null }
      return cached
    })()
    return pending
  }
  function decorate(plain, assets, ids) {
    const keyboard = plain.reply_markup?.inline_keyboard
    if (!keyboard || !assets.some(asset => ids[asset.symbol])) return plain
    const text = plain.text, entities = [], inserts = []
    let cursor = text.indexOf('\n\n') + 2
    assets.forEach((asset, i) => {
      const buttonText = keyboard[i]?.[0]?.text || ''
      const stem = `${i + 1}. ${buttonText.replace(/^✕ /, '')}${asset.note ? ' · ' + asset.note : ''}`
      const at = text.indexOf(stem, cursor)
      if (at < 0) return
      cursor = at + stem.length
      if (ids[asset.symbol]) inserts.push({ at: at + `${i + 1}. `.length, symbol: asset.symbol })
    })
    let result = '', offset = 0
    for (const { at, symbol } of inserts) {
      result += text.slice(offset, at)
      const glyph = ASSETS[symbol]
      entities.push({ type: 'custom_emoji', offset: result.length, length: glyph.length, custom_emoji_id: ids[symbol] })
      result += glyph + ' '; offset = at
    }
    result += text.slice(offset)
    const inline_keyboard = keyboard.map((row, i) => row.map(button => ids[assets[i]?.symbol] ? { ...button, icon_custom_emoji_id: ids[assets[i].symbol] } : { ...button }))
    return { ...plain, text: result, ...(entities.length ? { entities } : {}), reply_markup: { ...plain.reply_markup, inline_keyboard } }
  }
  async function send(method, fields, plain, assets) {
    const ids = assets.some(asset => ASSETS[asset.symbol]) ? await emojiIds() : {}
    const view = decorate(plain, assets, ids)
    try {
      const result = await api(method, { ...fields, ...view })
      diagnostics.lastDelivery = view === plain ? 'plain' : 'custom_emoji_accepted'
      return result
    } catch (e) {
      // A fallback is allowed only after explicit 400 rejection, never ambiguous delivery.
      if (view === plain || !e.definite || Number(e.telegramCode) !== 400 || e.retrySafe) throw e
      diagnostics.reason = reason(e); diagnostics.detail = String(e.telegramDescription || e.message || '').slice(0, 240)
      diagnostics.lastDelivery = 'custom_emoji_rejected'; disabled = true
      return api(method, { ...fields, ...plain })
    }
  }
  async function test(chatId) {
    // Only the owner's explicit /emoji_test in their private chat can call this.
    disabled = false; refreshAt = 0
    const assets = Object.keys(ASSETS).map(symbol => ({ symbol }))
    const plain = {
      text: 'Asset icon test:\n\n' + assets.map((a, i) => `${i + 1}. ${a.symbol} ◇ preview`).join('\n'),
      reply_markup: { inline_keyboard: assets.map(a => [{ text: `✕ ${a.symbol} ◇ preview`, url: 'https://t.me/addemoji/' + PACK }]) }
    }
    await send('sendMessage', { chat_id: chatId }, plain, assets)
    const report = `Emoji check: ${diagnostics.lastDelivery}\nReady: ${diagnostics.resolved.join(', ') || 'none'}\nMissing: ${diagnostics.missing.join(', ') || 'none'}\n${diagnostics.reason}${diagnostics.detail ? '\n' + diagnostics.detail : ''}`
    return api('sendMessage', { chat_id: chatId, text: report })
  }
  return { send, test }
}
