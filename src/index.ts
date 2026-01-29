#!/usr/bin/env node

// Load environment variables from .env file if it exists
import 'dotenv/config'

import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import {
  runLocalScan,
  getChangedFiles,
  getStagedFiles,
  getBranchFiles,
  getBranchFilesByDirectory,
  getDirectoryFiles,
  getAllWorkingFiles,
  getLastCommitFiles,
  checkCoverage,
  checkDuplication,
  getChangedLines,
  gatherReviewContext,
} from './local-scanner.js'

// Cache for the detected workspace directory
let cachedWorkspaceDir: string | null = null

/**
 * Find project root by walking up from a given path looking for .git + package.json
 */
function findProjectRoot(startPath: string): string | null {
  let current = startPath
  const root = path.parse(current).root

  while (current !== root) {
    const hasGit = fs.existsSync(path.join(current, '.git'))
    const hasPackageJson = fs.existsSync(path.join(current, 'package.json'))

    if (hasGit && hasPackageJson) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) break // Reached root
    current = parent
  }

  return null
}

/**
 * Get the workspace directory. Tries multiple strategies in order:
 * 1. Cached workspace (from previous detection or MCP roots)
 * 2. WORKSPACE_PATH environment variable (set in MCP config)
 * 3. Walk up from process.cwd() looking for .git + package.json (project root)
 * 4. Fall back to process.cwd()
 */
function getWorkspaceDir(): string {
  // Strategy 1: Return cached workspace if available
  if (cachedWorkspaceDir) {
    return cachedWorkspaceDir
  }

  // Strategy 2: Check for explicit WORKSPACE_PATH env var
  const envWorkspace = process.env.WORKSPACE_PATH
  if (envWorkspace && fs.existsSync(envWorkspace)) {
    cachedWorkspaceDir = envWorkspace
    return envWorkspace
  }

  // Strategy 3: Walk up from cwd looking for project root indicators
  const projectRoot = findProjectRoot(process.cwd())
  if (projectRoot) {
    cachedWorkspaceDir = projectRoot
    return projectRoot
  }

  // Strategy 4: Fall back to cwd
  return process.cwd()
}

/**
 * Attempt to detect workspace from file paths provided in tool arguments.
 * This is called when a tool receives file paths, allowing us to infer
 * the workspace from the first valid file path we see.
 */
function detectWorkspaceFromFilePaths(files: string[]): void {
  if (cachedWorkspaceDir) return // Already have a workspace

  for (const file of files) {
    if (!path.isAbsolute(file)) continue
    if (!fs.existsSync(file)) continue

    const projectRoot = findProjectRoot(path.dirname(file))
    if (projectRoot) {
      cachedWorkspaceDir = projectRoot
      console.error(`[MCP] Auto-detected workspace from file path: ${projectRoot}`)
      return
    }
  }
}

/**
 * Set the workspace directory explicitly (e.g., from MCP roots)
 */
function setWorkspaceDir(dir: string): void {
  if (fs.existsSync(dir)) {
    cachedWorkspaceDir = dir
    console.error(`[MCP] Workspace set to: ${dir}`)
  }
}

/**
 * Get workspace detection info for debugging
 */
function getWorkspaceInfo(): {
  workspace: string
  source: string
  cached: boolean
} {
  const workspace = getWorkspaceDir()
  let source = 'fallback (cwd)'

  if (cachedWorkspaceDir) {
    if (process.env.WORKSPACE_PATH === cachedWorkspaceDir) {
      source = 'WORKSPACE_PATH env var'
    } else {
      source = 'auto-detected'
    }
  } else if (process.env.WORKSPACE_PATH) {
    source = 'WORKSPACE_PATH env var'
  } else if (findProjectRoot(process.cwd())) {
    source = 'cwd project detection'
  }

  return {
    workspace,
    source,
    cached: !!cachedWorkspaceDir,
  }
}

const server = new Server(
  {
    name: 'local-analysis-tools-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

/**
 * Try to get workspace roots from the MCP client (Cursor).
 * This is called after the server connects to request workspace info.
 */
async function requestWorkspaceRoots(): Promise<void> {
  try {
    // Request roots from the client using the MCP protocol
    // The client (Cursor) should respond with the workspace directories
    const response = await server.request(
      { method: 'roots/list' },
      ListRootsResultSchema
    )

    if (response?.roots && response.roots.length > 0) {
      // Use the first root as our workspace
      const rootUri = response.roots[0].uri
      // Convert file:// URI to path
      const rootPath = rootUri.startsWith('file://')
        ? decodeURIComponent(rootUri.replace('file://', ''))
        : rootUri

      if (fs.existsSync(rootPath)) {
        setWorkspaceDir(rootPath)
        console.error(`[MCP] Got workspace from client roots: ${rootPath}`)
      }
    }
  } catch (error) {
    // Client may not support roots - that's okay, we'll use fallback detection
    console.error(
      `[MCP] Client does not support roots capability, using fallback detection`
    )
  }
}

const tools: Tool[] = [
  {
    name: 'lint_branch',
    description:
      'Run ESLint analysis on all files for the current branch: committed files (compared to base branch), uncommitted changes, and staged files.',
    inputSchema: {
      type: 'object',
      properties: {
        baseBranch: {
          type: 'string',
          description: 'Base branch to compare against (defaults to master)',
        },
      },
    },
  },
  {
    name: 'lint_local',
    description:
      'Run ESLint analysis on all uncommitted and staged files (work-in-progress changes).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lint_last_commit',
    description:
      'Run ESLint analysis on all files changed in the most recent commit.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lint_files',
    description:
      'Run ESLint analysis on specific files. Provide an array of file paths relative to the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            'Array of file paths to lint (relative to workspace root)',
        },
          },
      required: ['files'],
    },
  },
  {
    name: 'check_coverage',
    description:
      'Run tests and check code coverage. Supports checking branch changes, specific packages, or specific files. Returns both overall coverage and "new code" coverage (lines added/modified vs base branch).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['branch', 'directory', 'files'],
          description:
            'What to check: "branch" (files changed on branch), "directory" (entire directory like packages/mobile or src/components), or "files" (specific files). Defaults to "branch".',
        },
        directory: {
          type: 'string',
          description:
            'Directory name to check coverage for (required if scope is "directory"). Can be a package name (e.g., "mobile") or a path (e.g., "packages/mobile" or "src/components").',
        },
        files: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            'Array of file paths to check (required if scope is "files")',
        },
        includeNewCodeMetrics: {
          type: 'boolean',
    description:
            'Whether to calculate new code coverage (lines changed vs base branch). Defaults to true for branch scope, false for package scope.',
        },
        baseBranch: {
          type: 'string',
    description:
            'Base branch to compare against for "new code" calculation (defaults to master)',
        },
      },
    },
  },
  {
    name: 'check_committed',
    description:
      'Run all checks on committed files only: linting, coverage, and duplication. Checks files changed on the branch compared to the base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        baseBranch: {
          type: 'string',
          description: 'Base branch to compare against (defaults to master)',
        },
      },
    },
  },
  {
    name: 'check_local',
    description:
      'Run all checks on uncommitted and staged files only: linting, coverage, and duplication. Checks work-in-progress changes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_branch',
    description:
      'Run all checks on all branch files: committed files (compared to base branch), uncommitted changes, and staged files. Provides a summary of issues and asks if you want suggestions to fix problems, improve coverage, or reduce duplication.',
    inputSchema: {
      type: 'object',
      properties: {
        baseBranch: {
          type: 'string',
          description: 'Base branch to compare against (defaults to master)',
        },
      },
    },
  },
  {
    name: 'test_mcp',
    description:
      'Test that the MCP server is working correctly. Checks workspace detection, git availability, ESLint, Jest, jscpd, and basic functionality. Returns a comprehensive status report.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ai_review',
    description:
      'Gather context for AI-based code review. Returns changed files along with similar files for comparison, enabling detection of convention violations, inconsistencies, and logic issues. Use this when asked questions like "do my changes break any conventions?" or "are there any logic issues in my changes?"',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['branch', 'staged', 'uncommitted'],
          description:
            'What to review: "branch" (all changes on branch vs base), "staged" (staged files only), "uncommitted" (uncommitted changes). Defaults to "branch".',
        },
        baseBranch: {
          type: 'string',
          description: 'Base branch to compare against (defaults to master)',
        },
        maxSimilarFiles: {
          type: 'number',
          description:
            'Maximum similar files to include per changed file (defaults to 3)',
        },
      },
    },
  },
  {
    name: 'check_duplication',
    description:
      'Check for duplicated code in files. Reports overall duplication percentage and "new code" duplication (duplicated lines in code added/modified on this branch).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['branch', 'directory', 'files'],
          description:
            'What to check: "branch" (files changed on branch), "directory" (entire directory like packages/mobile or src/components), or "files" (specific files). Defaults to "branch".',
        },
        directory: {
          type: 'string',
          description:
            'Directory name to check (required if scope is "directory"). Can be a package name (e.g., "mobile") or a path (e.g., "packages/mobile" or "src/components").',
        },
        files: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            'Array of file paths to check (required if scope is "files")',
        },
        baseBranch: {
          type: 'string',
          description:
            'Base branch for "new code" calculation (defaults to master)',
        },
      },
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}))

// Handle roots/list_changed notification from the client
// This allows the server to update its workspace when Cursor's workspace changes
server.setNotificationHandler(
  RootsListChangedNotificationSchema,
  async () => {
    console.error('[MCP] Received roots/list_changed notification, refreshing workspace...')
    // Clear cached workspace and request new roots
    cachedWorkspaceDir = null
    await requestWorkspaceRoots()
  }
)

// Helper to format elapsed time
const formatElapsed = (startTime: number): string => {
  const elapsed = Date.now() - startTime
  if (elapsed < 1000) return `${elapsed}ms`
  return `${(elapsed / 1000).toFixed(1)}s`
}

// Helper to time an async operation and return both result and duration
const timed = async <T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> => {
  const start = Date.now()
  const result = await fn()
  return { result, durationMs: Date.now() - start }
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const startTime = Date.now()

  try {
    switch (name) {
      case 'lint_branch': {
        const projectDir = getWorkspaceDir()
        const baseBranch = (args?.baseBranch as string) || 'master'

        // Get all files: committed + uncommitted + staged
        const workingFiles = await getAllWorkingFiles(projectDir, baseBranch)
        const allFiles = workingFiles.all

        if (allFiles.length === 0) {
        return {
          content: [
            {
              type: 'text',
                text: `No TypeScript/JavaScript files found for this branch (committed, uncommitted, or staged).`,
            },
          ],
        }
      }

        const result = await runLocalScan({
          projectDir,
          files: allFiles,
        })

        if (!result.success) {
        return {
          content: [
            {
              type: 'text',
                text: `ESLint lint failed: ${result.error}`,
              },
            ],
            isError: true,
          }
        }
        
        const committedCount = workingFiles.branch.length
        const uncommittedCount = workingFiles.changed.filter(
          (f) => !workingFiles.branch.includes(f)
        ).length
        const stagedCount = workingFiles.staged.filter(
          (f) =>
            !workingFiles.branch.includes(f) &&
            !workingFiles.changed.includes(f)
        ).length

        if (result.issues.length === 0) {
        return {
          content: [
            {
              type: 'text',
                text: `Linted **${
                  allFiles.length
                } file(s)** on this branch (${committedCount} committed, ${uncommittedCount} uncommitted, ${stagedCount} staged) vs \`${baseBranch}\`. **No issues found.** ✅ ⏱️ *${formatElapsed(
                  startTime
                )}*`,
            },
          ],
        }
      }

        const issueRows = result.issues
          .slice(0, 20)
          .map((i) => {
            const fileName = i.file.split('/').pop() || i.file
            return `| ${fileName} | ${i.line} | ${i.severity} | ${
              i.rule
            } | ${i.message.slice(0, 40)}${
              i.message.length > 40 ? '...' : ''
            } |`
          })
          .join('\n')
        
        return {
          content: [
            {
              type: 'text',
              text: `Linted **${
                allFiles.length
              } file(s)** on this branch (${committedCount} committed, ${uncommittedCount} uncommitted, ${stagedCount} staged) vs \`${baseBranch}\`. Found **${
                result.issues.length
              } issue(s)**. ⏱️ *${formatElapsed(startTime)}*

| File | Line | Severity | Rule | Message |
|------|------|----------|------|---------|
${issueRows}
${
  result.issues.length > 20
    ? `\n*...and ${result.issues.length - 20} more issues*`
    : ''
}`,
            },
          ],
        }
      }

      case 'lint_local': {
        const projectDir = getWorkspaceDir()

        // Get uncommitted and staged files
        const [changedFiles, stagedFiles] = await Promise.all([
          getChangedFiles(projectDir),
          getStagedFiles(projectDir),
        ])

        // Combine and deduplicate
        const allFiles = [...new Set([...changedFiles, ...stagedFiles])]

        if (allFiles.length === 0) {
        return {
          content: [
            {
              type: 'text',
                text: 'No uncommitted or staged TypeScript/JavaScript files found.',
            },
          ],
        }
      }
        
        const result = await runLocalScan({
          projectDir,
          files: allFiles,
        })

        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `ESLint lint failed: ${result.error}`,
              },
            ],
            isError: true,
          }
        }

        const uncommittedOnly = changedFiles.filter(
          (f) => !stagedFiles.includes(f)
        ).length
        const stagedOnly = stagedFiles.filter(
          (f) => !changedFiles.includes(f)
        ).length
        const both = allFiles.length - uncommittedOnly - stagedOnly

        if (result.issues.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Linted **${
                  allFiles.length
                } local file(s)** (${uncommittedOnly} uncommitted, ${stagedOnly} staged, ${both} both) with ESLint. **No issues found.** ✅ ⏱️ *${formatElapsed(
                  startTime
                )}*`,
              },
            ],
          }
        }

        const issueRows = result.issues
          .slice(0, 20)
          .map((i) => {
          const fileName = i.file.split('/').pop() || i.file
            return `| ${fileName} | ${i.line} | ${i.severity} | ${
              i.rule
            } | ${i.message.slice(0, 40)}${
              i.message.length > 40 ? '...' : ''
            } |`
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `Linted **${
                allFiles.length
              } local file(s)** (${uncommittedOnly} uncommitted, ${stagedOnly} staged, ${both} both) with ESLint. Found **${
                result.issues.length
              } issue(s)**. ⏱️ *${formatElapsed(startTime)}*

| File | Line | Severity | Rule | Message |
|------|------|----------|------|---------|
${issueRows}
${
  result.issues.length > 20
    ? `\n*...and ${result.issues.length - 20} more issues*`
    : ''
}`,
            },
          ],
        }
      }

      case 'lint_last_commit': {
        const projectDir = getWorkspaceDir()
        const commitFiles = await getLastCommitFiles(projectDir)

        if (commitFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No TypeScript/JavaScript files found in the most recent commit.',
              },
            ],
          }
        }

        const result = await runLocalScan({
          projectDir,
          files: commitFiles,
        })

        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `ESLint lint failed: ${result.error}`,
              },
            ],
            isError: true,
          }
        }

        if (result.issues.length === 0) {
        return {
          content: [
            {
              type: 'text',
                text: `Linted **${
                  commitFiles.length
                } file(s)** from the most recent commit with ESLint. **No issues found.** ✅ ⏱️ *${formatElapsed(
                  startTime
                )}*`,
              },
            ],
          }
        }

        const issueRows = result.issues
          .slice(0, 20)
          .map((i) => {
          const fileName = i.file.split('/').pop() || i.file
            return `| ${fileName} | ${i.line} | ${i.severity} | ${
              i.rule
            } | ${i.message.slice(0, 40)}${
              i.message.length > 40 ? '...' : ''
            } |`
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `Linted **${
                commitFiles.length
              } file(s)** from the most recent commit with ESLint. Found **${
                result.issues.length
              } issue(s)**. ⏱️ *${formatElapsed(startTime)}*

| File | Line | Severity | Rule | Message |
|------|------|----------|------|---------|
${issueRows}
${
  result.issues.length > 20
    ? `\n*...and ${result.issues.length - 20} more issues*`
    : ''
}`,
            },
          ],
        }
      }

      case 'lint_files': {
        const filePaths = (args?.files as string[]) || []

        if (filePaths.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No files provided. Please specify an array of file paths.',
              },
            ],
            isError: true,
          }
        }

        // Try to auto-detect workspace from absolute file paths
        detectWorkspaceFromFilePaths(filePaths)
        const projectDir = getWorkspaceDir()

        // Convert relative paths to absolute paths
        const absolutePaths = filePaths.map((f) => {
          if (path.isAbsolute(f)) {
            return f
          }
          return path.join(projectDir, f)
        })

        // Filter to only TypeScript/JavaScript files
        const tsJsFiles = absolutePaths.filter(
          (f) =>
            f.endsWith('.ts') ||
            f.endsWith('.tsx') ||
            f.endsWith('.js') ||
            f.endsWith('.jsx')
        )

        if (tsJsFiles.length === 0) {
        return {
          content: [
            {
              type: 'text',
                text: 'No TypeScript/JavaScript files found in the provided file list.',
              },
            ],
          }
        }

        const result = await runLocalScan({
          projectDir,
          files: tsJsFiles,
        })

        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `ESLint lint failed: ${result.error}`,
              },
            ],
            isError: true,
          }
        }

        if (result.issues.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Linted **${
                  tsJsFiles.length
                } file(s)** with ESLint. **No issues found.** ✅ ⏱️ *${formatElapsed(
                  startTime
                )}*`,
              },
            ],
          }
        }

        const issueRows = result.issues
          .slice(0, 20)
          .map((i) => {
          const fileName = i.file.split('/').pop() || i.file
            return `| ${fileName} | ${i.line} | ${i.severity} | ${
              i.rule
            } | ${i.message.slice(0, 40)}${
              i.message.length > 40 ? '...' : ''
            } |`
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `Linted **${
                tsJsFiles.length
              } file(s)** with ESLint. Found **${
                result.issues.length
              } issue(s)**. ⏱️ *${formatElapsed(startTime)}*

| File | Line | Severity | Rule | Message |
|------|------|----------|------|---------|
${issueRows}
${
  result.issues.length > 20
    ? `\n*...and ${result.issues.length - 20} more issues*`
    : ''
}`,
            },
          ],
        }
      }

      case 'check_coverage': {
        const projectDir = getWorkspaceDir()
        const baseBranch = (args?.baseBranch as string) || 'master'
        const scope = (args?.scope as string) || 'branch'
        const directoryName = args?.directory as string | undefined
        let files = args?.files as string[] | undefined
        const includeNewCodeMetrics = args?.includeNewCodeMetrics as
          | boolean
          | undefined
        
        // Determine files based on scope
        let scopeDescription = ''
        
        switch (scope) {
          case 'directory': {
            if (!directoryName) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Error: "directory" parameter is required when scope is "directory". Provide a directory path like "packages/mobile", "src/components", or just "mobile".',
                  },
                ],
                isError: true,
              }
            }
            const dirResult = await getDirectoryFiles(projectDir, directoryName)
            if (!dirResult.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: dirResult.error || `Directory "${directoryName}" not found.`,
                  },
                ],
                isError: true,
              }
            }
            files = dirResult.files
            scopeDescription = `directory: ${dirResult.resolvedPath}`
            break
          }
            
          case 'files':
            if (!files || files.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Error: "files" parameter is required when scope is "files".',
                  },
                ],
                isError: true,
              }
            }
            scopeDescription = `${files.length} specific file(s)`
            break
            
          case 'branch':
          default:
            if (directoryName) {
              // Branch changes filtered by directory
              files = await getBranchFilesByDirectory(
                projectDir,
                baseBranch,
                directoryName
              )
              scopeDescription = `branch changes in ${directoryName}`
            } else {
              files = await getBranchFiles(projectDir, baseBranch)
              scopeDescription = `branch changes vs ${baseBranch}`
            }
            break
        }
        
        if (!files || files.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No TypeScript/JavaScript files found for scope: ${scopeDescription}`,
              },
            ],
          }
        }

        // Default: include new code metrics for branch scope, exclude for directory scope (too slow)
        const shouldIncludeNewCode =
          includeNewCodeMetrics ?? (scope === 'branch' || scope === 'files')

        const result = await checkCoverage(
          projectDir,
          files,
          shouldIncludeNewCode ? baseBranch : ''
        )

        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Coverage check failed: ${result.error}\n\n${
                  result.rawOutput || ''
                }`,
              },
            ],
            isError: true,
          }
        }

        // Build formatted response
        const newCodeInfo =
          shouldIncludeNewCode && result.summary.totalNewLines > 0
          ? ` New code coverage: **${result.summary.newCodeCoverage}%** (${result.summary.coveredNewLines}/${result.summary.totalNewLines} lines).`
          : ''
        
        const summaryText = `Checked coverage for **${scopeDescription}** (${result.summary.totalFiles} file(s)). Overall coverage: **${result.summary.overallCoverage}%** (${result.summary.coveredLines}/${result.summary.totalLines} lines).${newCodeInfo}`
        
        // Build file table
        const fileHeaders = shouldIncludeNewCode 
          ? '| File | Overall | New Code | Uncovered New Lines |'
          : '| File | Coverage | Lines Covered |'
        const fileSeparator = shouldIncludeNewCode
          ? '|------|---------|----------|---------------------|'
          : '|------|----------|---------------|'
        
        const fileRows = result.files
          .slice(0, 15)
          .map((f) => {
          const fileName = f.relativePath.split('/').pop() || f.relativePath
            const shortName =
              fileName.length > 30 ? fileName.slice(0, 27) + '...' : fileName
          
          if (shouldIncludeNewCode) {
              const uncoveredNew =
                f.uncoveredNewLines.length > 0
                  ? f.uncoveredNewLines.slice(0, 5).join(', ') +
                    (f.uncoveredNewLines.length > 5 ? '...' : '')
                  : '✅'
              return `| ${shortName} | ${f.coveragePercent}% | ${
                f.newLines > 0 ? f.newCodeCoveragePercent + '%' : 'N/A'
              } | ${uncoveredNew} |`
          } else {
            return `| ${shortName} | ${f.coveragePercent}% | ${f.coveredLines}/${f.totalLines} |`
          }
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `${summaryText}

${fileHeaders}
${fileSeparator}
${fileRows}
${
  result.files.length > 15
    ? `\n*...and ${result.files.length - 15} more files*`
    : ''
}

⏱️ *${formatElapsed(startTime)}*`,
            },
          ],
        }
      }

      case 'check_committed': {
        const projectDir = getWorkspaceDir()
        const baseBranch = (args?.baseBranch as string) || 'master'
        
        // Get files changed on the branch
        const branchFiles = await getBranchFiles(projectDir, baseBranch)
        
        if (branchFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No TypeScript/JavaScript files changed on this branch compared to \`${baseBranch}\`. Nothing to check.`,
              },
            ],
          }
        }

        const fileNames = branchFiles.map((f) => f.split('/').pop()).join(', ')
        
        // Pre-compute changed lines once to share with coverage and duplication checks
        const changedLines = await getChangedLines(projectDir, baseBranch)
        
        // Run all three checks in parallel with timing, passing pre-computed changedLines
        const [lintTimed, coverageTimed, duplicationTimed] = await Promise.all([
          timed(() =>
            runLocalScan({
            projectDir,
            files: branchFiles,
            })
          ),
          timed(() =>
            checkCoverage(projectDir, branchFiles, baseBranch, changedLines)
          ),
          timed(() =>
            checkDuplication(projectDir, branchFiles, baseBranch, changedLines)
          ),
        ])

        const lintResult = lintTimed.result
        const coverageResult = coverageTimed.result
        const duplicationResult = duplicationTimed.result

        // Build summary with timing
        const lintStatus =
          lintResult.success && lintResult.issues.length === 0
          ? '✅ No issues' 
          : `⚠️ ${lintResult.issues.length} issue(s)`
        
        const coverageStatus = coverageResult.success 
          ? coverageResult.summary.newCodeCoverage >= 80
              ? `✅ ${coverageResult.summary.newCodeCoverage}%`
            : `⚠️ ${coverageResult.summary.newCodeCoverage}%`
          : '❌ Failed'
        
        const newCodeDupPercent =
          duplicationResult.newCodeDuplication?.duplicatedPercent || 0
        const duplicationStatus = duplicationResult.success
          ? newCodeDupPercent <= 3
              ? `✅ ${newCodeDupPercent}%`
            : `⚠️ ${newCodeDupPercent}%`
          : '❌ Failed'

        // Determine what needs attention
        const issues: string[] = []
        if (lintResult.issues.length > 0) {
          issues.push('linting issues')
        }
        if (
          coverageResult.success &&
          coverageResult.summary.newCodeCoverage < 80
        ) {
          issues.push('low coverage')
        }
        if (duplicationResult.success && newCodeDupPercent > 3) {
          issues.push('code duplication')
        }

        // Build detailed sections
        let details = ''
        
        // Linting details
        if (lintResult.issues.length > 0) {
          const issueRows = lintResult.issues
            .slice(0, 5)
            .map((i) => {
            const fileName = i.file.split('/').pop() || i.file
              return `| ${fileName} | ${i.line} | ${i.rule} | ${i.message.slice(
                0,
                35
              )}${i.message.length > 35 ? '...' : ''} |`
            })
            .join('\n')
          
          details += `
### Linting Issues (${lintResult.issues.length})

| File | Line | Rule | Message |
|------|------|------|---------|
${issueRows}
${
  lintResult.issues.length > 5
    ? `*...and ${lintResult.issues.length - 5} more*`
    : ''
}`
        }
        
        // Coverage details
        if (coverageResult.success) {
          const lowCoverageFiles = coverageResult.files
            .filter((f) => f.newLines > 0 && f.newCodeCoveragePercent < 80)
            .slice(0, 5)
          
          if (lowCoverageFiles.length > 0) {
            const coverageRows = lowCoverageFiles
              .map((f) => {
                const fileName =
                  f.relativePath.split('/').pop() || f.relativePath
                const uncovered =
                  f.uncoveredNewLines.slice(0, 3).join(', ') +
                  (f.uncoveredNewLines.length > 3 ? '...' : '')
              return `| ${fileName} | ${f.newCodeCoveragePercent}% | ${uncovered} |`
              })
              .join('\n')
            
            details += `

### Files Needing Tests

| File | New Code Coverage | Uncovered Lines |
|------|-------------------|-----------------|
${coverageRows}`
          }
        }
        
        // Duplication details
        if (
          duplicationResult.success &&
          duplicationResult.duplicates.length > 0
        ) {
          const dupRows = duplicationResult.duplicates
            .slice(0, 3)
            .map((d) => {
              const file1 =
                d.firstFile.name.split('/').pop() || d.firstFile.name
              const file2 =
                d.secondFile.name.split('/').pop() || d.secondFile.name
            return `| ${file1}:${d.firstFile.startLine}-${d.firstFile.endLine} | ${file2}:${d.secondFile.startLine}-${d.secondFile.endLine} | ${d.lines} |`
            })
            .join('\n')
          
          details += `

### Duplicated Code (${duplicationResult.duplicates.length} clone(s))

| Your Code | Duplicates | Lines |
|-----------|------------|-------|
${dupRows}`
        }

        // Build call to action
        let callToAction = ''
        if (issues.length > 0) {
          callToAction = `

---

**Would you like me to help?** Ask:
${
  lintResult.issues.length > 0
    ? '- "Fix the linting issues" - I\'ll make minimal changes to resolve them\n'
    : ''
}${
            coverageResult.success &&
            coverageResult.summary.newCodeCoverage < 80
              ? '- "Add tests for uncovered lines" - I\'ll suggest focused tests for new code\n'
              : ''
          }${
            newCodeDupPercent > 3
              ? '- "Reduce the duplication" - I\'ll suggest how to refactor duplicated code\n'
              : ''
          }`
        } else {
          callToAction = `

---

**All checks passed!** Your branch looks ready for merge.`
        }

        return {
          content: [
            {
              type: 'text',
              text: `## Check Committed Summary

Checked **${
                branchFiles.length
              } file(s)** changed on this branch vs \`${baseBranch}\`. ⏱️ *Total: ${formatElapsed(
                startTime
              )}*

| Check | Status | Time | Details |
|-------|--------|------|---------|
| **Linting** | ${lintStatus} | ${formatDuration(
                lintTimed.durationMs
              )} | ESLint issues in changed files |
| **New Code Coverage** | ${coverageStatus} | ${formatDuration(
                coverageTimed.durationMs
              )} | Test coverage on added/modified lines |
| **New Code Duplication** | ${duplicationStatus} | ${formatDuration(
                duplicationTimed.durationMs
              )} | Copy-pasted code in new lines |
${details}${callToAction}`,
            },
          ],
        }
      }

      case 'check_local': {
        const projectDir = getWorkspaceDir()

        // Get uncommitted and staged files
        const [changedFiles, stagedFiles] = await Promise.all([
          getChangedFiles(projectDir),
          getStagedFiles(projectDir),
        ])

        // Combine and deduplicate
        const allFiles = [...new Set([...changedFiles, ...stagedFiles])]

        if (allFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No uncommitted or staged TypeScript/JavaScript files found. Nothing to check.`,
              },
            ],
          }
        }

        // Calculate breakdown
        const uncommittedOnly = changedFiles.filter(
          (f) => !stagedFiles.includes(f)
        ).length
        const stagedOnly = stagedFiles.filter(
          (f) => !changedFiles.includes(f)
        ).length
        const both = allFiles.length - uncommittedOnly - stagedOnly

        // Pre-compute changed lines once to share with coverage and duplication checks
        // For local files, we don't have a base branch comparison, so we'll use empty changedLines
        const changedLines = new Map<string, Set<number>>()

        // Run all three checks in parallel with timing
        const [lintTimed, coverageTimed, duplicationTimed] = await Promise.all([
          timed(() =>
            runLocalScan({
              projectDir,
              files: allFiles,
            })
          ),
          timed(() => checkCoverage(projectDir, allFiles, '', changedLines)),
          timed(() => checkDuplication(projectDir, allFiles, '', changedLines)),
        ])

        const lintResult = lintTimed.result
        const coverageResult = coverageTimed.result
        const duplicationResult = duplicationTimed.result

        // Build summary with timing
        const lintStatus =
          lintResult.success && lintResult.issues.length === 0
            ? '✅ No issues'
            : `⚠️ ${lintResult.issues.length} issue(s)`

        const coverageStatus = coverageResult.success
          ? coverageResult.summary.newCodeCoverage >= 80
            ? `✅ ${coverageResult.summary.newCodeCoverage}%`
            : `⚠️ ${coverageResult.summary.newCodeCoverage}%`
          : '❌ Failed'

        const newCodeDupPercent =
          duplicationResult.newCodeDuplication?.duplicatedPercent || 0
        const duplicationStatus = duplicationResult.success
          ? newCodeDupPercent <= 3
            ? `✅ ${newCodeDupPercent}%`
            : `⚠️ ${newCodeDupPercent}%`
          : '❌ Failed'

        // Determine what needs attention
        const issues: string[] = []
        if (lintResult.issues.length > 0) {
          issues.push('linting issues')
        }
        if (
          coverageResult.success &&
          coverageResult.summary.newCodeCoverage < 80
        ) {
          issues.push('low coverage')
        }
        if (duplicationResult.success && newCodeDupPercent > 3) {
          issues.push('code duplication')
        }

        // Build detailed sections
        let details = ''

        // Linting details
        if (lintResult.issues.length > 0) {
          const issueRows = lintResult.issues
            .slice(0, 5)
            .map((i) => {
              const fileName = i.file.split('/').pop() || i.file
              return `| ${fileName} | ${i.line} | ${i.rule} | ${i.message.slice(
                0,
                35
              )}${i.message.length > 35 ? '...' : ''} |`
            })
            .join('\n')

          details += `
### Linting Issues (${lintResult.issues.length})

| File | Line | Rule | Message |
|------|------|------|---------|
${issueRows}
${
  lintResult.issues.length > 5
    ? `*...and ${lintResult.issues.length - 5} more*`
    : ''
}`
        }

        // Coverage details
        if (coverageResult.success) {
          const lowCoverageFiles = coverageResult.files
            .filter((f) => f.newLines > 0 && f.newCodeCoveragePercent < 80)
            .slice(0, 5)

          if (lowCoverageFiles.length > 0) {
            const coverageRows = lowCoverageFiles
              .map((f) => {
                const fileName =
                  f.relativePath.split('/').pop() || f.relativePath
                const uncovered =
                  f.uncoveredNewLines.slice(0, 3).join(', ') +
                  (f.uncoveredNewLines.length > 3 ? '...' : '')
                return `| ${fileName} | ${f.newCodeCoveragePercent}% | ${uncovered} |`
              })
              .join('\n')

            details += `

### Files Needing Tests

| File | New Code Coverage | Uncovered Lines |
|------|-------------------|-----------------|
${coverageRows}`
          }
        }

        // Duplication details
        if (
          duplicationResult.success &&
          duplicationResult.duplicates.length > 0
        ) {
          const dupRows = duplicationResult.duplicates
            .slice(0, 3)
            .map((d) => {
              const file1 =
                d.firstFile.name.split('/').pop() || d.firstFile.name
              const file2 =
                d.secondFile.name.split('/').pop() || d.secondFile.name
              return `| ${file1}:${d.firstFile.startLine}-${d.firstFile.endLine} | ${file2}:${d.secondFile.startLine}-${d.secondFile.endLine} | ${d.lines} |`
            })
            .join('\n')

          details += `

### Duplicated Code (${duplicationResult.duplicates.length} clone(s))

| Your Code | Duplicates | Lines |
|-----------|------------|-------|
${dupRows}`
        }

        // Build call to action
        let callToAction = ''
        if (issues.length > 0) {
          callToAction = `

---

**Would you like me to help?** Ask:
${
  lintResult.issues.length > 0
    ? '- "Fix the linting issues" - I\'ll make minimal changes to resolve them\n'
    : ''
}${
            coverageResult.success &&
            coverageResult.summary.newCodeCoverage < 80
              ? '- "Add tests for uncovered lines" - I\'ll suggest focused tests for new code\n'
              : ''
          }${
            newCodeDupPercent > 3
              ? '- "Reduce the duplication" - I\'ll suggest how to refactor duplicated code\n'
              : ''
          }`
        } else {
          callToAction = `

---

**All checks passed!** Your local changes look good.`
        }

        return {
          content: [
            {
              type: 'text',
              text: `## Check Local Summary

Checked **${
                allFiles.length
              } local file(s)**: ${uncommittedOnly} uncommitted, ${stagedOnly} staged, ${both} both. ⏱️ *Total: ${formatElapsed(
                startTime
              )}*

| Check | Status | Time | Details |
|-------|--------|------|---------|
| **Linting** | ${lintStatus} | ${formatDuration(
                lintTimed.durationMs
              )} | ESLint issues in local files |
| **New Code Coverage** | ${coverageStatus} | ${formatDuration(
                coverageTimed.durationMs
              )} | Test coverage on added/modified lines |
| **New Code Duplication** | ${duplicationStatus} | ${formatDuration(
                duplicationTimed.durationMs
              )} | Copy-pasted code in new lines |
${details}${callToAction}`,
            },
          ],
        }
      }

      case 'check_branch': {
        const projectDir = getWorkspaceDir()
        const baseBranch = (args?.baseBranch as string) || 'master'
        
        // Get ALL working files with breakdown in a single call (avoids duplicate git operations)
        const workingFiles = await getAllWorkingFiles(projectDir, baseBranch)
        const {
          all: allFiles,
          branch: branchFiles,
          changed: changedFiles,
          staged: stagedFiles,
        } = workingFiles
        
        if (allFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No TypeScript/JavaScript files found. Nothing to check.`,
              },
            ],
          }
        }

        // Calculate breakdown
        const committedCount = branchFiles.length
        const uncommittedOnly = changedFiles.filter(
          (f) => !branchFiles.includes(f)
        ).length
        const stagedOnly = stagedFiles.filter(
          (f) => !branchFiles.includes(f) && !changedFiles.includes(f)
        ).length
        
        // Pre-compute changed lines once to share with coverage and duplication checks
        const changedLines = await getChangedLines(projectDir, baseBranch)
        
        // Run all three checks in parallel with timing, passing pre-computed changedLines
        const [lintTimed, coverageTimed, duplicationTimed] = await Promise.all([
          timed(() =>
            runLocalScan({
            projectDir,
            files: allFiles,
            })
          ),
          timed(() =>
            checkCoverage(projectDir, allFiles, baseBranch, changedLines)
          ),
          timed(() =>
            checkDuplication(projectDir, allFiles, baseBranch, changedLines)
          ),
        ])

        const lintResult = lintTimed.result
        const coverageResult = coverageTimed.result
        const duplicationResult = duplicationTimed.result

        // Build summary with timing
        const lintStatus =
          lintResult.success && lintResult.issues.length === 0
          ? '✅ No issues' 
          : `⚠️ ${lintResult.issues.length} issue(s)`
        
        const coverageStatus = coverageResult.success 
          ? coverageResult.summary.newCodeCoverage >= 80
              ? `✅ ${coverageResult.summary.newCodeCoverage}%`
            : `⚠️ ${coverageResult.summary.newCodeCoverage}%`
          : '❌ Failed'
        
        const newCodeDupPercent =
          duplicationResult.newCodeDuplication?.duplicatedPercent || 0
        const duplicationStatus = duplicationResult.success
          ? newCodeDupPercent <= 3
              ? `✅ ${newCodeDupPercent}%`
            : `⚠️ ${newCodeDupPercent}%`
          : '❌ Failed'

        // Determine what needs attention
        const issues: string[] = []
        if (lintResult.issues.length > 0) {
          issues.push('linting issues')
        }
        if (
          coverageResult.success &&
          coverageResult.summary.newCodeCoverage < 80
        ) {
          issues.push('low coverage')
        }
        if (duplicationResult.success && newCodeDupPercent > 3) {
          issues.push('code duplication')
        }

        // Build detailed sections
        let details = ''
        
        // Linting details
        if (lintResult.issues.length > 0) {
          const issueRows = lintResult.issues
            .slice(0, 5)
            .map((i) => {
            const fileName = i.file.split('/').pop() || i.file
              return `| ${fileName} | ${i.line} | ${i.rule} | ${i.message.slice(
                0,
                35
              )}${i.message.length > 35 ? '...' : ''} |`
            })
            .join('\n')
          
          details += `
### Linting Issues (${lintResult.issues.length})

| File | Line | Rule | Message |
|------|------|------|---------|
${issueRows}
${
  lintResult.issues.length > 5
    ? `*...and ${lintResult.issues.length - 5} more*`
    : ''
}`
        }
        
        // Coverage details
        if (coverageResult.success) {
          const lowCoverageFiles = coverageResult.files
            .filter((f) => f.newLines > 0 && f.newCodeCoveragePercent < 80)
            .slice(0, 5)
          
          if (lowCoverageFiles.length > 0) {
            const coverageRows = lowCoverageFiles
              .map((f) => {
                const fileName =
                  f.relativePath.split('/').pop() || f.relativePath
                const uncovered =
                  f.uncoveredNewLines.slice(0, 3).join(', ') +
                  (f.uncoveredNewLines.length > 3 ? '...' : '')
              return `| ${fileName} | ${f.newCodeCoveragePercent}% | ${uncovered} |`
              })
              .join('\n')
            
            details += `

### Files Needing Tests

| File | New Code Coverage | Uncovered Lines |
|------|-------------------|-----------------|
${coverageRows}`
          }
        }
        
        // Duplication details
        if (
          duplicationResult.success &&
          duplicationResult.duplicates.length > 0
        ) {
          const dupRows = duplicationResult.duplicates
            .slice(0, 3)
            .map((d) => {
              const file1 =
                d.firstFile.name.split('/').pop() || d.firstFile.name
              const file2 =
                d.secondFile.name.split('/').pop() || d.secondFile.name
            return `| ${file1}:${d.firstFile.startLine}-${d.firstFile.endLine} | ${file2}:${d.secondFile.startLine}-${d.secondFile.endLine} | ${d.lines} |`
            })
            .join('\n')
          
          details += `

### Duplicated Code (${duplicationResult.duplicates.length} clone(s))

| Your Code | Duplicates | Lines |
|-----------|------------|-------|
${dupRows}`
        }

        // Build call to action
        let callToAction = ''
        if (issues.length > 0) {
          callToAction = `

---

**Would you like me to help?** Ask:
${
  lintResult.issues.length > 0
    ? '- "Fix the linting issues" - I\'ll make minimal changes to resolve them\n'
    : ''
}${
            coverageResult.success &&
            coverageResult.summary.newCodeCoverage < 80
              ? '- "Add tests for uncovered lines" - I\'ll suggest focused tests for new code\n'
              : ''
          }${
            newCodeDupPercent > 3
              ? '- "Reduce the duplication" - I\'ll suggest how to refactor duplicated code\n'
              : ''
          }`
        } else {
          callToAction = `

---

**All checks passed!** Your branch looks ready.`
        }

        return {
          content: [
            {
              type: 'text',
              text: `## Check Branch Summary

Checked **${
                allFiles.length
              } total file(s)**: ${committedCount} committed, ${uncommittedOnly} uncommitted, ${stagedOnly} staged. ⏱️ *Total: ${formatElapsed(
                startTime
              )}*

| Check | Status | Time | Details |
|-------|--------|------|---------|
| **Linting** | ${lintStatus} | ${formatDuration(
                lintTimed.durationMs
              )} | ESLint issues in all branch files |
| **New Code Coverage** | ${coverageStatus} | ${formatDuration(
                coverageTimed.durationMs
              )} | Test coverage on added/modified lines |
| **New Code Duplication** | ${duplicationStatus} | ${formatDuration(
                duplicationTimed.durationMs
              )} | Copy-pasted code in new lines |
${details}${callToAction}`,
            },
          ],
        }
      }

      case 'test_mcp': {
        const workspaceInfo = getWorkspaceInfo()
        const projectDir = workspaceInfo.workspace
        const results: Array<{
          name: string
          status: '✅' | '❌' | '⚠️'
          message: string
        }> = []

        // Test 1: Workspace directory detection
        try {
          if (projectDir && fs.existsSync(projectDir)) {
            const hasGit = fs.existsSync(path.join(projectDir, '.git'))
            const hasPackageJson = fs.existsSync(
              path.join(projectDir, 'package.json')
            )
            const isValidProject = hasGit && hasPackageJson

            results.push({
              name: 'Workspace Directory',
              status: isValidProject ? '✅' : '⚠️',
              message: `${projectDir} (source: ${workspaceInfo.source})`,
            })

            if (!isValidProject) {
              results.push({
                name: 'Workspace Validation',
                status: '⚠️',
                message: `Missing: ${!hasGit ? '.git' : ''} ${
                  !hasPackageJson ? 'package.json' : ''
                }`.trim(),
              })
            }
          } else {
            results.push({
              name: 'Workspace Directory',
              status: '❌',
              message: `Failed to detect workspace directory`,
            })
          }
        } catch (error) {
          results.push({
            name: 'Workspace Directory',
            status: '❌',
            message: `Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 2: Git availability
        try {
          const git = spawn('git', ['--version'], { cwd: projectDir })
          await new Promise<void>((resolve, reject) => {
            git.on('close', (code) => {
              if (code === 0) {
                results.push({
                  name: 'Git',
                  status: '✅',
                  message: 'Git is available',
                })
              } else {
                results.push({
                  name: 'Git',
                  status: '❌',
                  message: 'Git command failed',
                })
              }
              resolve()
            })
            git.on('error', (error) => {
              results.push({
                name: 'Git',
                status: '❌',
                message: `Git not found: ${error.message}`,
              })
              resolve()
            })
          })
        } catch (error) {
          results.push({
            name: 'Git',
            status: '❌',
            message: `Error checking git: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 3: ESLint availability in project (via npx)
        try {
          await new Promise<void>((resolve) => {
            const eslintCheck = spawn('npx', ['eslint', '--version'], {
              cwd: projectDir,
              stdio: 'pipe',
            })

            let version = ''
            eslintCheck.stdout.on('data', (data) => {
              version += data.toString()
            })

            eslintCheck.on('close', (code) => {
              if (code === 0) {
                results.push({
                  name: 'ESLint (project)',
                  status: '✅',
                  message: `ESLint ${version.trim()} available via npx`,
                })
              } else {
                results.push({
                  name: 'ESLint (project)',
                  status: '❌',
                  message: 'ESLint not available in project',
                })
              }
              resolve()
            })

            eslintCheck.on('error', () => {
              results.push({
                name: 'ESLint (project)',
                status: '❌',
                message: 'Failed to run npx eslint',
              })
              resolve()
            })

            // Timeout after 10 seconds
            setTimeout(() => {
              eslintCheck.kill()
              results.push({
                name: 'ESLint (project)',
                status: '⚠️',
                message: 'ESLint check timed out',
              })
              resolve()
            }, 10000)
          })
        } catch (error) {
          results.push({
            name: 'ESLint (project)',
            status: '❌',
            message: `ESLint check error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 4: Jest availability (via npx)
        try {
          const jest = spawn('npx', ['jest', '--version'], {
            cwd: projectDir,
            stdio: 'pipe',
          })
          await new Promise<void>((resolve) => {
            jest.on('close', (code) => {
              if (code === 0) {
                results.push({
                  name: 'Jest',
                  status: '✅',
                  message: 'Jest is available via npx',
                })
              } else {
                results.push({
                  name: 'Jest',
                  status: '⚠️',
                  message:
                    'Jest may not be installed (coverage checks will fail)',
                })
              }
              resolve()
            })
            jest.on('error', () => {
              results.push({
                name: 'Jest',
                status: '⚠️',
                message: 'Jest not found (coverage checks will fail)',
              })
              resolve()
            })
            // Timeout after 5 seconds
            setTimeout(() => {
              jest.kill()
              results.push({
                name: 'Jest',
                status: '⚠️',
                message: 'Jest check timed out (may still work)',
              })
              resolve()
            }, 5000)
          })
        } catch (error) {
          results.push({
            name: 'Jest',
            status: '⚠️',
            message: `Error checking Jest: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 5: jscpd availability (via npx)
        try {
          const jscpd = spawn('npx', ['jscpd', '--version'], {
            cwd: projectDir,
            stdio: 'pipe',
          })
          await new Promise<void>((resolve) => {
            jscpd.on('close', (code) => {
              if (code === 0) {
                results.push({
                  name: 'jscpd',
                  status: '✅',
                  message: 'jscpd is available via npx',
                })
              } else {
                results.push({
                  name: 'jscpd',
                  status: '⚠️',
                  message:
                    'jscpd may not be installed (duplication checks will fail)',
                })
              }
              resolve()
            })
            jscpd.on('error', () => {
              results.push({
                name: 'jscpd',
                status: '⚠️',
                message: 'jscpd not found (duplication checks will fail)',
              })
              resolve()
            })
            // Timeout after 5 seconds
            setTimeout(() => {
              jscpd.kill()
              results.push({
                name: 'jscpd',
                status: '⚠️',
                message: 'jscpd check timed out (may still work)',
              })
              resolve()
            }, 5000)
          })
        } catch (error) {
          results.push({
            name: 'jscpd',
            status: '⚠️',
            message: `Error checking jscpd: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 6: Basic git functionality - get changed files
        try {
          const changedFiles = await getChangedFiles(projectDir)
          results.push({
            name: 'Git: Get Changed Files',
            status: '✅',
            message: `Successfully retrieved ${changedFiles.length} changed file(s)`,
          })
        } catch (error) {
          results.push({
            name: 'Git: Get Changed Files',
            status: '❌',
            message: `Failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 7: ESLint can lint a file (full integration test)
        try {
          // Find a TypeScript file to test linting
          const testResult = await runLocalScan({
            projectDir,
            files: [], // Empty files = no files to lint = quick success
          })

          if (testResult.success) {
            results.push({
              name: 'ESLint: Integration',
              status: '✅',
              message: 'ESLint subprocess integration working',
            })
          } else {
            results.push({
              name: 'ESLint: Integration',
              status: '❌',
              message: `ESLint integration failed: ${testResult.error}`,
            })
          }
        } catch (error) {
          results.push({
            name: 'ESLint: Integration',
            status: '❌',
            message: `ESLint integration error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 8: Check if project has package.json
        try {
          const packageJsonPath = path.join(projectDir, 'package.json')
          if (fs.existsSync(packageJsonPath)) {
            results.push({
              name: 'Project: package.json',
              status: '✅',
              message: 'Found package.json',
            })
          } else {
            results.push({
              name: 'Project: package.json',
              status: '⚠️',
              message: 'No package.json found (may not be a Node.js project)',
            })
          }
        } catch (error) {
          results.push({
            name: 'Project: package.json',
            status: '❌',
            message: `Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Test 9: Check if project is a git repository
        try {
          const gitDir = path.join(projectDir, '.git')
          if (fs.existsSync(gitDir)) {
            results.push({
              name: 'Project: Git Repository',
              status: '✅',
              message: 'Project is a git repository',
            })
          } else {
            results.push({
              name: 'Project: Git Repository',
              status: '⚠️',
              message:
                'Not a git repository (branch/commit tools will not work)',
            })
          }
        } catch (error) {
          results.push({
            name: 'Project: Git Repository',
            status: '❌',
            message: `Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        }

        // Summary
        const passed = results.filter((r) => r.status === '✅').length
        const failed = results.filter((r) => r.status === '❌').length
        const warnings = results.filter((r) => r.status === '⚠️').length
        const total = results.length

        const resultRows = results
          .map((r) => `| ${r.name} | ${r.status} | ${r.message} |`)
          .join('\n')

        const overallStatus =
          failed === 0
            ? '✅ All critical checks passed'
            : `⚠️ ${failed} critical check(s) failed`

        return {
          content: [
            {
              type: 'text',
              text: `## MCP Server Test Results

**Overall Status:** ${overallStatus}

**Summary:** ${passed} passed, ${warnings} warnings, ${failed} failed (out of ${total} checks)

| Check | Status | Details |
|-------|--------|---------|
${resultRows}

---

**Interpretation:**
- ✅ **Passed**: Component is working correctly
- ⚠️ **Warning**: Component may not be available but non-critical (e.g., Jest/jscpd for coverage/duplication checks)
- ❌ **Failed**: Critical component is missing or broken

**Next Steps:**
${
  failed > 0
    ? '- Fix the failed checks above to ensure full functionality\n'
    : ''
}${
                warnings > 0
                  ? '- Install missing optional dependencies (Jest/jscpd) if you need coverage/duplication checks\n'
                  : ''
              }- If all checks pass, the MCP server is ready to use!`,
            },
          ],
        }
      }

      case 'ai_review': {
        const projectDir = getWorkspaceDir()
        const baseBranch = (args?.baseBranch as string) || 'master'
        const scope = (args?.scope as string) || 'branch'
        const maxSimilarFiles = (args?.maxSimilarFiles as number) || 3
        
        // Get files based on scope
        let files: string[] = []
        let scopeDescription = ''
        
        switch (scope) {
          case 'staged':
            files = await getStagedFiles(projectDir)
            scopeDescription = 'staged files'
            break
          case 'uncommitted':
            files = await getChangedFiles(projectDir)
            scopeDescription = 'uncommitted files'
            break
          case 'branch':
          default:
            files = await getBranchFiles(projectDir, baseBranch)
            scopeDescription = `files changed on branch vs ${baseBranch}`
            break
        }
        
        if (files.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No TypeScript/JavaScript files found for ${scopeDescription}. Nothing to review.`,
              },
            ],
          }
        }
        
        // Gather review context
        const context = await gatherReviewContext(
          projectDir,
          files,
          maxSimilarFiles
        )
        
        // Build output for AI analysis
        let output = `## Code Review Context

Gathered **${context.changedFiles.length} changed file(s)** and **${
          context.similarFiles.length
        } similar file(s)** for comparison.

**Scope:** ${scopeDescription}
**Shared hooks:** ${
          context.sharedHooks.length > 0
            ? context.sharedHooks.join(', ')
            : 'none'
        }
**Shared imports:** ${
          context.sharedImports.length > 0
            ? context.sharedImports.slice(0, 5).join(', ') +
              (context.sharedImports.length > 5 ? '...' : '')
            : 'none'
        }

---

## Changed Files

These are the files that have been modified. Review them for:
- Convention violations compared to similar files
- Missing error handling
- Incorrect loading state patterns
- Logic issues or bugs
- Inconsistencies with established patterns

`
        
        for (const file of context.changedFiles) {
          output += `### ${file.relativePath}

**Hooks used:** ${file.hooks.length > 0 ? file.hooks.join(', ') : 'none'}

\`\`\`tsx
${file.content}
\`\`\`

---

`
        }
        
        if (context.similarFiles.length > 0) {
          output += `## Similar Files (for comparison)

These files follow similar patterns and can be used as reference for expected conventions:

`
          
          for (const file of context.similarFiles) {
            output += `### ${file.relativePath}

**Hooks used:** ${file.hooks.length > 0 ? file.hooks.join(', ') : 'none'}

\`\`\`tsx
${file.content}
\`\`\`

---

`
          }
        }
        
        output += `## Review Instructions

Please analyze the changed files and compare them to the similar files. Look for:

1. **Convention violations** - Are the changed files following the same patterns as similar files?
2. **Missing error handling** - If hooks return errors, are they being properly destructured and used?
3. **Loading state issues** - Are loading states being used correctly (e.g., using isDataLoading vs combined isLoading)?
4. **Inconsistencies** - Do the changed files deviate from established patterns in similar files?
5. **Logic issues** - Are there any bugs or logic problems in the changes?

⏱️ *Context gathered in ${formatElapsed(startTime)}*`

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        }
      }

      case 'check_duplication': {
        const projectDir = getWorkspaceDir()
        const baseBranch = (args?.baseBranch as string) || 'master'
        const scope = (args?.scope as string) || 'branch'
        const directoryName = args?.directory as string | undefined
        let files = args?.files as string[] | undefined
        
        // Determine files based on scope
        let scopeDescription = ''
        
        switch (scope) {
          case 'directory': {
            if (!directoryName) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Error: "directory" parameter is required when scope is "directory". Provide a directory path like "packages/mobile", "src/components", or just "mobile".',
                  },
                ],
                isError: true,
              }
            }
            const dirResult = await getDirectoryFiles(projectDir, directoryName)
            if (!dirResult.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: dirResult.error || `Directory "${directoryName}" not found.`,
                  },
                ],
                isError: true,
              }
            }
            files = dirResult.files
            scopeDescription = `directory: ${dirResult.resolvedPath}`
            break
          }
            
          case 'files':
            if (!files || files.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Error: "files" parameter is required when scope is "files".',
                  },
                ],
                isError: true,
              }
            }
            scopeDescription = `${files.length} specific file(s)`
            break
            
          case 'branch':
          default:
            if (directoryName) {
              files = await getBranchFilesByDirectory(
                projectDir,
                baseBranch,
                directoryName
              )
              scopeDescription = `branch changes in ${directoryName}`
            } else {
              files = await getBranchFiles(projectDir, baseBranch)
              scopeDescription = `branch changes vs ${baseBranch}`
            }
            break
        }
        
        if (!files || files.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No TypeScript/JavaScript files found for scope: ${scopeDescription}`,
              },
            ],
          }
        }

        const result = await checkDuplication(
          projectDir,
          files,
          scope === 'branch' ? baseBranch : ''
        )

        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `Duplication check failed: ${result.error}`,
              },
            ],
            isError: true,
          }
        }

        // Build summary
        const newCodeInfo = result.newCodeDuplication 
          ? ` New code duplication: **${result.newCodeDuplication.duplicatedPercent}%** (${result.newCodeDuplication.duplicatedNewLines}/${result.newCodeDuplication.totalNewLines} new lines are duplicated).`
          : ''
        
        const comparisonNote =
          scope === 'branch' ? ' (compared against entire codebase)' : ''
        const summaryText = `Checked duplication for **${scopeDescription}**${comparisonNote}. Found **${result.summary.clones} duplication(s)** involving your changed files (${result.summary.duplicatedLines} duplicated lines).${newCodeInfo}`
        
        if (result.duplicates.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `${summaryText}\n\n**No code duplications found.** ✅\n\n⏱️ *${formatElapsed(
                  startTime
                )}*`,
              },
            ],
          }
        }

        // Build duplicates table
        const dupRows = result.duplicates
          .slice(0, 10)
          .map((d) => {
          const file1 = d.firstFile.name.split('/').pop() || d.firstFile.name
            const file2 =
              d.secondFile.name.split('/').pop() || d.secondFile.name
          return `| ${file1}:${d.firstFile.startLine}-${d.firstFile.endLine} | ${file2}:${d.secondFile.startLine}-${d.secondFile.endLine} | ${d.lines} |`
          })
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `${summaryText}

| First Location | Second Location | Lines |
|----------------|-----------------|-------|
${dupRows}
${
  result.duplicates.length > 10
    ? `\n*...and ${result.duplicates.length - 10} more duplications*`
    : ''
}

⏱️ *${formatElapsed(startTime)}*`,
            },
          ],
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('MCP server running on stdio')

  // Try to get workspace roots from the client
  // This runs after connection is established
  await requestWorkspaceRoots()

  // Log initial workspace detection
  const workspaceInfo = getWorkspaceInfo()
  console.error(
    `[MCP] Initial workspace: ${workspaceInfo.workspace} (source: ${workspaceInfo.source})`
  )
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
