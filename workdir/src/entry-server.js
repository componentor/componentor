import { createApp } from './main.js'
import { renderToString } from '@vue/server-renderer'
import { createHead } from '@unhead/vue/server'

export async function render(url) {
    const { app, router } = await createApp()
    const head = createHead()
    app.use(head)

    const mixin = await import('./mixin.js')
    app.use(mixin.default)

    await router.push(url)
    await router.isReady()

    app.config.warnHandler = (msg) => {
        console.log(msg)
    }

    global.ssrContext = {}
    const html = await renderToString(app, global.ssrContext)

    return { html, head, hydratedData: global.ssrContext.__HYDRATED_DATA__ || {} }
}