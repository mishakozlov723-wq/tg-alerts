// Мини-загрузчик .env (без зависимостей). Переменные, уже заданные в системе, не перезаписываются.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

try {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env')
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
} catch {}
