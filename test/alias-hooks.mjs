// Resolves the tsconfig "@/*" alias to repo-root .ts files for node:test runs.
import { existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = new URL(specifier.slice(2), root).href
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(new URL(candidate))) return next(candidate, context)
    }
  }
  return next(specifier, context)
}
