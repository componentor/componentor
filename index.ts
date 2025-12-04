import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import express from 'express'
import { createContext } from '../../../core/types/context.mjs'
import AdminProvider from './includes/providers/index.mjs'
import jwtMiddleware from '../../../core/middlewares/jwtMiddleware.ts'
import { getCachedSSR, setCachedSSR, invalidateSSRCache } from '../../../core/services/SharedSSRCache.ts'
import { invalidateCache, getFolderHash } from '../../../core/services/FolderHashCache.ts'
import { UAParser } from 'ua-parser-js'
import cookie from 'cookie'

// SSR worker data passed via workerData (not postMessage)
interface SSRWorkerData {
  themeDir: string
  url: string
  buildHash: string
  theme: string | undefined
  accessToken: string | undefined
  windowWidth: number
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.join(__dirname, 'client')
const serverEntry = path.join(__dirname, 'server', 'entry-server.js')
const ssrWorkerPath = path.join(__dirname, 'includes', 'ssr-worker.ts')
const workdirPath = path.join(__dirname, 'workdir')
const workdirGitignore = path.join(workdirPath, '.gitignore')

// Create .gitignore in workdir if it doesn't exist (npm strips it during publish)
if (!fs.existsSync(workdirGitignore)) {
  fs.writeFileSync(workdirGitignore, 'node_modules\n', 'utf-8')
}

// Execute SSR in a NEW worker thread for each request
// This ensures complete isolation - matching the working jstune server pattern
async function runDynamicModule(workerData: SSRWorkerData): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null
    let isResolved = false
    let timeoutId: NodeJS.Timeout | null = null

    try {
      console.log(`[SSR] Starting worker for ${workerData.url}`)

      worker = new Worker(ssrWorkerPath, {
        workerData,
        execArgv: ['--import', 'tsx'] // Enable TypeScript support in worker
      })

      // Add timeout to prevent worker from hanging indefinitely
      timeoutId = setTimeout(() => {
        if (!isResolved && worker) {
          console.error(`[SSR] Worker timeout for ${workerData.url}, terminating worker`)
          cleanup(true)
          resolve('') // Resolve with empty string on timeout
        }
      }, 10000) // 10 second timeout (matching jstune)

      const cleanup = (terminate = true) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if (worker) {
          worker.removeAllListeners()
          if (terminate) {
            worker.terminate().catch(err => {
              console.error('[SSR] Error terminating worker:', err.message)
            })
          }
          worker = null
        }
      }

      worker.on('message', (msg) => {
        if (!isResolved) {
          isResolved = true
          console.log(`[SSR] Worker completed for ${workerData.url}`)
          cleanup(true)

          // Check if it's an error response
          if (msg && typeof msg === 'object' && 'error' in msg) {
            reject(new Error(msg.error))
          } else {
            resolve(msg as string)
          }
        }
      })

      worker.on('error', (err) => {
        if (!isResolved) {
          isResolved = true
          console.error(`[SSR] Worker error for ${workerData.url}:`, err.message)
          cleanup(true)
          reject(err)
        }
      })

      worker.on('exit', (code) => {
        if (!isResolved) {
          isResolved = true
          if (code !== 0) {
            console.error(`[SSR] Worker exited with code ${code} for ${workerData.url}`)
            cleanup(false) // Already exited, don't terminate
            reject(new Error(`Worker stopped with exit code ${code}`))
          } else {
            cleanup(false)
            resolve('')
          }
        }
      })

    } catch (err) {
      if (!isResolved) {
        isResolved = true
        console.error(`[SSR] Failed to create worker for ${workerData.url}:`, err)
        reject(err)
      }
    }
  })
}

// Called after build completes - invalidates folder hash cache which broadcasts to all workers
export function reloadAfterBuild() {
  console.log('[componentor] Build complete, invalidating caches...')
  // Invalidate the theme folder's hash - this broadcasts to all workers via FolderHashCache IPC
  invalidateCache(__dirname)
  // Also invalidate SSR HTML cache
  invalidateSSRCache()
}

// Cache gitserver module at theme level (not per-request)
let cachedGitServer = null
let gitServerInitPromise = null

// SSR cache TTL (uses SharedSSRCache for cross-worker caching)
const SSR_CACHE_TTL_MS = 2000 // 2 sec - shared across all workers

/**
 * @param {HTMLDrop.ThemeRequest} params
 * @returns {Promise<HTMLDrop.ThemeInstance>}
 */
export default async ({ req, res, next, router }) => {
  // Using helper functions for automatic type inference
  const { context, hooks, guard } = createContext(req)

  // Get tracer from hooks - available for performance tracking
  // Theme developers can use this to trace their own operations
  const { tracer, startSpan, trace } = hooks

  let inited = false

  return {
    async init() {
      // Prevent multiple initializations
      if (inited) return

      const { addAction, getAttachmentUrl } = hooks
      const { knex, table } = context

      // Register admin bar button
      req.hooks.registerButton({
        id: 'componentor-button',
        label: 'Edit with Componentor',
        icon: '<svg width="20" height="20" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M94.059 184.569c-11.314 33.94-56.569 33.94-56.569 33.94s0-45.254 33.941-56.568Zm90.51-67.883v64.569a8 8 0 0 1-2.344 5.657l-32.341 32.341a8 8 0 0 1-13.502-4.087L128 173.255Zm-45.255-45.255H74.745a8 8 0 0 0-5.657 2.344l-32.341 32.341a8 8 0 0 0 4.087 13.502L82.745 128Z" opacity=".2"/><path d="M96.589 176.979a8 8 0 0 0-10.12 5.06c-6.553 19.659-27.895 25.747-40.137 27.63 1.883-12.249 7.972-33.586 27.63-40.138a8 8 0 1 0-5.06-15.18c-16.361 5.454-28.38 18.451-34.758 37.588a92.7 92.7 0 0 0-4.654 26.57 8 8 0 0 0 8 8 92.7 92.7 0 0 0 26.571-4.652c19.136-6.379 32.133-18.398 37.587-34.758a8 8 0 0 0-5.06-10.12"/><path d="M227.612 41.82a15.88 15.88 0 0 0-13.433-13.432c-11.286-1.684-40.621-2.513-69.21 26.073L136 63.43H74.745a15.9 15.9 0 0 0-11.314 4.687L31.089 100.46a16 16 0 0 0 8.177 27.002L78.8 135.37l41.83 41.83 7.906 39.534a15.998 15.998 0 0 0 27.004 8.176l32.342-32.342a15.9 15.9 0 0 0 4.685-11.313V120l8.971-8.97c28.588-28.589 27.758-57.924 26.073-69.21M74.745 79.432H120l-39.884 39.883-37.713-7.542Zm81.54-13.657c7.808-7.81 28.844-25.545 55.503-21.592 3.98 26.679-13.754 47.723-21.563 55.533L128 161.94 94.059 128Zm20.283 115.48-32.341 32.342-7.543-37.712L176.568 136Z"/></svg>',
        href: '/admin/vueplay',
        position: 300,
        script: `
          // Function to update the link URL based on current page
          function updateComponentorLink() {
            const link = document.querySelector('#componentor-button a')
            if (!link) return

            const currentPath = window.location.pathname
            const url = '/admin/vueplay#' + currentPath
            link.href = url
          }

          // Wait for DOM to be ready and element to exist
          function waitForLink() {
            const link = document.querySelector('#componentor-button a')
            if (link) {
              updateComponentorLink()
            } else {
              requestAnimationFrame(waitForLink)
            }
          }
          waitForLink()

          // Update when URL changes (back/forward navigation)
          window.addEventListener('popstate', updateComponentorLink)

          // Intercept pushState/replaceState for programmatic navigation
          const originalPushState = history.pushState
          const originalReplaceState = history.replaceState
          history.pushState = function(...args) {
            originalPushState.apply(this, args)
            updateComponentorLink()
          }
          history.replaceState = function(...args) {
            originalReplaceState.apply(this, args)
            updateComponentorLink()
          }
        `
      })

      // Example: Trace theme initialization with the tracer
      await trace('theme.componentor.init', async (span) => {
        span.addTag('theme', 'componentor')

        const url = await getAttachmentUrl(8)
        // console.log({ url })

        // Attach admin menu
        await AdminProvider({ req, res, next })

        addAction('create_post', ({ req, res, next, postType, post }) => {
          if (postType === 'pages') {
            // todo - gather pages information and generate a router.mjs based on it.
            console.log('Do something when creating posts ...')
          }
        })
        addAction('save_post', ({ req, res, next, postType, post }) => {
          if (postType === 'pages') {
            // todo - gather pages information and generate a router.mjs based on it.
            console.log('Do something when updating posts ...')
          }
        })
        addAction('trash_post', ({ req, res, next, postType, post }) => {
          if (postType === 'pages') {
            // todo - gather pages information and generate a router.mjs based on it.
            console.log('Do something when deleting posts ...')
          }
        })
        addAction('delete_post', ({ req, res, next, postType, post }) => {
          if (postType === 'pages') {
            // todo - gather pages information and generate a router.mjs based on it.
            console.log('Do something when deleting posts ...')
          }
        })

        // Initialize gitserver once and cache it (moved from render for performance)
        if (!cachedGitServer && !gitServerInitPromise) {
          gitServerInitPromise = (async () => {
            const gitSpan = startSpan('theme.componentor.gitserver.init', {
              category: 'theme',
              tags: { component: 'gitserver', cached: false }
            })

            // Import gitserver module once (no cache-busting)
            const gitserverModule = await import('./includes/gitserver.ts')
            const git = gitserverModule.default

            let currentJob = null
            const repos = await git({
              knex,
              table,
              onBuildStart: async () => {
                currentJob = await hooks.createJob({
                  name: 'Git Build',
                  description: 'Building theme from git repository',
                  type: 'build',
                  iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="m7.5 4.27 9 5.15" />
                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                    <path d="m3.3 7 8.7 5 8.7-5" />
                    <path d="M12 22V12" />
                  </svg>`,
                  source: 'hello-coral-theme',
                  createdBy: req.user?.id || null,
                  showNotification: true,
                  timeout: 300000 // 5 minutes timeout
                })
                if (currentJob) await currentJob.start()
              },
              onBuildProgress: async (output, stream, percentage) => {
                if (currentJob) {
                  await currentJob.updateProgress(percentage, {
                    lastOutput: output.trim(),
                    stream: stream
                  })
                }
              },
              onBuildComplete: async (error, result) => {
                if (error) {
                  if (currentJob) await currentJob.fail(error.message)
                } else if (result && !result.success) {
                  // Build exited with non-zero code
                  const errorMsg = result.stderr?.slice(-500) || result.stdout?.slice(-500) || 'Build failed with unknown error'
                  if (currentJob) await currentJob.fail(errorMsg)
                } else {
                  // Reload SSR assets (template + render function) after successful build
                  reloadAfterBuild()
                  // Invalidate SSR cache so next request gets fresh content
                  invalidateSSRCache()

                  if (currentJob) await currentJob.complete({
                    success: true,
                    duration: result?.duration || 'N/A'
                  })
                }
              }
            })

            gitSpan.end()
            cachedGitServer = repos
            return repos
          })()
        }
      }, { category: 'theme' })
      inited = true
    },
    async render() {

      // Routes are escaped from registry, so init() wont run ~ hence, needs to run manually
      if (req.path.startsWith('/api/v1/git') && !inited) {
        await this.init()
      }

      // Wait for gitserver if still initializing
      const repos = cachedGitServer || await gitServerInitPromise

      // Register git routes
      if (repos) {
        router.use('/api/v1/git', (req, res) => {
          repos.handle(req, res)
        })

        router.post('/api/v1/git-build', jwtMiddleware(context), async (req, res) => {
          repos.build().catch(err => console.error('Manual build failed:', err.message))
          res.status(202).json({
            success: true,
            message: 'Build started - check job queue for progress'
          })
        })
      }

      // Serve client assets (but not index.html - let SSR handle that)
      if (fs.existsSync(clientDist)) {
        router.use(express.static(clientDist, {
          index: false,
          // Hashed assets can be cached forever, unhashed assets should revalidate
          setHeaders: (res, filePath) => {
            // Files with hash in name (e.g., index-CiK26fOL.js) can be cached long-term
            if (/\.[a-zA-Z0-9]{8,}\.(js|css|woff2?|ttf|eot)$/.test(filePath)) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
            } else {
              // Other assets should revalidate
              res.setHeader('Cache-Control', 'no-cache, must-revalidate')
            }
          }
        }))
      }

      router.get(/.*/, async (req, res) => {
        // Check shared SSR cache first (cross-worker)
        // Cache key includes user ID for authenticated users
        const userId = req.user?.id || 'anonymous'
        const cacheKey = `${userId}:${req.url}`
        const cached = await getCachedSSR(cacheKey, SSR_CACHE_TTL_MS)

        if (cached) {
          // Cache hit - return immediately
          const cacheSpan = startSpan('theme.componentor.ssr.cacheHit', {
            category: 'cache',
            tags: { url: req.url, source: cached.source, age: Date.now() - cached.timestamp }
          })
          cacheSpan.end()
          // Ensure browser always revalidates HTML to get fresh asset references
          res.setHeader('Cache-Control', 'no-cache, must-revalidate')
          return res.type('html').send(cached.html)
        }

        // Cache miss - render SSR in worker thread
        const ssrSpan = startSpan('theme.componentor.ssr', {
          category: 'render',
          tags: { url: req.url, cacheMiss: true }
        })

        // Get current build hash to detect when SSR assets need reloading
        const { hash: buildHash } = await getFolderHash(__dirname)

        // Check if theme is built
        if (!fs.existsSync(serverEntry)) {
          ssrSpan.addTag('error', 'not_built')
          ssrSpan.end()
          return res.status(503).send('Theme not built yet. Please trigger a build first.')
        }

        const parser = new UAParser(req.headers['user-agent'])
        const deviceType = parser.getDevice().type

        let guessedWidth = 1280
        if (deviceType === 'mobile') guessedWidth = 375
        else if (deviceType === 'tablet') guessedWidth = 768

        const cookies = cookie.parse(req.headers.cookie || '')
        const accessToken = cookies.accessToken
        const theme = cookies.theme
        let windowWidth = guessedWidth
        try {
          windowWidth = Number(cookies?.windowWidth || 0) || guessedWidth
        } catch(e) {}

        console.log({
          theme,
          accessToken,
          windowWidth: windowWidth || 1280
        })

        // Execute SSR in a NEW worker thread (complete isolation per request)
        // Worker handles full HTML assembly (including head transformation, styles, scripts)
        // Worker is terminated after completion - matching jstune server pattern
        const workerSpan = startSpan('theme.componentor.workerSSR', { category: 'render' })
        let html = ''
        try {
          html = await runDynamicModule({
            themeDir: __dirname,
            url: req.url,
            buildHash,
            theme,
            accessToken,
            windowWidth: windowWidth || 1280
          })
        } catch (err) {
          workerSpan.addTag('error', err instanceof Error ? err.message : 'unknown')
          workerSpan.end()
          ssrSpan.end()
          console.error('[SSR Worker] Error:', err)
          return res.status(500).send('SSR rendering failed')
        }
        workerSpan.end()

        if (!html) {
          ssrSpan.addTag('error', 'empty_response')
          ssrSpan.end()
          return res.status(500).send('SSR rendering returned empty response')
        }

        // Cache the rendered HTML (shared across all workers)
        setCachedSSR(cacheKey, html)

        ssrSpan.addTag('responseSize', html.length)
        ssrSpan.end()

        // Ensure browser always revalidates HTML to get fresh asset references
        res.setHeader('Cache-Control', 'no-cache, must-revalidate')
        res.type('html').send(html)
      })
    }
  }
}