import { join, dirname, resolve } from 'path'
import fs from 'fs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import UserGuard from '../../../../hd-core/utils/UserGuard.mjs'
import { fileURLToPath, pathToFileURL } from 'url'
import git from 'isomorphic-git'
import { spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const themeDir = resolve(__dirname, '..')

// Import node-git-server from the theme's node_modules using relative path
const nodeGitServerPath = join(themeDir, 'node_modules', 'node-git-server', 'dist', 'index.js')
const gitServerModule = await import(pathToFileURL(nodeGitServerPath).href)
// CommonJS module, so the exports are on .default for ESM import
const Git = gitServerModule.default?.Git || gitServerModule.Git

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

export default async ({ knex, table, onBuildStart, onBuildProgress, onBuildComplete } = {}) => {
  const repoPath = join(__dirname, 'repos')
  const barePath = join(repoPath, 'bare.git')
  const workdirPath = join(__dirname, '..', 'workdir')

  try { fs.mkdirSync(repoPath, { recursive: true }) } catch(e) {}

  // Initialize workdir as git repo if it exists but isn't a git repo yet
  if (fs.existsSync(workdirPath) && !fs.existsSync(join(workdirPath, '.git'))) {
    try {
      await git.init({ fs, dir: workdirPath, defaultBranch: 'master' })
      // Stage and commit all existing files
      await git.add({ fs, dir: workdirPath, filepath: '.' })
      await git.commit({
        fs,
        dir: workdirPath,
        message: 'Initial commit',
        author: { name: 'GitServer', email: 'auto@gitserver.local' }
      })
      console.log('Initialized git repository in workdir')
    } catch (error) {
      console.error('Error initializing workdir git repo:', error.message)
    }
  }

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
  let buildInProgress = false

  const runBuild = () => {
    if (buildInProgress) {
      return Promise.reject(new Error('Build already in progress'))
    }

    buildInProgress = true
    if (onBuildStart) onBuildStart()

    // Ensure .npmrc exists for @vueplayio registry
    const npmrcPath = join(workdirPath, '.npmrc')
    if (!fs.existsSync(npmrcPath)) {
      fs.writeFileSync(npmrcPath, `@vueplayio:registry=https://manager.vueplay.io/
#//manager.vueplay.io/:_authToken=replace_with_token
`)
    }

    return new Promise((resolve, reject) => {
      // Run npm install first, then npm run build
      const npmInstall = spawn('npm', ['install'], {
        cwd: workdirPath,
        shell: true
      })

      // Progress tracking for npm install (0-10%)
      let installProgress = 0
      const installSteps = {
        'reify:': 2,
        'http fetch': 3,
        'added': 7,
        'packages': 8,
        'up to date': 10,
        'audited': 10
      }

      const updateInstallProgress = (output) => {
        const lower = output.toLowerCase()
        for (const [key, value] of Object.entries(installSteps)) {
          if (lower.includes(key) && value > installProgress) {
            installProgress = value
            return installProgress
          }
        }
        // Gradually increase progress on any output if still low
        if (installProgress < 6) {
          installProgress += 0.5
        }
        return Math.min(installProgress, 10)
      }

      let installStdout = ''
      let installStderr = ''

      npmInstall.stdout.on('data', (data) => {
        const output = data.toString()
        installStdout += output
        const currentProgress = updateInstallProgress(output)
        if (onBuildProgress) onBuildProgress(output, 'stdout', currentProgress)
      })

      npmInstall.stderr.on('data', (data) => {
        const output = data.toString()
        installStderr += output
        const currentProgress = updateInstallProgress(output)
        if (onBuildProgress) onBuildProgress(output, 'stderr', currentProgress)
      })

      npmInstall.on('error', (error) => {
        console.error('npm install error:', error.message)
        buildInProgress = false
        if (onBuildComplete) onBuildComplete(error, null)
        reject(error)
      })

      npmInstall.on('close', (installCode) => {
        if (installCode !== 0) {
          buildInProgress = false
          console.error('npm install failed:', installStderr || installStdout)
          const error = new Error(`npm install failed with code ${installCode}: ${installStderr.slice(-500) || installStdout.slice(-500)}`)
          if (onBuildComplete) onBuildComplete(error, null)
          return reject(error)
        }

        // Now run the build
        const npmBuild = spawn('npm', ['run', 'build'], {
          cwd: workdirPath,
          shell: true
        })

        let stdout = ''
        let stderr = ''
        let progress = 0
        const steps = {
          'vite v': 10,
          'building for production': 20,
          'transforming': 40,
          'rendering chunks': 60,
          'computing gzip size': 80,
          'built in': 100
        }

        const updateProgress = (output) => {
          const lower = output.toLowerCase()
          for (const [key, value] of Object.entries(steps)) {
            if (lower.includes(key) && value > progress) {
              progress = value
              return progress
            }
          }
          return progress
        }

        npmBuild.stdout.on('data', (data) => {
          const output = data.toString()
          stdout += output
          const currentProgress = updateProgress(output)
          if (onBuildProgress) onBuildProgress(output, 'stdout', currentProgress)
        })

        npmBuild.stderr.on('data', (data) => {
          const output = data.toString()
          stderr += output
          const currentProgress = updateProgress(output)
          if (onBuildProgress) onBuildProgress(output, 'stderr', currentProgress)
        })

        npmBuild.on('error', (error) => {
          console.error('Build process error:', error.message)
          buildInProgress = false
          if (onBuildComplete) onBuildComplete(error, null)
          reject(error)
        })

        npmBuild.on('close', (code) => {
          buildInProgress = false
          const result = { code, stdout, stderr, success: code === 0 }
          if (onBuildComplete) onBuildComplete(null, result)

          if (code === 0) {
            resolve(result)
          } else {
            reject(new Error(`Build failed with code ${code}`))
          }
        })
      })
    })
  }

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

        // Auto-build after push
        runBuild().catch(err => console.error('Auto-build failed:', err.message))
      } catch (error) {
        console.error('Error updating workdir:', error.message)
      }
    })
  })

  repos.on('fetch', (fetch) => fetch.accept())

  repos.build = runBuild

  return repos
}
