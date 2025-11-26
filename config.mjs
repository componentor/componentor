/**
 * Componentor Theme Persistence Configuration
 *
 * Specifies which files and directories should be preserved during theme upgrades/downgrades
 */

export default {
  // Directories to preserve during version changes
  persistent_directories: [
    'workdir',           // Git working directory with user's design work
    'node_modules',      // Installed npm dependencies (including node-git-server)
    'includes/repos',    // Git repositories (bare.git and related files)
    'client',
    'server'
  ],

  // Individual files to preserve during version changes
  persistent_files: [
    // Add any custom configuration files here
    // Example: 'custom-settings.json'
  ],
  skip_registry_paths: [
    '/api/v1/git/*',
    '/api/v1/git-build'
  ]
}
