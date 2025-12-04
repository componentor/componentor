import { createHead } from '@unhead/vue/client'
import mixin, { resetHydrationId } from './mixin.js'

// Track if we've already attempted a reload to prevent infinite loops
const RELOAD_KEY = '__vue_hydration_reload__'
const BUILD_HASH_KEY = '__client_build_hash__'

// Get the server's build hash from the SSR-injected script
const serverBuildHash = window.__BUILD_HASH__

// Get the client's last known build hash
const clientBuildHash = sessionStorage.getItem(BUILD_HASH_KEY)

// Check for build version mismatch
if (serverBuildHash && clientBuildHash && serverBuildHash !== clientBuildHash) {
    console.warn('[Client] Build version mismatch detected, reloading...', {
        server: serverBuildHash,
        client: clientBuildHash
    })
    sessionStorage.setItem(BUILD_HASH_KEY, serverBuildHash)
    window.location.reload()
}

// Store current build hash
if (serverBuildHash) {
    sessionStorage.setItem(BUILD_HASH_KEY, serverBuildHash)
}

const hasReloaded = sessionStorage.getItem(RELOAD_KEY)

const boot = async () => {
    // CRITICAL: Reset hydration counter BEFORE creating app
    // This ensures client counter starts at 0, matching server
    resetHydrationId()

    // Import createApp dynamically to ensure mixin is loaded first
    const { createApp } = await import('./main.js')
    const { app, router } = await createApp()

    const head = createHead()
    app.use(head)
    app.use(mixin)

    // Handle chunk loading errors (e.g., after a new build when old chunks are gone)
    router.onError((error) => {
        if (
            error.message.includes('Failed to fetch dynamically imported module') ||
            error.message.includes('Importing a module script failed') ||
            error.message.includes('error loading dynamically imported module')
        ) {
            // Chunk loading failed - reload to get fresh assets
            console.warn('[Router] Chunk loading failed, reloading page...', error.message)
            if (!hasReloaded) {
                sessionStorage.setItem(RELOAD_KEY, 'true')
                window.location.reload()
            }
        }
    })

    // Global error handler - log errors but don't auto-reload for component errors
    // (those are usually @vueplayio package issues that won't be fixed by reload)
    app.config.errorHandler = (err, instance, info) => {
        console.error('[Vue Error]', err, info)
    }

    await router.isReady()

    // Clear reload flag after successful mount
    app.mount('#app')
    sessionStorage.removeItem(RELOAD_KEY)
}
boot()
