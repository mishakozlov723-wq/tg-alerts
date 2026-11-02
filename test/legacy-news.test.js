import test from 'node:test'
import assert from 'node:assert/strict'
import { pruneSentNews, SENT_NEWS_TTL_MS } from '../news.js'

test('legacy sent-news markers expire a week after the event; old markers get a week from now', () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  const marks = { 'u|old|5': now - SENT_NEWS_TTL_MS - 1, 'u|recent|5': now - 1000, 'u|legacy|5': 1 }
  assert.equal(pruneSentNews(marks, now), true)
  assert.deepEqual(marks, { 'u|recent|5': now - 1000, 'u|legacy|5': now })
  assert.equal(pruneSentNews(marks, now), false, 'Nothing changes on a second pass')
  assert.equal(pruneSentNews(marks, now + SENT_NEWS_TTL_MS + 1), true)
  assert.deepEqual(marks, {})
})
