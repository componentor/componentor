import { parentPort, workerData } from 'worker_threads'
import path from 'path'
import fs from 'fs'
import { transformHtmlTemplate } from '@unhead/vue/server'

// Worker thread for isolated SSR rendering
// A NEW worker is created for EACH request to ensure complete isolation
// This matches the working jstune server implementation

interface WorkerData {
  themeDir: string
  url: string
  buildHash: string
  theme: string | undefined
  accessToken: string | undefined
  windowWidth: number
}

const { themeDir, url, buildHash, theme, accessToken, windowWidth } = workerData as WorkerData
const serverEntry = path.join(themeDir, 'server', 'entry-server.js')
const clientTemplate = path.join(themeDir, 'client', 'index.html')

async function runModule() {
  try {
    // Load template
    const template = fs.existsSync(clientTemplate)
      ? fs.readFileSync(clientTemplate, 'utf-8')
      : '<!DOCTYPE html><html><head></head><body><!--app-html--></body></html>'

    if (!fs.existsSync(serverEntry)) {
      parentPort?.postMessage({ error: 'Theme not built yet' })
      return
    }

    // Set globals in this isolated worker context
    // This is completely isolated - worker is terminated after this request
    const g = global as any
    g.theme = theme
    g.accessToken = accessToken
    g.windowWidth = windowWidth || 1280
    g.vueplayStyles = {}
    g.ssrContext = {}
    g.fetch = fetch // Use native fetch

    // Dynamic import - each worker is fresh so no cache busting needed
    const { render } = await import(serverEntry)

    // Render in isolated context
    const rendered = await render(url)

    // Transform HTML with head tags inside the worker
    // (head object contains functions that can't be cloned for postMessage)
    let html = ''
    if (rendered.head) {
      html = await transformHtmlTemplate(
        rendered.head as any,
        template.replace(`<!--app-html-->`, rendered.html ?? '')
      )
    } else {
      html = template.replace(`<!--app-html-->`, rendered.html ?? '')
    }

    // Add vueplayStyles to the HTML
    if (g.vueplayStyles && Object.keys(g.vueplayStyles).length > 0) {
      let css = ''
      for (const key of Object.keys(g.vueplayStyles)) {
        css += g.vueplayStyles[key] + '\n'
      }
      html = html.replace('</head>', `<style>${css}</style></head>`)
    }

    // Add hydrated data script
    if (rendered.hydratedData) {
      html = html.replace('<head>', `<head><script>window.__HYDRATED_DATA__ = ${JSON.stringify(rendered.hydratedData)}</script>`)
    }

    // Add build hash for client-side version detection
    html = html.replace('<head>', `<head><script>window.__BUILD_HASH__ = "${buildHash}"</script>`)

    // Pass SSR globals to client for @vueplayio components
    html = html.replace('<head>', `<head><script>window.__SSR_WINDOW_WIDTH__ = ${windowWidth || 1280}</script>`)

    // Return the fully assembled HTML
    parentPort?.postMessage(html)

  } catch (error) {
    console.log('Worker could not render', error instanceof Error ? error.message : error, error)
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

// Run immediately - worker is terminated after completion
runModule()
