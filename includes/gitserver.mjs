import { Git } from 'node-git-server'
import { join, dirname } from 'path'
import fs from 'fs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import UserGuard from '../../../../hd-core/utils/UserGuard.mjs'
import { fileURLToPath } from 'url'
import git from 'isomorphic-git'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Helper function to sync workdir changes to bare repo
async function syncWorkdirToBare(workdirPath, barePath) {
  try {
    console.log('Checking workdir for changes...')

    // Check if workdir has any changes (staged or unstaged)
    const statusMatrix = await git.statusMatrix({ fs, dir: workdirPath })
    const hasChanges = statusMatrix.some(row => {
      const [, headStatus, workdirStatus, stageStatus] = row
      return headStatus !== workdirStatus || workdirStatus !== stageStatus
    })

    if (hasChanges) {
      console.log('Workdir has changes, committing and syncing to bare repo...')

      // Get current branch, default to 'master' if detached HEAD
      let currentBranch = await git.currentBranch({ fs, dir: workdirPath })

      if (!currentBranch) {
        console.log('Workdir is in detached HEAD state, checking out master...')
        currentBranch = 'master'
        try {
          await git.checkout({ fs, dir: workdirPath, ref: 'master' })
        } catch (err) {
          console.log('Could not checkout master, attempting to create it...')
          try {
            await git.branch({ fs, dir: workdirPath, ref: currentBranch, checkout: true })
          } catch (branchErr) {
            // Branch exists but can't check out - force checkout
            console.log('Forcing checkout of master branch...')
            await git.checkout({ fs, dir: workdirPath, ref: 'master', force: true })
          }
        }
      }

      console.log(`Current branch: ${currentBranch}`)

      // Add all changes (both staged and unstaged, including deletions)
      await git.add({ fs, dir: workdirPath, filepath: '.' })

      // Commit the changes
      const commitOid = await git.commit({
        fs,
        dir: workdirPath,
        message: `Auto-commit at ${new Date().toISOString()}`,
        author: {
          name: 'GitServer Auto-Commit',
          email: 'auto-commit@gitserver.local'
        }
      })

      console.log(`Created commit in workdir: ${commitOid}`)

      // Use git.listObjects to get all objects and copy them properly
      // This ensures we get all objects including those in packfiles
      const workdirObjectsPath = join(workdirPath, '.git', 'objects')
      const bareObjectsPath = join(barePath, 'objects')

      // Copy all objects recursively, overwriting existing ones
      const copyAllObjects = (srcDir, destDir) => {
        if (!fs.existsSync(srcDir)) return

        const entries = fs.readdirSync(srcDir, { withFileTypes: true })
        for (const entry of entries) {
          const srcPath = join(srcDir, entry.name)
          const destPath = join(destDir, entry.name)

          if (entry.isDirectory()) {
            if (!fs.existsSync(destPath)) {
              fs.mkdirSync(destPath, { recursive: true })
            }
            copyAllObjects(srcPath, destPath)
          } else if (entry.isFile()) {
            try {
              // If file exists and is read-only, make it writable first
              if (fs.existsSync(destPath)) {
                fs.chmodSync(destPath, 0o644)
              }
              // Copy file
              fs.copyFileSync(srcPath, destPath)
            } catch (err) {
              console.warn(`Could not copy ${srcPath}: ${err.message}`)
            }
          }
        }
      }

      console.log('Copying objects from workdir to bare repo...')
      copyAllObjects(workdirObjectsPath, bareObjectsPath)

      // Update the branch ref in bare repo
      console.log(`Updating ref refs/heads/${currentBranch} to ${commitOid}`)

      // Write ref file directly to ensure it's updated
      const refPath = join(barePath, 'refs', 'heads', currentBranch)
      fs.mkdirSync(join(barePath, 'refs', 'heads'), { recursive: true })
      fs.writeFileSync(refPath, commitOid + '\n')

      console.log(`Bare repo ref updated successfully: ${commitOid}`)

      // Verify the ref was updated
      const fileContent = fs.readFileSync(refPath, 'utf8').trim()
      console.log(`Verified ref file contains: ${fileContent}`)
    } else {
      console.log('No changes in workdir to sync')
    }
  } catch (error) {
    console.error('Error syncing workdir to bare repo:', error.message)
    console.error(error.stack)
    throw error
  }
}

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
  
  let syncInProgress = false

  const repos = new Git(repoPath, {
    autoCreate: false,
    authenticate: ({ headers, repo, type }, next) => {
      console.log('Authenticate called:', { repo, type })

      let auth = async (authHeader) => {
        // Sync workdir to bare repo before any fetch/clone operation
        console.log('Auth function running, checking sync conditions:', {
          repo,
          type,
          isBare: repo === 'bare',
          isFetch: type === 'fetch',
          syncInProgress
        })

        if (repo === 'bare' && type === 'fetch' && !syncInProgress) {
          console.log('Starting sync before fetch/clone...')
          syncInProgress = true
          try {
            await syncWorkdirToBare(workdirPath, barePath)
          } catch (error) {
            console.error('Failed to sync workdir, continuing anyway:', error.message)
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

    // Wait for the push to complete, then update workdir
    push.once('exit', async () => {
      console.log('Push completed, updating workdir...', { repo: push.repo, branch: push.branch, commit: push.commit })
      if (push.repo === 'bare.git') {
        try {
          const branch = push.branch
          const commitOid = push.commit

          // Verify the commit exists in bare repo
          if (!commitOid) {
            console.error('No commit OID available from push')
            return
          }

          // Check if workdir has uncommitted changes that need stashing
          const statusMatrix = await git.statusMatrix({ fs, dir: workdirPath })
          const changedFiles = []
          const hasChanges = statusMatrix.some(row => {
            const [filepath, headStatus, workdirStatus, stageStatus] = row
            const changed = headStatus !== workdirStatus || workdirStatus !== stageStatus
            if (changed) {
              changedFiles.push(filepath)
            }
            return changed
          })

          let stashOid = null
          if (hasChanges) {
            console.log(`Stashing local changes in workdir before updating...`)

            // Add all changes to staging
            await git.add({ fs, dir: workdirPath, filepath: '.' })

            stashOid = await git.commit({
              fs,
              dir: workdirPath,
              message: `Auto-stash before push at ${new Date().toISOString()}`,
              author: {
                name: 'GitServer Auto-Stash',
                email: 'auto-stash@gitserver.local'
              }
            })
            console.log(`Created stash: ${stashOid}`)
          }

          // Copy objects from bare repo to workdir
          const bareObjectsPath = join(barePath, 'objects')
          const workdirObjectsPath = join(workdirPath, '.git', 'objects')

          // Copy new objects
          const copyNewObjects = (srcDir, destDir) => {
            if (!fs.existsSync(srcDir)) return

            const entries = fs.readdirSync(srcDir, { withFileTypes: true })
            for (const entry of entries) {
              const srcPath = join(srcDir, entry.name)
              const destPath = join(destDir, entry.name)

              if (entry.isDirectory()) {
                if (!fs.existsSync(destPath)) {
                  fs.mkdirSync(destPath, { recursive: true })
                }
                copyNewObjects(srcPath, destPath)
              } else if (entry.isFile()) {
                // Only copy if doesn't exist or is different
                if (!fs.existsSync(destPath)) {
                  fs.copyFileSync(srcPath, destPath)
                }
              }
            }
          }

          copyNewObjects(bareObjectsPath, workdirObjectsPath)

          // Update the branch ref in workdir
          await git.writeRef({ fs, dir: workdirPath, ref: `refs/heads/${branch}`, value: commitOid, force: true })

          // Checkout the new commit
          await git.checkout({ fs, dir: workdirPath, ref: branch, force: true })

          // Re-apply stashed changes if any
          if (stashOid && changedFiles.length > 0) {
            setTimeout(async () => {
              try {
                // Get the current state after checkout
                const newStatusMatrix = await git.statusMatrix({ fs, dir: workdirPath })
                const currentFiles = new Set(newStatusMatrix.map(([filepath]) => filepath))

                // Only restore files that still exist in the new commit
                // Don't restore files that were deleted in the push
                for (const filepath of changedFiles) {
                  try {
                    // Check if file exists in new commit
                    if (currentFiles.has(filepath)) {
                      await git.checkout({ fs, dir: workdirPath, ref: stashOid, filepaths: [filepath] })
                    } else {
                      console.log(`Skipping ${filepath} - deleted in pushed commit`)
                    }
                  } catch (err) {
                    console.warn(`Could not restore ${filepath}:`, err.message)
                  }
                }
                console.log(`Successfully re-applied stashed changes in workdir`)
              } catch (error) {
                console.error(`Warning: Failed to re-apply stash:`, error.message)
              }
            }, 1000)
          }

          console.log(`Successfully pushed changes to workdir (${branch})`)
        } catch (error) {
          console.error(`Error pushing to workdir:`, error.message)
          console.error(error.stack)
        }
      }
    })
  })

  repos.on('fetch', async (fetch) => {
    console.log(`fetch/clone ${fetch.repo}/${fetch.commit}`)
    fetch.accept()
  })

  return repos
}
