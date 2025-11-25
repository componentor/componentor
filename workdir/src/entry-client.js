import { createApp } from './main.js'
import { createHead } from '@unhead/vue/client'

const boot = async () => {
    const { app, router } = await createApp()

    const head = createHead()
    app.use(head)
    const mixin = await import('./mixin.js')
    app.use(mixin.default)

    await router.isReady()
    app.mount('#app')
}
boot()