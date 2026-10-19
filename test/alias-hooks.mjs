// Resolves the tsconfig "@/*" alias to repo-root .ts files for node:test runs.
import { existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = new URL(specifier.slice(2), root).href
    // A JSON import needs an import attribute node can't be given here, so the builder registry
    // resolves to a stub module a test can mock by URL. Tests never read the real data/builders.json.
    if (specifier === '@/data/builders.json') return next(new URL('test/builders-stub.mjs', root).href, context)
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(new URL(candidate))) return next(candidate, context)
    }
  }
  return next(specifier, context)
}
