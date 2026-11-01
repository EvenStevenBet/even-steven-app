// Lets the fork test import the app's own lib/*.ts files, which import each other without an extension
// (e.g. './contracts'). Only used by test/fork; the unit tests never need it.
import { existsSync } from 'node:fs'

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier + ext, context.parentURL)
      if (existsSync(url)) return next(url.href, context)
    }
  }
  return next(specifier, context)
}
