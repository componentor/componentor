import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import express from 'express'
import { transformHtmlTemplate } from '@unhead/vue/server'
import { createContext } from '../../../core/types/context.mjs'
import AdminProvider from './includes/providers/index.mjs'
import jwtMiddleware from '../../../core/middlewares/jwtMiddleware.mjs'
import { getCachedSSR, setCachedSSR } from '../../../core/services/SharedSSRCache.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.join(__dirname, 'client')
const clientTemplate = path.join(__dirname, 'client', 'index.html')
const serverEntry = path.join(__dirname, 'server', 'entry-server.js')

// Dynamically load render function (only available after first build)
let render = null
async function loadRender() {
  if (render) return render
  if (!fs.existsSync(serverEntry)) return null
  const module = await import('./server/entry-server.js')
  render = module.render
  return render
}

const template = fs.existsSync(clientTemplate)
  ? fs.readFileSync(clientTemplate, 'utf-8')
  : '<!DOCTYPE html><html><head></head><body><!--app-html--></body></html>'

// Cache gitserver module at theme level (not per-request)
let cachedGitServer = null
let gitServerInitPromise = null

// SSR cache TTL (uses SharedSSRCache for cross-worker caching)
const SSR_CACHE_TTL_MS = 5000 // 5 seconds - shared across all workers

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

  return {
    async init() {
      const { addAction, getAttachmentUrl } = hooks
      const { knex, table } = context

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
            const gitserverModule = await import('./includes/gitserver.mjs')
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
                  showNotification: true
                })
                await currentJob.start()
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
                } else {
                  if (currentJob) await currentJob.complete({
                    success: result.success,
                    duration: result.duration || 'N/A'
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
    },
    async render() {
      // Wait for gitserver if still initializing
      const repos = cachedGitServer || await gitServerInitPromise

      // Register git API routes (idempotent - Express handles duplicates)
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
        router.use(express.static(clientDist, { index: false }))
      }

      router.get(/.*/, async (req, res) => {
        // Check shared SSR cache first (cross-worker)
        const cacheKey = req.url
        const cached = await getCachedSSR(cacheKey, SSR_CACHE_TTL_MS)

        if (cached) {
          // Cache hit - return immediately
          const cacheSpan = startSpan('theme.componentor.ssr.cacheHit', {
            category: 'cache',
            tags: { url: req.url, source: cached.source, age: Date.now() - cached.timestamp }
          })
          cacheSpan.end()
          return res.type('html').send(cached.html)
        }

        // Cache miss - render SSR
        const ssrSpan = startSpan('theme.componentor.ssr', {
          category: 'render',
          tags: { url: req.url, cacheMiss: true }
        })

        // Load prebuilt SSR server entry
        const loadSpan = startSpan('theme.componentor.loadRender', { category: 'io' })
        const renderFn = await loadRender()
        loadSpan.end()

        if (typeof renderFn !== 'function') {
          ssrSpan.addTag('error', 'not_built')
          ssrSpan.end()
          return res.status(503).send('Theme not built yet. Please trigger a build first.')
        }

        // Trace Vue SSR rendering
        const vueRenderSpan = startSpan('theme.componentor.vueRender', { category: 'render' })
        const rendered = await renderFn(req.url)
        vueRenderSpan.addTag('hasHead', !!rendered.head)
        vueRenderSpan.addTag('hasHydrated', !!rendered.hydratedData)
        vueRenderSpan.end()

        // Trace HTML template transformation
        const templateSpan = startSpan('theme.componentor.templateTransform', { category: 'render' })
        let html = ''
        if (rendered.head) {
          html = await transformHtmlTemplate(
            rendered.head,
            template.replace(`<!--app-html-->`, rendered.html ?? '')
          )
        } else {
          html = template.replace(`<!--app-html-->`, rendered.html ?? '')
        }

        if (global?.vueplayStyles) {
          let css = ''
          for (const key of Object.keys(global.vueplayStyles)) {
            css += global.vueplayStyles[key] + '\n'
          }
          html = html.replace('</head>', `<style>${css}</style></head>`)
        }

        if (rendered.hydratedData) {
          html = html.replace('<head>', `<head><script>window.__HYDRATED_DATA__ = ${JSON.stringify(rendered.hydratedData)}</script>`)
        }
        templateSpan.addTag('htmlSize', html.length)
        templateSpan.end()

        // Cache the rendered HTML (shared across all workers)
        setCachedSSR(cacheKey, html)

        ssrSpan.addTag('responseSize', html.length)
        ssrSpan.end()

        res.type('html').send(html)
      })
    }
  }
}