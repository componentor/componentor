import path from 'path'
import fs from 'fs'
import git from './includes/gitserver.mjs'
import { fileURLToPath } from 'url'
import express from 'express'
import { transformHtmlTemplate } from '@unhead/vue/server'
import { createContext } from '../../../hd-core/types/context.mjs'
import AdminProvider from './includes/providers/index.mjs'
import jwtMiddleware from '../../../hd-core/middlewares/jwtMiddleware.mjs'

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

/**
 * @param {HTMLDrop.ThemeRequest} params
 * @returns {Promise<HTMLDrop.ThemeInstance>}
 */
export default async ({ req, res, next, router }) => {
  // Using helper functions for automatic type inference
  const { context, hooks, guard } = createContext(req)

  return {
    async init() {
      const { addAction, getAttachmentUrl } = hooks
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
    },
    async render() {

      const { knex, table } = context
      let currentJob = null

      const repos = await git({
        knex,
        table,
        onBuildStart: async () => {
          // Create job for build process
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
          // Update job progress
          if (currentJob) {
            await currentJob.updateProgress(percentage, {
              lastOutput: output.trim(),
              stream: stream
            })
          }
        },
        onBuildComplete: async (error, result) => {
          if (error) {
            // Mark job as failed
            if (currentJob) {
              await currentJob.fail(error.message)
            }
          } else {
            // Mark job as completed
            if (currentJob) {
              await currentJob.complete({
                success: result.success,
                duration: result.duration || 'N/A'
              })
            }
          }
        }
      })

      router.use('/api/v1/git', (req, res) => {
        repos.handle(req, res)
      })

      router.post('/api/v1/git-build', jwtMiddleware(context), async (req, res) => {
        // Trigger build asynchronously
        repos.build().catch(err => console.error('Manual build failed:', err.message))

        res.status(202).json({
          success: true,
          message: 'Build started - check job queue for progress'
        })
      })

      // Serve client assets (but not index.html - let SSR handle that)
      if (fs.existsSync(clientDist)) {
        router.use(express.static(clientDist, { index: false }))
      }

      router.get(/.*/, async (req, res) => {
        // Load prebuilt SSR server entry
        const renderFn = await loadRender()

        if (typeof renderFn !== 'function') {
          return res.status(503).send('Theme not built yet. Please trigger a build first.')
        }

        // Mount SSR handler
        const rendered = await renderFn(req.url)

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
        
        res.type('html').send(html)
      })
    }
  }
}