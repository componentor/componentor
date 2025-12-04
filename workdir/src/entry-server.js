import { createApp } from './main.js'
import { renderToString } from '@vue/server-renderer'
import { createHead } from '@unhead/vue/server'
import mixin, { resetHydrationId } from './mixin.js'

export async function render(url) {
    // Reset hydration counter at start of each SSR render
    // This ensures client/server hydration IDs match
    resetHydrationId()

    const { app, router } = await createApp()
    const head = createHead()
    app.use(head)
    app.use(mixin)

    await router.push(url)
    await router.isReady()

    global.ssrContext = {}
    const html = await renderToString(app, global.ssrContext)

    return { html, head, hydratedData: global.ssrContext.__HYDRATED_DATA__ || {} }
}