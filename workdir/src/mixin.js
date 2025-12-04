import { getCurrentInstance, useSSRContext } from 'vue'

let hydrationId = 0

export function resetHydrationId() {
    hydrationId = 0
}

export default {
    install(app) {
        const isClient = typeof window !== 'undefined'
        app.mixin({
            beforeCreate() {
                const name = this.$options.name || 'Anonymous'
                this.__hydrationId = name + '_' + hydrationId++

                if (isClient) {
                    const hydrated = window.__HYDRATED_DATA__?.[this.__hydrationId]
                    if (hydrated) {
                        const originalData = this.$options.data
                        this.__originalData = this.$options.data
                        this.$options.data = function () {
                            return {
                                ...(typeof this.__originalData === 'function' ? this.__originalData.call(this) : {}),
                                ...hydrated
                            }
                        }
                    }
                } else {
                    const originalPrefetch = this.$options.serverPrefetch
                    if (originalPrefetch) {
                        this.$options.serverPrefetch = async function () {
                            await originalPrefetch.call(this)
                            const ctx = global.ssrContext
                            if (ctx) {
                                ctx.__HYDRATED_DATA__ ??= {}
                                ctx.__HYDRATED_DATA__[this.__hydrationId] = { ...this.$data }
                            }
                        }
                    }
                }
            },
            unmounted() {
                if (isClient && this.__hydrationId) {
                    const hydrated = window.__HYDRATED_DATA__?.[this.__hydrationId]
                    if (hydrated) {
                        this.$options.data = this.__originalData
                        delete window.__HYDRATED_DATA__[this.__hydrationId]
                        delete this.__originalData
                    }
                    delete this.__hydrationId
                }
            }
        })
    }
}