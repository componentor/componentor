import { createApp } from './main.js'
import { createHead } from '@unhead/vue/client'

const boot = async () => {
    const { app, router } = await createApp()

    const head = createHead()
    app.use(head)
    const mixin = await import('./mixin.js')
    app.use(mixin.default)

    // Handle chunk loading errors (e.g., after a new build when old chunks are gone)
    router.onError((error) => {
        if (
            error.message.includes('Failed to fetch dynamically imported module') ||
            error.message.includes('Importing a module script failed') ||
            error.message.includes('error loading dynamically imported module')
        ) {
            // Chunk loading failed - reload to get fresh assets
            console.warn('[Router] Chunk loading failed, reloading page...', error.message)
            window.location.reload()
        }
    })

    await router.isReady()
    app.mount('#app')
}
boot()