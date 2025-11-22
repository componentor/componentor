import { Git } from 'node-git-server'
import { join, dirname } from 'path'
import fs from 'fs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import UserGuard from '../../../../hd-core/utils/UserGuard.mjs'
import { fileURLToPath } from 'url'
import git from 'isomorphic-git'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function syncWorkdirToBare(workdirPath, barePath) {
  try {
    const statusMatrix = await git.statusMatrix({ fs, dir: workdirPath })
    const hasChanges = statusMatrix.some(([, h, w, s]) => h !== w || w !== s)

    if (!hasChanges) return

    let currentBranch = await git.currentBranch({ fs, dir: workdirPath }) || 'master'

    if (!currentBranch) {
      try {
        await git.checkout({ fs, dir: workdirPath, ref: 'master' })
      } catch {
        try {
          await git.branch({ fs, dir: workdirPath, ref: 'master', checkout: true })
        } catch {
          await git.checkout({ fs, dir: workdirPath, ref: 'master', force: true })
        }
      }
      currentBranch = 'master'
    }

    for (const [filepath, headStatus, workdirStatus] of statusMatrix) {
      if (headStatus !== workdirStatus) {
        workdirStatus === 0
          ? await git.remove({ fs, dir: workdirPath, filepath })
          : await git.add({ fs, dir: workdirPath, filepath })
      }
    }

    const commitOid = await git.commit({
      fs,
      dir: workdirPath,
      message: `Auto-commit at ${new Date().toISOString()}`,
      author: { name: 'GitServer', email: 'auto@gitserver.local' }
    })

    const copyObjects = (src, dest) => {
      if (!fs.existsSync(src)) return
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name)
        const destPath = join(dest, entry.name)

        if (entry.isDirectory()) {
          fs.mkdirSync(destPath, { recursive: true })
          copyObjects(srcPath, destPath)
        } else {
          try {
            if (fs.existsSync(destPath)) fs.chmodSync(destPath, 0o644)
            fs.copyFileSync(srcPath, destPath)
          } catch (err) {
            console.error(`Failed to copy ${srcPath}:`, err.message)
          }
        }
      }
    }

    copyObjects(join(workdirPath, '.git', 'objects'), join(barePath, 'objects'))

    const refPath = join(barePath, 'refs', 'heads', currentBranch)
    fs.mkdirSync(join(barePath, 'refs', 'heads'), { recursive: true })
    fs.writeFileSync(refPath, commitOid + '\n')
  } catch (error) {
    console.error('Error syncing workdir to bare:', error.message)
    throw error
  }
}

export default async ({ knex, table }) => {
  const repoPath = join(__dirname, 'repos')
  const barePath = join(repoPath, 'bare.git')
  const workdirPath = join(__dirname, '..', 'workdir')

  try { fs.mkdirSync(repoPath, { recursive: true }) } catch(e) {}

  if (!fs.existsSync(barePath) && fs.existsSync(join(workdirPath, '.git'))) {
    try {
      await git.init({ fs, dir: barePath, bare: true, defaultBranch: 'master' })

      const gitDir = join(workdirPath, '.git')
      const currentBranch = await git.currentBranch({ fs, dir: workdirPath })

      if (fs.existsSync(join(gitDir, 'objects'))) {
        fs.cpSync(join(gitDir, 'objects'), join(barePath, 'objects'), { recursive: true })
      }
      if (fs.existsSync(join(gitDir, 'refs'))) {
        fs.cpSync(join(gitDir, 'refs'), join(barePath, 'refs'), { recursive: true })
      }
      if (currentBranch) {
        fs.writeFileSync(join(barePath, 'HEAD'), `ref: refs/heads/${currentBranch}\n`)
      }
    } catch (error) {
      console.error('Error creating bare repository:', error.message)
    }
  }
  
  let syncInProgress = false

  const repos = new Git(repoPath, {
    autoCreate: false,
    authenticate: ({ headers, repo, type }, next) => {
      const auth = async (authHeader) => {
        if (repo === 'bare' && type === 'fetch' && !syncInProgress) {
          syncInProgress = true
          try {
            await syncWorkdirToBare(workdirPath, barePath)
          } catch (error) {
            console.error('Sync failed:', error.message)
          } finally {
            syncInProgress = false
          }
        }

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
          const user = { ...payload, id: payload.sub }
          delete user.sub

          const guard = new UserGuard({ knex, table }, user.id)
          if (await guard.user({ canOneOf: ['manage_themes'] })) {
            next()
          } else {
            throw new Error('Permission denied')
          }
        } catch (e) {
          next(e?.message || e)
        }
      }
      auth(headers?.authorization || headers?.['authorization-x'])
    }
  })

  repos.on('push', async (push) => {
    push.accept()

    push.once('exit', async () => {
      if (push.repo !== 'bare.git' || !push.commit) return

      try {
        const { branch, commit: commitOid } = push
        const statusMatrix = await git.statusMatrix({ fs, dir: workdirPath })
        const changedFiles = []
        const hasChanges = statusMatrix.some(([filepath, h, w, s]) => {
          const changed = h !== w || w !== s
          if (changed) changedFiles.push(filepath)
          return changed
        })

        let stashOid = null
        if (hasChanges) {
          await git.add({ fs, dir: workdirPath, filepath: '.' })
          stashOid = await git.commit({
            fs,
            dir: workdirPath,
            message: `Auto-stash at ${new Date().toISOString()}`,
            author: { name: 'GitServer', email: 'auto@gitserver.local' }
          })
        }

        const copyNewObjects = (src, dest) => {
          if (!fs.existsSync(src)) return
          for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const srcPath = join(src, entry.name)
            const destPath = join(dest, entry.name)

            if (entry.isDirectory()) {
              fs.mkdirSync(destPath, { recursive: true })
              copyNewObjects(srcPath, destPath)
            } else if (!fs.existsSync(destPath)) {
              fs.copyFileSync(srcPath, destPath)
            }
          }
        }

        copyNewObjects(join(barePath, 'objects'), join(workdirPath, '.git', 'objects'))

        await git.writeRef({ fs, dir: workdirPath, ref: `refs/heads/${branch}`, value: commitOid, force: true })
        await git.checkout({ fs, dir: workdirPath, ref: branch, force: true })

        if (stashOid && changedFiles.length > 0) {
          setTimeout(async () => {
            try {
              const newStatusMatrix = await git.statusMatrix({ fs, dir: workdirPath })
              const currentFiles = new Set(newStatusMatrix.map(([filepath]) => filepath))

              for (const filepath of changedFiles) {
                if (currentFiles.has(filepath)) {
                  await git.checkout({ fs, dir: workdirPath, ref: stashOid, filepaths: [filepath] })
                }
              }
            } catch (error) {
              console.error('Failed to re-apply stash:', error.message)
            }
          }, 1000)
        }
      } catch (error) {
        console.error('Error updating workdir:', error.message)
      }
    })
  })

  repos.on('fetch', (fetch) => fetch.accept())

  return repos
}
