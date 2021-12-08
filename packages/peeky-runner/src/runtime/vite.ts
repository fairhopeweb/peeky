/* eslint-disable @typescript-eslint/camelcase */

import { resolve, dirname, relative } from 'path'
import { builtinModules, createRequire } from 'module'
import vm from 'vm'
import { pathToFileURL } from 'url'
import { ViteDevServer, InlineConfig, createServer, mergeConfig } from 'vite'
import chalk from 'chalk'
import shortid from 'shortid'
import { isEqual } from 'lodash-es'
import match from 'anymatch'
import { ModuleFilterOption } from '@peeky/config'
import { slash } from '@peeky/utils'
import { mockedModules } from './mocked-files.js'
import { createPeekyGlobal } from '../index.js'

let viteServer: ViteDevServer
let initPromise: Promise<void>
const moduleCache: Map<string, Promise<ViteExecutionResult>> = new Map()

export interface InitViteServerOptions {
  defaultConfig: InlineConfig
  userInlineConfig: InlineConfig
  configFile: string
  rootDir: string
  exclude: ModuleFilterOption
  include: ModuleFilterOption
}

let currentOptions: InitViteServerOptions
let lastOptions: InitViteServerOptions
let initId: string

export async function initViteServer (options: InitViteServerOptions) {
  if (initPromise && isEqual(lastOptions, options)) return initPromise

  const currentInitId = initId = shortid()

  // eslint-disable-next-line no-async-promise-executor
  initPromise = new Promise(async (resolve, reject) => {
    try {
      await stopViteServer()

      lastOptions = options

      currentOptions = {
        ...options,
      }

      const server = await createServer(mergeConfig(mergeConfig(options.defaultConfig ?? {}, options.userInlineConfig ?? {}), {
        logLevel: 'error',
        clearScreen: false,
        configFile: options.configFile,
        root: options.rootDir,
        resolve: {},
      }))
      await server.pluginContainer.buildStart({})

      if (initId === currentInitId) {
        viteServer = server
      } else {
        initPromise.then(resolve)
      }
    } catch (e) {
      reject(e)
    }
    resolve()
  })

  return initPromise
}

export async function stopViteServer () {
  if (viteServer) {
    await viteServer.close()
  }
}

export interface ViteExecutionResult {
  exports: any
  deps: string[]
}

export async function executeWithVite (file: string, executionContext: Record<string, any>, root: string): Promise<ViteExecutionResult> {
  if (!viteServer) {
    throw new Error('Vite server is not initialized, use `initViteServer` first')
  }
  const fileId = `/@fs/${slash(resolve(file))}`
  const deps = new Set<string>()
  const exports = await cachedRequest(fileId, [], deps, executionContext, root)
  return {
    exports,
    deps: Array.from(deps),
  }
}

export function getFileDependencies (id: string, entryFiles: string[], result = new Set<string>(), seen = new Set<string>()): Set<string> {
  if (seen.has(id) || result.has(id)) {
    return result
  }

  seen.add(id)
  if (entryFiles.includes(id)) {
    result.add(id)
    return result
  }

  const mod = viteServer.moduleGraph.getModuleById(id)

  if (mod) {
    mod.importers.forEach((i) => {
      if (i.id) {
        getFileDependencies(i.id, entryFiles, result, seen)
      }
    })
  }

  return result
}

/**
 * Can return a cached request
 * @param rawId
 * @param callstack To detect circular dependencies
 * @returns
 */
function cachedRequest (rawId: string, callstack: string[], deps: Set<string>, executionContext: Record<string, any>, root: string): Promise<any> {
  if (builtinModules.includes(rawId)) {
    return import(rawId)
  }

  const id = normalizeId(rawId)
  const realPath = toFilePath(id, root)

  if (mockedModules.has(realPath)) {
    return Promise.resolve(mockedModules.get(realPath))
  }

  if (shouldExternalize(realPath)) {
    return import(realPath)
  }

  if (moduleCache.has(id)) {
    return moduleCache.get(id)
  }

  const promise = rawRequest(id, realPath, callstack, deps, executionContext, root)
  moduleCache.set(id, promise)
  return promise
}

async function rawRequest (id: string, realPath: string, callstack: string[], deps: Set<string>, executionContext: Record<string, any>, root: string): Promise<any> {
  // Circular dependencies detection
  callstack = [...callstack, id]
  const request = async (dep: string) => {
    if (callstack.includes(dep)) {
      throw new Error(`${chalk.red('Circular dependency detected')}\nStack:\n${[...callstack, dep].reverse().map((i) => {
        const path = relative(viteServer.config.root, toFilePath(normalizeId(i), root))
        return chalk.dim(' -> ') + (i === dep ? chalk.yellow(path) : path)
      }).join('\n')}\n`)
    }
    return cachedRequest(dep, callstack, deps, executionContext, root)
  }

  const result = await viteServer.transformRequest(id, { ssr: true })
  if (!result) {
    throw new Error(`failed to load ${id}`)
  }

  if (result.deps) {
    result.deps.forEach(dep => deps.add(toFilePath(normalizeId(dep), root)))
  }

  const url = pathToFileURL(realPath)
  const exports = {}

  const context = {
    require: createRequire(url),
    __filename: realPath,
    __dirname: dirname(realPath),
    __vite_ssr_import__: request,
    __vite_ssr_dynamic_import__: request,
    __vite_ssr_exports__: exports,
    __vite_ssr_exportAll__: (obj: any) => exportAll(exports, obj),
    __vite_ssr_import_meta__: { url },
    ...executionContext,
    peeky: createPeekyGlobal({
      filename: realPath,
    }),
  }

  const fn = vm.runInThisContext(`async (${Object.keys(context).join(',')}) => { ${result.code} }`, {
    filename: realPath,
  })
  await fn(...Object.values(context))

  return exports
}

function normalizeId (id: string): string {
  // Virtual modules start with `\0`
  if (id && id.startsWith('/@id/__x00__')) { id = `\0${id.slice('/@id/__x00__'.length)}` }
  if (id && id.startsWith('/@id/')) { id = id.slice('/@id/'.length) }
  if (id.startsWith('__vite-browser-external:')) { id = id.slice('__vite-browser-external:'.length) }
  return id
}

function toFilePath (id: string, root: string): string {
  let absolute = slash(id).startsWith('/@fs/')
    ? id.slice(4)
    : id.startsWith(dirname(root))
      ? id
      : id.startsWith('/')
        ? slash(resolve(root, id.slice(1)))
        : id

  if (absolute.startsWith('//')) { absolute = absolute.slice(1) }

  return absolute
}

function exportAll (exports: any, sourceModule: any) {
  for (const key in sourceModule) {
    if (key !== 'default') {
      try {
        Object.defineProperty(exports, key, {
          enumerable: true,
          configurable: true,
          get () { return sourceModule[key] },
        })
      } catch (_err) { }
    }
  }
}

function shouldExternalize (filePath: string): boolean {
  if (typeof currentOptions.include === 'function') {
    if (currentOptions.include(filePath)) {
      return false
    }
  } else if (matchModuleFilter(currentOptions.include, filePath)) {
    return false
  }

  if (typeof currentOptions.exclude === 'function') {
    return currentOptions.exclude(filePath)
  }

  return matchModuleFilter(currentOptions.exclude, filePath)
}

function matchModuleFilter (filters: (string | RegExp) | (string | RegExp)[], filePath: string): boolean {
  const filtersList = Array.isArray(filters) ? filters : [filters]
  return filtersList.some(filter => {
    if (typeof filter === 'string') {
      return match(filter, filePath)
    } else if (filter instanceof RegExp) {
      return filter.test(filePath)
    }
  })
}
