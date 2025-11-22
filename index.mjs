import path from 'path'
import fs from 'fs'
import git from './includes/gitserver.mjs'
import { fileURLToPath } from 'url'
import express from 'express'
import { transformHtmlTemplate } from '@unhead/vue/server'
import { createContext } from '../../../hd-core/types/context.mjs'
import AdminProvider from './includes/providers/index.mjs'
import { render } from './server/entry-server.js'
import jwtMiddleware from '../../../hd-core/middlewares/jwtMiddleware.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.join(__dirname, 'client')
const clientTemplate = path.join(__dirname, 'client', 'index.html')
const template = fs.readFileSync(clientTemplate, 'utf-8')

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

      const repos = await git({
        knex,
        table,
        onBuildStart: () => {
          console.log('Build started')
          // TODO: Emit to websocket/SSE
        },
        onBuildProgress: (output, stream, percentage) => {
          console.log(`Build progress [${percentage}%]:`, output.trim())
          // TODO: Emit to websocket/SSE
        },
        onBuildComplete: (error, result) => {
          if (error) {
            console.error('Build failed:', error.message)
            // TODO: Emit error to websocket/SSE
          } else {
            console.log('Build completed:', result.success)
            // TODO: Emit success to websocket/SSE
          }
        }
      })

      router.use('/api/v1/git', (req, res) => {
        repos.handle(req, res)
      })

      router.post('/api/v1/git-build', jwtMiddleware(context), (req, res) => {
        repos.build().catch(err => console.error('Manual build failed:', err.message))
        res.status(202).json({ success: true, message: 'Build started' })
      })

      // Serve client assets (but not index.html - let SSR handle that)
      router.use(express.static(clientDist, { index: false }))

      router.get(/.*/, async (req, res, next) => {
        // Load prebuilt SSR server entry

        if (typeof render !== 'function') {
          throw new Error('SSR template server entry must export a render(url) function')
        }

        // Mount SSR handler
        const rendered = await render(req.url)

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