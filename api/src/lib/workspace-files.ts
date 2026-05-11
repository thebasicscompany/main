import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getConfig } from '../config.js'

export class WorkspacePathError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function assistantWorkspaceRoot(workspaceId: string, assistantId: string) {
  const base = getConfig().WORKSPACE_ROOT_BASE?.trim() || '/workspaces'
  return path.join(base, workspaceId, 'assistants', assistantId, 'workspace')
}

export function resolveAssistantWorkspacePath(input: {
  workspaceId: string
  assistantId: string
  relPath?: string | null
  showHidden?: boolean
}) {
  const rel = input.relPath?.trim() || ''
  if (path.isAbsolute(rel) || rel.includes('\0')) {
    throw new WorkspacePathError('invalid path')
  }
  const normalized = rel === '' || rel === '.' ? '' : path.normalize(rel)
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.split(/[\\/]/).some((part) => part === '..')
  ) {
    throw new WorkspacePathError('path escapes workspace')
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  if (!input.showHidden) {
    const blocked = parts.some(
      (part) =>
        part.startsWith('.') ||
        part === 'protected' ||
        part === 'secrets' ||
        part === 'credentials',
    )
    if (blocked) throw new WorkspacePathError('hidden path is not visible', 404)
  }
  const root = assistantWorkspaceRoot(input.workspaceId, input.assistantId)
  const abs = normalized === '' ? path.resolve(root) : path.resolve(root, normalized)
  const resolvedRoot = path.resolve(root)
  if (abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new WorkspacePathError('path escapes workspace')
  }
  return { root: resolvedRoot, abs, rel: parts.join('/') }
}

export async function ensureWorkspaceRoot(workspaceId: string, assistantId: string) {
  const root = assistantWorkspaceRoot(workspaceId, assistantId)
  await fs.mkdir(root, { recursive: true })
  return root
}

export async function workspaceEntry(input: {
  workspaceId: string
  assistantId: string
  relPath?: string | null
  showHidden?: boolean
}) {
  const resolved = resolveAssistantWorkspacePath(input)
  await ensureWorkspaceRoot(input.workspaceId, input.assistantId)
  const stat = await fs.stat(resolved.abs)
  return {
    name: path.basename(resolved.abs),
    path: resolved.rel,
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs,
    isDirectory: stat.isDirectory(),
  }
}

export async function workspaceTree(input: {
  workspaceId: string
  assistantId: string
  relPath?: string | null
  showHidden?: boolean
}) {
  const resolved = resolveAssistantWorkspacePath(input)
  await ensureWorkspaceRoot(input.workspaceId, input.assistantId)
  const stat = await fs.stat(resolved.abs).catch(() => null)
  if (!stat) throw new WorkspacePathError('not found', 404)
  if (!stat.isDirectory()) throw new WorkspacePathError('not a directory', 400)
  const children = await fs.readdir(resolved.abs, { withFileTypes: true })
  const entries = await Promise.all(
    children
      .filter((child) => input.showHidden || !child.name.startsWith('.'))
      .map(async (child) => {
        const childRel = resolved.rel ? `${resolved.rel}/${child.name}` : child.name
        return workspaceEntry({
          workspaceId: input.workspaceId,
          assistantId: input.assistantId,
          relPath: childRel,
          showHidden: input.showHidden,
        })
      }),
  )
  return {
    path: resolved.rel,
    entries: entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    }),
  }
}

export async function listWorkspaceFiles(input: {
  workspaceId: string
  assistantId: string
}) {
  await ensureWorkspaceRoot(input.workspaceId, input.assistantId)
  const out: Array<{ path: string; name: string; size: number; modifiedAt: number }> = []
  async function walk(rel: string) {
    const tree = await workspaceTree({ ...input, relPath: rel, showHidden: false })
    for (const entry of tree.entries) {
      if (entry.type === 'directory') await walk(entry.path)
      else out.push({ path: entry.path, name: entry.name, size: entry.size, modifiedAt: entry.modifiedAt })
    }
  }
  await walk('')
  return out
}
