import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default async ({ req, res, next }) => {

    const { addMenuPage, addSubMenuPage } = req.hooks
    const { translate, parseVue } = req.context
    const locale = req?.user?.locale || 'en_US'

    const adminPages = [
        {
            capabilities: {
                manage_dashboard: 'manage_dashboard'
            },
            badge: 0,
            position: 1500,
            file: 'Builder.vue',
            slug: 'vueplay',
            page_title: translate('Build', locale),
            menu_title: translate('Build', locale),
            icon: '<svg width="20" height="20" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M94.059 184.569c-11.314 33.94-56.569 33.94-56.569 33.94s0-45.254 33.941-56.568Zm90.51-67.883v64.569a8 8 0 0 1-2.344 5.657l-32.341 32.341a8 8 0 0 1-13.502-4.087L128 173.255Zm-45.255-45.255H74.745a8 8 0 0 0-5.657 2.344l-32.341 32.341a8 8 0 0 0 4.087 13.502L82.745 128Z" opacity=".2"/><path d="M96.589 176.979a8 8 0 0 0-10.12 5.06c-6.553 19.659-27.895 25.747-40.137 27.63 1.883-12.249 7.972-33.586 27.63-40.138a8 8 0 1 0-5.06-15.18c-16.361 5.454-28.38 18.451-34.758 37.588a92.7 92.7 0 0 0-4.654 26.57 8 8 0 0 0 8 8 92.7 92.7 0 0 0 26.571-4.652c19.136-6.379 32.133-18.398 37.587-34.758a8 8 0 0 0-5.06-10.12"/><path d="M227.612 41.82a15.88 15.88 0 0 0-13.433-13.432c-11.286-1.684-40.621-2.513-69.21 26.073L136 63.43H74.745a15.9 15.9 0 0 0-11.314 4.687L31.089 100.46a16 16 0 0 0 8.177 27.002L78.8 135.37l41.83 41.83 7.906 39.534a15.998 15.998 0 0 0 27.004 8.176l32.342-32.342a15.9 15.9 0 0 0 4.685-11.313V120l8.971-8.97c28.588-28.589 27.758-57.924 26.073-69.21M74.745 79.432H120l-39.884 39.883-37.713-7.542Zm81.54-13.657c7.808-7.81 28.844-25.545 55.503-21.592 3.98 26.679-13.754 47.723-21.563 55.533L128 161.94 94.059 128Zm20.283 115.48-32.341 32.342-7.543-37.712L176.568 136Z"/></svg>'
        },
    ]

    const adminSubPages = [
        {
            capabilities: {
                manage_dashboard: 'manage_dashboard'
            },
            badge: 0,
            position: 1000,
            file: 'Builder.vue',
            parent_slug: 'vueplay',
            slug: '',
            page_title: translate('Drag & drop', locale),
            menu_title: translate('Drag & drop', locale)
        },
    ]

    for (const { badge, capabilities, position, file, slug, page_title, menu_title, icon } of adminPages) {
        await addMenuPage({
            badge, capabilities, slug, page_title, menu_title, position, icon, callback: async () => {
                const filePath = path.resolve(__dirname, `./ui/${file}`)
                return parseVue(filePath)
            }
        })
    }
    for (const { badge, capabilities, position, file, parent_slug, slug, page_title, menu_title } of adminSubPages) {
        await addSubMenuPage({
            badge, capabilities, parent_slug, slug, page_title, menu_title, position, callback: async () => {
                const filePath = path.resolve(__dirname, `./ui/${file}`)
                return parseVue(filePath)
            }
        })
    }
}