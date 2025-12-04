import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import express from 'express'
import { transformHtmlTemplate } from '@unhead/vue/server'
import { createContext } from '../../../core/types/context.mjs'
import AdminProvider from './includes/providers/index.mjs'
import jwtMiddleware from '../../../core/middlewares/jwtMiddleware.ts'
import { getCachedSSR, setCachedSSR } from '../../../core/services/SharedSSRCache.ts'
import { UAParser } from 'ua-parser-js'
import cookie from 'cookie'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.join(__dirname, 'client')
const clientTemplate = path.join(__dirname, 'client', 'index.html')
const serverEntry = path.join(__dirname, 'server', 'entry-server.js')
const workdirPath = path.join(__dirname, 'workdir')
const workdirGitignore = path.join(workdirPath, '.gitignore')

// Create .gitignore in workdir if it doesn't exist (npm strips it during publish)
if (!fs.existsSync(workdirGitignore)) {
  fs.writeFileSync(workdirGitignore, 'node_modules\n', 'utf-8')
}

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
        router.use(express.static(clientDist, { index: false }))
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

        const originalFetch = fetch

        global.theme = theme
        global.accessToken = accessToken
        global.windowWidth = windowWidth || 1280
        global.fetch = async (uri, options = {}) => {
          /*
          @todo - Could create nonce logic give access to e.g. internal apis
          if (uri.startsWith('')) {
            options = {
              ...options,
              headers: {
                ...options.headers,
                'x-ssr-nonce': nonce,
              }
            }
          }*/
          return originalFetch(uri, options)
        }

        console.log({
          theme,
          accessToken,
          windowWidth: windowWidth || 1280
        })

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

        // Ensure browser always revalidates HTML to get fresh asset references
        res.setHeader('Cache-Control', 'no-cache, must-revalidate')
        res.type('html').send(html)
      })
    }
  }
}