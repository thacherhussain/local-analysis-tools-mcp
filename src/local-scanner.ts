import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// The MCP server does NOT bundle ESLint - it runs the project's ESLint via subprocess.
// This ensures we always use the project's ESLint version and plugins, matching CI/CD behavior.

type ScanOptions = {
  projectDir: string
  files?: string[]
}

type ScanIssue = {
  file: string
  line: number
  column?: number
  message: string
  rule: string
  severity: string
  type: string
}

type ScanResult = {
  success: boolean
  taskId?: string
  issues: ScanIssue[]
  rawOutput: string
  error?: string
}

/**
 * Run local ESLint analysis on files using the project's ESLint via subprocess.
 * This ensures we use the project's exact ESLint version and plugins, matching CI/CD behavior.
 *
 * The MCP server is a pure orchestration tool - it does not bundle ESLint.
 */
export async function runLocalScan(options: ScanOptions): Promise<ScanResult> {
  const { projectDir, files } = options

  // Filter out files that shouldn't be linted
  const filteredFiles = (files || []).filter((f) => {
    const fileName = path.basename(f)
    // Exclude generated GraphQL files and generated operation files
    if (fileName.endsWith('.gqls.ts')) return false
    if (fileName.includes('generated-all-gql')) return false
    // Exclude story files
    if (fileName.includes('.stories.')) return false
    return true
  })

  if (filteredFiles.length === 0) {
    return {
      success: true,
      issues: [],
      rawOutput: 'No files to scan',
    }
  }

  // Get relative paths for ESLint
  const relativePaths = filteredFiles.map((f) => {
    const rel = path.relative(projectDir, f)
    return rel.startsWith('.') ? f : rel
  })

  return new Promise((resolve) => {
    const output: string[] = []
    const errorOutput: string[] = []

    // Run ESLint via npx in the project directory
    // Using JSON format for easy parsing
    const eslint = spawn(
      'npx',
      ['eslint', '--format', 'json', ...relativePaths],
      {
        cwd: projectDir,
        stdio: 'pipe',
      }
    )

    eslint.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    eslint.stderr.on('data', (data) => {
      errorOutput.push(data.toString())
    })

    eslint.on('close', (code) => {
      const rawOutput = output.join('')

      // ESLint exits with 1 if there are linting errors, which is expected
      // Only treat as failure if we can't parse the output
      try {
        const results = JSON.parse(rawOutput)
        const issues: ScanIssue[] = []

        for (const result of results) {
          for (const message of result.messages || []) {
            issues.push({
              file: result.filePath,
              line: message.line || 1,
              column: message.column,
              message: message.message,
              rule: message.ruleId || 'unknown',
              severity: message.severity === 2 ? 'MAJOR' : 'MINOR',
              type: getIssueType(message.ruleId || ''),
            })
          }
        }

        resolve({
          success: true,
          issues,
          rawOutput,
        })
      } catch {
        // Failed to parse JSON - ESLint might have crashed
        resolve({
          success: false,
          issues: [],
          rawOutput,
          error: errorOutput.join('') || 'ESLint failed to produce valid output',
        })
      }
    })

    eslint.on('error', (err) => {
      resolve({
        success: false,
        issues: [],
        rawOutput: '',
        error: `Failed to run ESLint: ${err.message}`,
      })
    })
  })
}

/**
 * Map ESLint rule IDs to issue types
 */
function getIssueType(ruleId: string): string {
  if (ruleId.startsWith('sonarjs/')) {
    // SonarJS ESLint plugin rules
    if (ruleId.includes('security') || ruleId.includes('injection')) {
      return 'VULNERABILITY'
    }
    if (
      ruleId.includes('cognitive-complexity') ||
      ruleId.includes('complexity')
    ) {
      return 'CODE_SMELL'
    }
    return 'CODE_SMELL'
  }

  // Common ESLint rules that indicate bugs
  const bugRules = [
    'no-undef',
    'no-unused-vars',
    'no-unreachable',
    'no-constant-condition',
    'no-dupe-keys',
    'no-duplicate-case',
    'use-isnan',
    'valid-typeof',
  ]
  if (bugRules.includes(ruleId)) {
    return 'BUG'
  }

  return 'CODE_SMELL'
}

export async function getChangedFiles(projectDir: string): Promise<string[]> {
  return new Promise((resolve) => {
    const git = spawn('git', ['diff', '--name-only', 'HEAD'], {
      cwd: projectDir,
    })

    const output: string[] = []
    git.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    git.on('close', () => {
      const files = output
        .join('')
        .split('\n')
        .filter((f) => f.trim().length > 0)
        .filter(
          (f) =>
            f.endsWith('.ts') ||
            f.endsWith('.tsx') ||
            f.endsWith('.js') ||
            f.endsWith('.jsx')
        )
        .map((f) => path.join(projectDir, f))
      resolve(files)
    })

    git.on('error', () => {
      resolve([])
    })
  })
}

export async function getStagedFiles(projectDir: string): Promise<string[]> {
  return new Promise((resolve) => {
    const git = spawn('git', ['diff', '--name-only', '--cached'], {
      cwd: projectDir,
    })

    const output: string[] = []
    git.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    git.on('close', () => {
      const files = output
        .join('')
        .split('\n')
        .filter((f) => f.trim().length > 0)
        .filter(
          (f) =>
            f.endsWith('.ts') ||
            f.endsWith('.tsx') ||
            f.endsWith('.js') ||
            f.endsWith('.jsx')
        )
        .map((f) => path.join(projectDir, f))
      resolve(files)
    })

    git.on('error', () => {
      resolve([])
    })
  })
}

export async function getLastCommitFiles(projectDir: string): Promise<string[]> {
  return new Promise((resolve) => {
    // Get files changed in the last commit
    const git = spawn('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], {
      cwd: projectDir,
    })

    const output: string[] = []
    git.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    git.on('close', () => {
      const files = output
        .join('')
        .split('\n')
        .filter((f) => f.trim().length > 0)
        .filter(
          (f) =>
            f.endsWith('.ts') ||
            f.endsWith('.tsx') ||
            f.endsWith('.js') ||
            f.endsWith('.jsx')
        )
        .map((f) => path.join(projectDir, f))
      resolve(files)
    })

    git.on('error', () => {
      resolve([])
    })
  })
}

/**
 * Get files changed on the current branch compared to the base branch.
 * Uses the three-dot diff syntax (baseBranch...HEAD) to find the merge-base.
 *
 * This function will:
 * 1. First try the baseBranch as provided (e.g., "origin/master" or "master")
 * 2. If that fails and baseBranch doesn't have "origin/", try with "origin/" prefix
 * 3. Log debug info to stderr to help diagnose issues
 */
export async function getBranchFiles(
  projectDir: string,
  baseBranch: string = 'master'
): Promise<string[]> {
  // Helper to run git diff and return files
  const runGitDiff = (branch: string): Promise<{ files: string[]; error: string }> => {
    return new Promise((resolve) => {
      const git = spawn('git', ['diff', '--name-only', `${branch}...HEAD`], {
        cwd: projectDir,
      })

      const output: string[] = []
      const errorOutput: string[] = []

      git.stdout.on('data', (data) => {
        output.push(data.toString())
      })

      git.stderr.on('data', (data) => {
        errorOutput.push(data.toString())
      })

      git.on('close', (code) => {
        const rawOutput = output.join('')
        const error = errorOutput.join('')

        if (code !== 0 || error) {
          resolve({ files: [], error: error || `Exit code: ${code}` })
          return
        }

        const files = rawOutput
          .split('\n')
          .filter((f) => f.trim().length > 0)
          .filter(
            (f) =>
              f.endsWith('.ts') ||
              f.endsWith('.tsx') ||
              f.endsWith('.js') ||
              f.endsWith('.jsx')
          )
          .map((f) => path.join(projectDir, f))

        resolve({ files, error: '' })
      })

      git.on('error', (err) => {
        resolve({ files: [], error: err.message })
      })
    })
  }

  // First attempt: use the baseBranch as provided
  let result = await runGitDiff(baseBranch)

  // If it failed and baseBranch doesn't already have origin/, try with origin/ prefix
  if (result.files.length === 0 && result.error && !baseBranch.includes('/')) {
    const remoteBranch = `origin/${baseBranch}`
    console.error(
      `[MCP] getBranchFiles: First attempt with "${baseBranch}" failed (${result.error}), trying "${remoteBranch}"`
    )
    result = await runGitDiff(remoteBranch)
  }

  // Log debug info if still no files found
  if (result.files.length === 0) {
    if (result.error) {
      console.error(
        `[MCP] getBranchFiles: No files found comparing to "${baseBranch}". Error: ${result.error}`
      )
    } else {
      console.error(
        `[MCP] getBranchFiles: No TS/JS files changed on branch compared to "${baseBranch}"`
      )
    }
  } else {
    console.error(
      `[MCP] getBranchFiles: Found ${result.files.length} file(s) changed on branch vs "${baseBranch}"`
    )
  }

  return result.files
}

type DirectoryFilesResult = {
  success: boolean
  files: string[]
  resolvedPath: string
  error?: string
}

/**
 * Get all TypeScript/JavaScript source files in a directory (excluding tests, stories, etc.)
 * Searches for the directory in multiple locations:
 * 1. Exact path from project root
 * 2. packages/<name>
 * 3. packages/<name>/src
 * 4. src/<name>
 */
export async function getDirectoryFiles(
  projectDir: string,
  directoryName: string
): Promise<DirectoryFilesResult> {
  // Try to find the directory in various locations
  const candidatePaths = [
    directoryName, // Exact path from project root
    path.join('packages', directoryName), // packages/<name>
    path.join('packages', directoryName, 'src'), // packages/<name>/src
    path.join('src', directoryName), // src/<name>
  ]

  let resolvedPath: string | null = null

  for (const candidate of candidatePaths) {
    const fullPath = path.join(projectDir, candidate)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      resolvedPath = candidate
      break
    }
  }

  if (!resolvedPath) {
    // Build helpful error message
    const triedPaths = candidatePaths
      .map((p) => `  - ${path.join(projectDir, p)}`)
      .join('\n')

    return {
      success: false,
      files: [],
      resolvedPath: '',
      error: `Directory "${directoryName}" not found. Searched in:\n${triedPaths}\n\nTip: Use a path relative to the project root, like "packages/mobile" or "src/components".`,
    }
  }

  const fullResolvedPath = path.join(projectDir, resolvedPath)

  return new Promise((resolve) => {
    // Use git ls-files for faster, cross-platform file listing
    // This leverages git's index which is already cached, making it much faster than find
    const git = spawn(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        resolvedPath,
      ],
      {
        cwd: projectDir,
      }
    )

    const output: string[] = []
    git.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    git.on('close', () => {
      const files = output
        .join('')
        .split('\n')
        .filter((f) => f.trim().length > 0)
        // Filter to only TS/TSX/JS/JSX files
        .filter(
          (f) =>
            f.endsWith('.ts') ||
            f.endsWith('.tsx') ||
            f.endsWith('.js') ||
            f.endsWith('.jsx')
        )
        // Exclude test files, stories, mocks
        .filter((f) => {
          const fileName = path.basename(f)
          if (fileName.includes('.test.')) return false
          if (fileName.includes('.spec.')) return false
          if (fileName.includes('.stories.')) return false
          if (f.includes('/__tests__/')) return false
          if (f.includes('/__mocks__/')) return false
          return true
        })
        // Convert to absolute paths
        .map((f) => path.join(projectDir, f))

      if (files.length === 0) {
        resolve({
          success: true,
          files: [],
          resolvedPath,
          error: `Directory "${resolvedPath}" exists but contains no TypeScript/JavaScript source files.`,
        })
      } else {
        resolve({
          success: true,
          files,
          resolvedPath,
        })
      }
    })

    git.on('error', (err) => {
      resolve({
        success: false,
        files: [],
        resolvedPath,
        error: `Error searching directory: ${err.message}`,
      })
    })
  })
}

type WorkingFilesResult = {
  all: string[]
  branch: string[]
  changed: string[]
  staged: string[]
}

/**
 * Get ALL working files: committed on branch + uncommitted + staged (deduplicated)
 * Returns breakdown to avoid duplicate git calls.
 * This is useful for check_branch/check_local to ensure nothing is missed
 */
export async function getAllWorkingFiles(
  projectDir: string,
  baseBranch: string = 'master'
): Promise<WorkingFilesResult> {
  const [branchFiles, changedFiles, stagedFiles] = await Promise.all([
    getBranchFiles(projectDir, baseBranch),
    getChangedFiles(projectDir),
    getStagedFiles(projectDir),
  ])

  // Combine and deduplicate
  const allFiles = new Set([...branchFiles, ...changedFiles, ...stagedFiles])
  return {
    all: [...allFiles],
    branch: branchFiles,
    changed: changedFiles,
    staged: stagedFiles,
  }
}

/**
 * Get files changed on branch filtered by directory
 */
export async function getBranchFilesByDirectory(
  projectDir: string,
  baseBranch: string,
  directoryName: string
): Promise<string[]> {
  const allBranchFiles = await getBranchFiles(projectDir, baseBranch)

  // Try to resolve the directory path (same logic as getDirectoryFiles)
  const candidatePaths = [
    directoryName,
    path.join('packages', directoryName),
    path.join('packages', directoryName, 'src'),
    path.join('src', directoryName),
  ]

  let resolvedPrefix: string | null = null

  for (const candidate of candidatePaths) {
    const fullPath = path.join(projectDir, candidate)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      resolvedPrefix = candidate
      break
    }
  }

  if (!resolvedPrefix) {
    // If we can't find the directory, return empty array
    return []
  }

  return allBranchFiles.filter((f) => {
    const relativePath = path.relative(projectDir, f)
    return relativePath.startsWith(resolvedPrefix + '/')
  })
}

type ChangedLine = {
  file: string
  line: number
}

// Cache for getChangedLines to avoid re-parsing diffs during repeated checks
type ChangedLinesCache = {
  key: string // baseBranch:HEAD combination
  data: Map<string, Set<number>>
  timestamp: number
}

let changedLinesCache: ChangedLinesCache | null = null
const CACHE_TTL_MS = 30000 // 30 seconds - short enough to catch new commits

/**
 * Get the current HEAD commit hash for cache key generation
 */
const getHeadCommit = (projectDir: string): Promise<string> => {
  return new Promise((resolve) => {
    const git = spawn('git', ['rev-parse', 'HEAD'], { cwd: projectDir })
    const output: string[] = []
    git.stdout.on('data', (data) => output.push(data.toString()))
    git.on('close', () => resolve(output.join('').trim()))
    git.on('error', () => resolve(''))
  })
}

type FileCoverage = {
  file: string
  relativePath: string
  totalLines: number
  coveredLines: number
  coveragePercent: number
  newLines: number
  newLinesCovered: number
  newCodeCoveragePercent: number
  uncoveredLines: number[]
  uncoveredNewLines: number[]
}

type CoverageResult = {
  success: boolean
  files: FileCoverage[]
  summary: {
    totalFiles: number
    overallCoverage: number
    newCodeCoverage: number
    totalLines: number
    coveredLines: number
    totalNewLines: number
    coveredNewLines: number
  }
  error?: string
  rawOutput?: string
}

/**
 * Get the specific lines that were added/modified in each file compared to base branch.
 * Results are cached by (baseBranch, HEAD) to avoid re-parsing diffs during repeated checks.
 *
 * This function will:
 * 1. First try the baseBranch as provided (e.g., "origin/master" or "master")
 * 2. If that fails and baseBranch doesn't have "origin/", try with "origin/" prefix
 */
export async function getChangedLines(
  projectDir: string,
  baseBranch: string
): Promise<Map<string, Set<number>>> {
  // Check cache first
  const headCommit = await getHeadCommit(projectDir)
  const cacheKey = `${baseBranch}:${headCommit}`
  const now = Date.now()

  if (
    changedLinesCache &&
    changedLinesCache.key === cacheKey &&
    now - changedLinesCache.timestamp < CACHE_TTL_MS
  ) {
    // Return cached result
    return changedLinesCache.data
  }

  // Helper to run git diff and parse results
  const runGitDiff = (
    branch: string
  ): Promise<{ lines: Map<string, Set<number>>; error: string }> => {
    return new Promise((resolve) => {
      const git = spawn('git', ['diff', '-U0', `${branch}...HEAD`], {
        cwd: projectDir,
      })

      const output: string[] = []
      const errorOutput: string[] = []

      git.stdout.on('data', (data) => {
        output.push(data.toString())
      })

      git.stderr.on('data', (data) => {
        errorOutput.push(data.toString())
      })

      git.on('close', (code) => {
        const error = errorOutput.join('')

        if (code !== 0 || error) {
          resolve({ lines: new Map(), error: error || `Exit code: ${code}` })
          return
        }

        const changedLinesResult = new Map<string, Set<number>>()
        const diffOutput = output.join('')

        let currentFile = ''
        const diffLines = diffOutput.split('\n')

        for (const line of diffLines) {
          // Match file header: +++ b/path/to/file.ts
          const fileMatch = line.match(/^\+\+\+ b\/(.+)$/)
          if (fileMatch) {
            currentFile = fileMatch[1]
            if (!changedLinesResult.has(currentFile)) {
              changedLinesResult.set(currentFile, new Set())
            }
            continue
          }

          // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
          const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
          if (hunkMatch && currentFile) {
            const startLine = parseInt(hunkMatch[1], 10)
            const lineCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1

            const fileLines = changedLinesResult.get(currentFile)!
            for (let i = 0; i < lineCount; i++) {
              fileLines.add(startLine + i)
            }
          }
        }

        resolve({ lines: changedLinesResult, error: '' })
      })

      git.on('error', (err) => {
        resolve({ lines: new Map(), error: err.message })
      })
    })
  }

  // First attempt: use the baseBranch as provided
  let result = await runGitDiff(baseBranch)

  // If it failed and baseBranch doesn't already have origin/, try with origin/ prefix
  if (result.lines.size === 0 && result.error && !baseBranch.includes('/')) {
    const remoteBranch = `origin/${baseBranch}`
    console.error(
      `[MCP] getChangedLines: First attempt with "${baseBranch}" failed (${result.error}), trying "${remoteBranch}"`
    )
    result = await runGitDiff(remoteBranch)
  }

  // Cache the result
  changedLinesCache = {
    key: cacheKey,
    data: result.lines,
    timestamp: now,
  }

  return result.lines
}

/**
 * Run Jest with coverage for specific files and analyze the results
 */
type DuplicationResult = {
  success: boolean
  summary: {
    totalFiles: number
    totalLines: number
    duplicatedLines: number
    duplicatedPercent: number
    clones: number
  }
  duplicates: Array<{
    format: string
    lines: number
    tokens: number
    firstFile: { name: string; startLine: number; endLine: number }
    secondFile: { name: string; startLine: number; endLine: number }
  }>
  newCodeDuplication?: {
    duplicatedNewLines: number
    totalNewLines: number
    duplicatedPercent: number
  }
  error?: string
  rawOutput?: string
}

/**
 * Check for duplicated code in files using jscpd
 * Compares against the entire codebase to find duplications, then filters
 * to show only duplications involving the specified files
 */
export async function checkDuplication(
  projectDir: string,
  files: string[],
  baseBranch: string = '',
  precomputedChangedLines?: Map<string, Set<number>>
): Promise<DuplicationResult> {
  if (files.length === 0) {
    return {
      success: true,
      summary: {
        totalFiles: 0,
        totalLines: 0,
        duplicatedLines: 0,
        duplicatedPercent: 0,
        clones: 0,
      },
      duplicates: [],
    }
  }

  // Use precomputed changed lines if provided, otherwise fetch
  const changedLines =
    precomputedChangedLines ??
    (baseBranch
      ? await getChangedLines(projectDir, baseBranch)
      : new Map<string, Set<number>>())

  // Get the relative paths of changed files for filtering
  const changedFilePaths = new Set(
    files.map((f) => path.relative(projectDir, f))
  )

  // Extract unique parent directories from changed files to limit scan scope
  // This is more precise than scanning entire packages - we scan only the directories
  // containing changed files, which catches local duplicates efficiently
  const affectedDirs = [
    ...new Set(
      files
        .map((f) => {
          const rel = path.relative(projectDir, f)
          // Get the parent directory of the file
          const parentDir = path.dirname(rel)
          // For monorepos, try to use package-level or src-level directories
          // e.g., packages/mobile/src/components/Foo.tsx -> packages/mobile/src/components
          // But if it's a top-level file, use the file's directory
          if (parentDir && parentDir !== '.') {
            return parentDir
          }
          return null
        })
        .filter((p): p is string => p !== null)
    ),
  ]

  // Deduplicate by removing child directories if parent is already included
  const scanPaths = affectedDirs.filter((dir) => {
    // Check if any other directory is a parent of this one
    return !affectedDirs.some(
      (other) => other !== dir && dir.startsWith(other + '/')
    )
  })

  // Fall back to packages/ or src/ if we can't determine affected dirs
  const finalScanPaths =
    scanPaths.length > 0
      ? scanPaths
      : fs.existsSync(path.join(projectDir, 'packages'))
        ? ['packages/']
        : fs.existsSync(path.join(projectDir, 'src'))
          ? ['src/']
          : ['.']

  return new Promise((resolve) => {
    const output: string[] = []

    // Use system temp directory to avoid polluting the project
    const jscpdOutputDir = path.join(os.tmpdir(), `mcp-jscpd-${Date.now()}`)

    // Run jscpd only on affected directories (not entire codebase)
    // This significantly speeds up duplication detection while still catching
    // local duplicates (the most common case)
    const jscpd = spawn(
      'npx',
      [
        'jscpd',
        '--reporters',
        'json',
        '--output',
        jscpdOutputDir,
        '--min-lines',
        '5',
        '--min-tokens',
        '50',
        '--ignore',
        '"**/*.test.*,**/*.spec.*,**/*.stories.*,**/*.testdata.*,**/__tests__/**,**/__mocks__/**,**/node_modules/**,**/*.d.ts,**/*.gqls.ts"',
        ...finalScanPaths, // Scan only affected directories instead of entire codebase
      ],
      {
        cwd: projectDir,
        env: { ...process.env },
        shell: true,
      }
    )

    jscpd.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    jscpd.stderr.on('data', (data) => {
      output.push(data.toString())
    })

    jscpd.on('close', () => {
      const rawOutput = output.join('')

      try {
        // Read the jscpd JSON output
        const jsonPath = path.join(jscpdOutputDir, 'jscpd-report.json')

        if (!fs.existsSync(jsonPath)) {
          // Clean up temp directory (may not exist if jscpd didn't create it)
          try {
            fs.rmSync(jscpdOutputDir, { recursive: true, force: true })
          } catch {
            // Ignore cleanup errors
          }

          // No duplications found - jscpd might not create output
          resolve({
            success: true,
            summary: {
              totalFiles: files.length,
              totalLines: 0,
              duplicatedLines: 0,
              duplicatedPercent: 0,
              clones: 0,
            },
            duplicates: [],
            newCodeDuplication: baseBranch
              ? {
                  duplicatedNewLines: 0,
                  totalNewLines: [...changedLines.values()].reduce(
                    (sum, set) => sum + set.size,
                    0
                  ),
                  duplicatedPercent: 0,
                }
              : undefined,
          })
          return
        }

        const report = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))

        // Parse all duplicates from the report
        const allDuplicates = (report.duplicates || []).map(
          (d: {
            format: string
            lines: number
            tokens: number
            firstFile: { name: string; start: number; end: number }
            secondFile: { name: string; start: number; end: number }
          }) => ({
            format: d.format,
            lines: d.lines,
            tokens: d.tokens,
            firstFile: {
              name: d.firstFile.name,
              startLine: d.firstFile.start,
              endLine: d.firstFile.end,
            },
            secondFile: {
              name: d.secondFile.name,
              startLine: d.secondFile.start,
              endLine: d.secondFile.end,
            },
          })
        )

        // Filter to only duplications involving at least one changed file
        const duplicates = allDuplicates.filter(
          (d: {
            firstFile: { name: string }
            secondFile: { name: string }
          }) => {
            const file1Match = changedFilePaths.has(d.firstFile.name)
            const file2Match = changedFilePaths.has(d.secondFile.name)
            return file1Match || file2Match
          }
        )

        // Calculate new code duplication
        let duplicatedNewLines = 0
        let totalNewLines = 0

        if (baseBranch) {
          totalNewLines = [...changedLines.values()].reduce(
            (sum, set) => sum + set.size,
            0
          )

          // Check which duplicated lines overlap with new lines
          // Only count lines in the changed files
          for (const dup of duplicates) {
            const file1Lines = changedLines.get(dup.firstFile.name) || new Set()
            const file2Lines =
              changedLines.get(dup.secondFile.name) || new Set()

            // Only count if the file is a changed file
            if (changedFilePaths.has(dup.firstFile.name)) {
              for (
                let line = dup.firstFile.startLine;
                line <= dup.firstFile.endLine;
                line++
              ) {
                if (file1Lines.has(line)) duplicatedNewLines++
              }
            }
            if (changedFilePaths.has(dup.secondFile.name)) {
              for (
                let line = dup.secondFile.startLine;
                line <= dup.secondFile.endLine;
                line++
              ) {
                if (file2Lines.has(line)) duplicatedNewLines++
              }
            }
          }
        }

        // Calculate stats for just the changed files
        let duplicatedLinesInChangedFiles = 0
        for (const dup of duplicates) {
          if (changedFilePaths.has(dup.firstFile.name)) {
            duplicatedLinesInChangedFiles += dup.lines
          }
          // Don't double count if both files are changed files in same duplication
          if (
            changedFilePaths.has(dup.secondFile.name) &&
            dup.firstFile.name !== dup.secondFile.name
          ) {
            duplicatedLinesInChangedFiles += dup.lines
          }
        }

        const stats = report.statistics?.total || {}

        // For the summary, report stats relevant to the changed files
        // not the entire codebase
        resolve({
          success: true,
          summary: {
            totalFiles: files.length,
            totalLines: stats.lines || 0, // This is total scanned, we'll note it's codebase-wide
            duplicatedLines: duplicatedLinesInChangedFiles,
            duplicatedPercent:
              duplicatedLinesInChangedFiles > 0 && stats.lines > 0
                ? Math.round(
                    (duplicatedLinesInChangedFiles / stats.lines) * 100 * 10
                  ) / 10
                : 0,
            clones: duplicates.length, // Only clones involving changed files
          },
          duplicates,
          newCodeDuplication: baseBranch
            ? {
                duplicatedNewLines,
                totalNewLines,
                duplicatedPercent:
                  totalNewLines > 0
                    ? Math.round(
                        (duplicatedNewLines / totalNewLines) * 100 * 10
                      ) / 10
                    : 0,
              }
            : undefined,
        })

        // Clean up temp directory
        try {
          fs.rmSync(jscpdOutputDir, { recursive: true, force: true })
        } catch {
          // Ignore cleanup errors
        }
      } catch (error) {
        // Clean up temp directory on error
        try {
          fs.rmSync(jscpdOutputDir, { recursive: true, force: true })
        } catch {
          // Ignore cleanup errors
        }

        resolve({
          success: false,
          summary: {
            totalFiles: 0,
            totalLines: 0,
            duplicatedLines: 0,
            duplicatedPercent: 0,
            clones: 0,
          },
          duplicates: [],
          error: error instanceof Error ? error.message : String(error),
          rawOutput,
        })
      }
    })

    jscpd.on('error', (err) => {
      // Clean up temp directory on error
      try {
        fs.rmSync(jscpdOutputDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }

      resolve({
        success: false,
        summary: {
          totalFiles: 0,
          totalLines: 0,
          duplicatedLines: 0,
          duplicatedPercent: 0,
          clones: 0,
        },
        duplicates: [],
        error: err.message,
        rawOutput: output.join(''),
      })
    })
  })
}

export async function checkCoverage(
  projectDir: string,
  files: string[],
  baseBranch: string = 'master',
  precomputedChangedLines?: Map<string, Set<number>>
): Promise<CoverageResult> {
  if (files.length === 0) {
    return {
      success: true,
      files: [],
      summary: {
        totalFiles: 0,
        overallCoverage: 100,
        newCodeCoverage: 100,
        totalLines: 0,
        coveredLines: 0,
        totalNewLines: 0,
        coveredNewLines: 0,
      },
    }
  }

  // Use precomputed changed lines if provided, otherwise fetch
  const changedLines =
    precomputedChangedLines ??
    (baseBranch
      ? await getChangedLines(projectDir, baseBranch)
      : new Map<string, Set<number>>())

  // Build collectCoverageFrom patterns
  const relativePaths = files.map((f) => path.relative(projectDir, f))
  const collectFrom = relativePaths.map((f) => `"${f}"`).join(',')

  return new Promise((resolve) => {
    const output: string[] = []

    // Run Jest with JSON coverage output, storing in system temp directory to avoid polluting the project
    const coverageDir = path.join(os.tmpdir(), `mcp-coverage-${Date.now()}`)
    
    // Use --findRelatedTests for faster test discovery instead of regex --testPathPattern
    // This lets Jest use its dependency graph to find only tests that import the changed files
    const jest = spawn(
      'npx',
      [
        'jest',
        '--coverage',
        '--coverageReporters=json',
        `--coverageDirectory=${coverageDir}`,
        '--collectCoverageFrom',
        relativePaths.join(','),
        '--passWithNoTests',
        '--silent',
        '--findRelatedTests',
        ...files, // Pass the actual source files for Jest to find related tests
      ],
      {
        cwd: projectDir,
        env: { ...process.env },
        shell: true,
      }
    )

    jest.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    jest.stderr.on('data', (data) => {
      output.push(data.toString())
    })

    jest.on('close', async (code) => {
      const rawOutput = output.join('')

      // Helper to clean up the temp coverage directory
      const cleanup = (): void => {
        try {
          fs.rmSync(coverageDir, { recursive: true, force: true })
        } catch {
          // Ignore cleanup errors
        }
      }

      // Try to read the coverage JSON file
      const coverageJsonPath = path.join(coverageDir, 'coverage-final.json')

      try {
        if (!fs.existsSync(coverageJsonPath)) {
          cleanup()
          resolve({
            success: false,
            files: [],
            summary: {
              totalFiles: 0,
              overallCoverage: 0,
              newCodeCoverage: 0,
              totalLines: 0,
              coveredLines: 0,
              totalNewLines: 0,
              coveredNewLines: 0,
            },
            error:
              'Coverage file not generated. Make sure tests exist for the files.',
            rawOutput,
          })
          return
        }

        const coverageData = JSON.parse(
          fs.readFileSync(coverageJsonPath, 'utf-8')
        )
        const fileCoverages: FileCoverage[] = []

        let totalLines = 0
        let coveredLines = 0
        let totalNewLines = 0
        let coveredNewLines = 0

        for (const [filePath, data] of Object.entries(coverageData)) {
          const fileData = data as {
            statementMap: Record<
              string,
              { start: { line: number }; end: { line: number } }
            >
            s: Record<string, number>
          }

          const relativePath = path.relative(projectDir, filePath)
          const fileChangedLines = changedLines.get(relativePath) || new Set()

          // Get all executable lines and their coverage
          const executableLines = new Set<number>()
          const coveredLinesSet = new Set<number>()

          for (const [stmtId, stmt] of Object.entries(fileData.statementMap)) {
            for (let line = stmt.start.line; line <= stmt.end.line; line++) {
              executableLines.add(line)
              if (fileData.s[stmtId] > 0) {
                coveredLinesSet.add(line)
              }
            }
          }

          const fileTotal = executableLines.size
          const fileCovered = coveredLinesSet.size

          // Calculate new code coverage
          const newLinesInFile = [...fileChangedLines].filter((l) =>
            executableLines.has(l)
          )
          const coveredNewLinesInFile = newLinesInFile.filter((l) =>
            coveredLinesSet.has(l)
          )

          const uncoveredLines = [...executableLines]
            .filter((l) => !coveredLinesSet.has(l))
            .sort((a, b) => a - b)
          const uncoveredNewLines = newLinesInFile
            .filter((l) => !coveredLinesSet.has(l))
            .sort((a, b) => a - b)

          fileCoverages.push({
            file: filePath,
            relativePath,
            totalLines: fileTotal,
            coveredLines: fileCovered,
            coveragePercent:
              fileTotal > 0
                ? Math.round((fileCovered / fileTotal) * 100 * 10) / 10
                : 100,
            newLines: newLinesInFile.length,
            newLinesCovered: coveredNewLinesInFile.length,
            newCodeCoveragePercent:
              newLinesInFile.length > 0
                ? Math.round(
                    (coveredNewLinesInFile.length / newLinesInFile.length) *
                      100 *
                      10
                  ) / 10
                : 100,
            uncoveredLines: uncoveredLines.slice(0, 20), // Limit to first 20
            uncoveredNewLines,
          })

          totalLines += fileTotal
          coveredLines += fileCovered
          totalNewLines += newLinesInFile.length
          coveredNewLines += coveredNewLinesInFile.length
        }

        cleanup()

        resolve({
          success: true,
          files: fileCoverages,
          summary: {
            totalFiles: fileCoverages.length,
            overallCoverage:
              totalLines > 0
                ? Math.round((coveredLines / totalLines) * 100 * 10) / 10
                : 100,
            newCodeCoverage:
              totalNewLines > 0
                ? Math.round((coveredNewLines / totalNewLines) * 100 * 10) / 10
                : 100,
            totalLines,
            coveredLines,
            totalNewLines,
            coveredNewLines,
          },
        })
      } catch (error) {
        cleanup()

        resolve({
          success: false,
          files: [],
          summary: {
            totalFiles: 0,
            overallCoverage: 0,
            newCodeCoverage: 0,
            totalLines: 0,
            coveredLines: 0,
            totalNewLines: 0,
            coveredNewLines: 0,
          },
          error: error instanceof Error ? error.message : String(error),
          rawOutput,
        })
      }
    })

    jest.on('error', (err) => {
      // Clean up coverage directory on error
      try {
        fs.rmSync(coverageDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }

      resolve({
        success: false,
        files: [],
        summary: {
          totalFiles: 0,
          overallCoverage: 0,
          newCodeCoverage: 0,
          totalLines: 0,
          coveredLines: 0,
          totalNewLines: 0,
          coveredNewLines: 0,
        },
        error: err.message,
        rawOutput: output.join(''),
      })
    })
  })
}

/**
 * Extract naming pattern from a file (e.g., "LoanCancelledTile.tsx" -> "*Tile.tsx")
 */
const getFilePattern = (filePath: string): string | null => {
  const fileName = path.basename(filePath)
  const ext = path.extname(fileName)
  const baseName = fileName.replace(ext, '')

  // Common patterns: *Tile, *Screen, *Hook, *Container, *Component, *Context, *Provider
  const patterns = [
    'Tile',
    'Screen',
    'Hook',
    'Container',
    'Component',
    'Context',
    'Provider',
    'Modal',
    'Card',
    'Button',
    'Form',
    'List',
    'Item',
    'View',
    'Page',
  ]

  for (const pattern of patterns) {
    if (baseName.endsWith(pattern)) {
      return `*${pattern}${ext}`
    }
  }

  // Check for use* prefix (hooks)
  if (baseName.startsWith('use') && baseName.length > 3) {
    return `use*${ext}`
  }

  return null
}

/**
 * Find files similar to the given file based on:
 * 1. Same directory
 * 2. Similar naming pattern (*Tile.tsx, *Screen.tsx, etc.)
 * 3. Same parent feature folder
 */
const findSimilarFiles = async (
  projectDir: string,
  targetFile: string,
  maxFiles: number = 5
): Promise<string[]> => {
  const targetDir = path.dirname(targetFile)
  const targetPattern = getFilePattern(targetFile)
  const targetExt = path.extname(targetFile)

  // Get parent directory (feature folder)
  const parentDir = path.dirname(targetDir)

  const similarFiles: Array<{ file: string; score: number }> = []

  // Helper to recursively find files
  const findFilesInDir = (dir: string, depth: number = 0): string[] => {
    if (depth > 3) return [] // Don't go too deep

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const files: string[] = []

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          // Skip node_modules, __tests__, __mocks__, etc.
          if (
            ![
              'node_modules',
              '__tests__',
              '__mocks__',
              '.git',
              'dist',
              'build',
            ].includes(entry.name)
          ) {
            files.push(...findFilesInDir(fullPath, depth + 1))
          }
        } else if (entry.isFile()) {
          // Only include TS/TSX files
          if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            // Exclude test files
            if (
              !entry.name.includes('.test.') &&
              !entry.name.includes('.spec.')
            ) {
              files.push(fullPath)
            }
          }
        }
      }

      return files
    } catch {
      return []
    }
  }

  // 1. Find files in the same directory
  const sameDirFiles = findFilesInDir(targetDir, 0).filter(
    (f) => f !== targetFile
  )

  // 2. Find files in parent/sibling directories with same pattern
  const parentDirFiles = findFilesInDir(parentDir, 0).filter(
    (f) => f !== targetFile && !sameDirFiles.includes(f)
  )

  // Score each file
  for (const file of [...sameDirFiles, ...parentDirFiles]) {
    let score = 0
    const filePattern = getFilePattern(file)

    // Same directory = high score
    if (path.dirname(file) === targetDir) {
      score += 10
    }

    // Same naming pattern = high score
    if (targetPattern && filePattern === targetPattern) {
      score += 20
    }

    // Same extension
    if (path.extname(file) === targetExt) {
      score += 5
    }

    // In parent directory structure
    if (file.startsWith(parentDir)) {
      score += 3
    }

    if (score > 0) {
      similarFiles.push({ file, score })
    }
  }

  // Sort by score and return top files
  return similarFiles
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map((f) => f.file)
}

/**
 * Extract imports from a TypeScript/JavaScript file
 */
const extractImports = (content: string): string[] => {
  const importRegex =
    /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g
  const imports: string[] = []
  let match

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1])
  }

  return imports
}

/**
 * Extract hook usage from a component
 */
const extractHookUsage = (content: string): string[] => {
  const hookRegex = /(?:const|let)\s+(?:{[^}]+}|\w+)\s*=\s*(use\w+)\s*\(/g
  const hooks: string[] = []
  let match

  while ((match = hookRegex.exec(content)) !== null) {
    hooks.push(match[1])
  }

  return [...new Set(hooks)]
}

type ReviewFile = {
  path: string
  relativePath: string
  content: string
  imports: string[]
  hooks: string[]
  isChanged: boolean
}

type ReviewContext = {
  changedFiles: ReviewFile[]
  similarFiles: ReviewFile[]
  sharedHooks: string[]
  sharedImports: string[]
}

/**
 * Gather context for AI-based code review
 * Returns changed files along with similar files for comparison
 */
export async function gatherReviewContext(
  projectDir: string,
  files: string[],
  maxSimilarPerFile: number = 3
): Promise<ReviewContext> {
  const changedFiles: ReviewFile[] = []
  const similarFilesMap = new Map<string, ReviewFile>()
  const allHooks: string[] = []
  const allImports: string[] = []

  // Process each changed file
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8')
      const relativePath = path.relative(projectDir, file)
      const imports = extractImports(content)
      const hooks = extractHookUsage(content)

      changedFiles.push({
        path: file,
        relativePath,
        content,
        imports,
        hooks,
        isChanged: true,
      })

      allHooks.push(...hooks)
      allImports.push(...imports)

      // Find similar files
      const similar = await findSimilarFiles(
        projectDir,
        file,
        maxSimilarPerFile
      )

      for (const simFile of similar) {
        if (!similarFilesMap.has(simFile)) {
          try {
            const simContent = fs.readFileSync(simFile, 'utf-8')
            const simRelPath = path.relative(projectDir, simFile)
            const simImports = extractImports(simContent)
            const simHooks = extractHookUsage(simContent)

            similarFilesMap.set(simFile, {
              path: simFile,
              relativePath: simRelPath,
              content: simContent,
              imports: simImports,
              hooks: simHooks,
              isChanged: false,
            })
          } catch {
            // Skip files that can't be read
          }
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Find shared hooks and imports
  const changedHooks = new Set(allHooks)
  const similarHooks = new Set(
    [...similarFilesMap.values()].flatMap((f) => f.hooks)
  )
  const sharedHooks = [...changedHooks].filter((h) => similarHooks.has(h))

  const changedImportSet = new Set(
    allImports.filter((i) => i.startsWith('.') || i.startsWith('@'))
  )
  const similarImportSet = new Set(
    [...similarFilesMap.values()]
      .flatMap((f) => f.imports)
      .filter((i) => i.startsWith('.') || i.startsWith('@'))
  )
  const sharedImports = [...changedImportSet].filter((i) =>
    similarImportSet.has(i)
  )

  return {
    changedFiles,
    similarFiles: [...similarFilesMap.values()],
    sharedHooks,
    sharedImports,
  }
}
