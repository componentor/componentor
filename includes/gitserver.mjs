import { Git } from 'node-git-server'
import { join, dirname } from 'path'
import fs from 'fs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import UserGuard from '../../../../hd-core/utils/UserGuard.mjs'
import { fileURLToPath } from 'url'
import git from 'isomorphic-git'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default async ({ knex, table }) => {
  const repoPath = join(__dirname, 'repos')
  const barePath = join(repoPath, 'bare')
  const workdirPath = join(__dirname, '..', 'workdir')

  try { fs.mkdirSync(repoPath) } catch(e) {}
  
  // Initialize bare repo from workdir if not exists
  if (!fs.existsSync(repoPath + '/bare')) {
    try {
      // Check if workdir exists and is a git repo
      if (fs.existsSync(join(workdirPath, '.git'))) {
        console.log('Creating bare repository from workdir...')

        // Clone the workdir as a mirror (bare) repository
        await git.clone({
          fs,
          dir: barePath,
          url: workdirPath,
          bare: true
        })

        console.log('Bare repository created successfully at:', barePath)
      } else {
        console.log('Workdir is not a git repository, skipping bare repo creation')
      }
    } catch (error) {
      console.error('Error creating bare repository:', error.message)
    }
  }
  
  const repos = new Git(repoPath, {
    autoCreate: true,
    authenticate: ({ headers, repo, type }, next) => {
      let auth = async (authHeader) => {
        const token = authHeader?.split(' ')[1]
        if (!token) return next('Unauthenticated')
        try {
          const revoked = await knex(table('revoked_tokens'))
            .where({ token: crypto.createHash('sha256').update(token).digest('hex') })
            .first()

          if (revoked) {
            knex(table('revoked_tokens')).where('expires_at', '<', new Date()).del()
            knex(table('refresh_tokens')).where('expires_at', '<', new Date()).del()
            throw new Error('Token revoked')
          }

          const payload = jwt.verify(token, process.env.JWT_SECRET)
          const user = JSON.parse(JSON.stringify(payload))
          user.id = user.sub
          delete user.sub

          const guard = new UserGuard({ knex, table }, user.id)
          if (await guard.user({ canOneOf: ['manage_themes'] })) {
            next()
          } else {
            throw new Error('Permission denied')
          }
        } catch (e) {
          console.log(e?.message || e)
          next(e?.message || e)
        }
      }
      auth(headers?.authorization || headers?.['authorization-x'], type)
    }
  })

  repos.on('push', async (push) => {
    console.log(`push ${push.repo}/${push.commit} ( ${push.branch} )`)
    push.accept()
  })

  repos.on('fetch', async (fetch) => {
    console.log(`fetch ${fetch.commit}`)
    fetch.accept()
  })

  return repos
}
