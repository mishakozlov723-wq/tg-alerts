// Проверка источников: node check.js
// Показывает, приходят ли реальные цены и новости, и сколько им лет.
import './env.js'
import { startPrices, prices } from './prices.js'
import { getNews } from './news.js'

process.env.PRICE_SOURCE ||= 'dukascopy'
console.log('PRICE_SOURCE =', process.env.PRICE_SOURCE)
await startPrices(() => {})
for (const [s, p] of Object.entries(prices)) {
  const age = p.dataTs ? Math.round((Date.now() - p.dataTs) / 1000) + ' сек назад' : 'n/a'
  console.log(`${s.padEnd(7)} ${p.price}   (данные: ${age})`)
}
for (const s of ['EURUSD', 'GBPUSD', 'DXY']) if (!prices[s]) console.log(`${s.padEnd(7)} НЕТ ДАННЫХ`)
const news = await getNews()
console.log(`\nКрасных новостей: ${news.length}`)
for (const n of news.slice(0, 5)) console.log(' ', new Date(n.time).toLocaleString('ru-RU'), n.currency, n.title)
process.exit(0)
