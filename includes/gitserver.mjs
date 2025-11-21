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
  const barePath = join(repoPath, 'bare.git')
  const workdirPath = join(__dirname, '..', 'workdir')

  try { fs.mkdirSync(repoPath, { recursive: true }) } catch(e) {}

  // Initialize bare repo from workdir if not exists
  if (!fs.existsSync(barePath)) {
    try {
      // Check if workdir exists and is a git repo
      if (fs.existsSync(join(workdirPath, '.git'))) {
        console.log('Creating bare repository from workdir...')

        // Initialize a new bare repository
        await git.init({
          fs,
          dir: barePath,
          bare: true,
          defaultBranch: 'master'
        })

        // Get current branch from workdir
        const currentBranch = await git.currentBranch({ fs, dir: workdirPath })

        // Copy objects and refs from workdir to bare repo
        const gitDir = join(workdirPath, '.git')
        const objectsPath = join(gitDir, 'objects')
        const refsPath = join(gitDir, 'refs')

        if (fs.existsSync(objectsPath)) {
          fs.cpSync(objectsPath, join(barePath, 'objects'), { recursive: true })
        }

        if (fs.existsSync(refsPath)) {
          fs.cpSync(refsPath, join(barePath, 'refs'), { recursive: true })
        }

        // Set HEAD to current branch
        if (currentBranch) {
          fs.writeFileSync(join(barePath, 'HEAD'), `ref: refs/heads/${currentBranch}\n`)
        }

        console.log('Bare repository created successfully at:', barePath)
      } else {
        console.log('Workdir is not a git repository, skipping bare repo creation')
      }
    } catch (error) {
      console.error('Error creating bare repository:', error.message)
      console.error(error.stack)
    }
  }
  
  const repos = new Git(repoPath, {
    autoCreate: false,
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
