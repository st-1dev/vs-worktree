'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parse, printParseErrorCode } = require('jsonc-parser');

async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function within(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function overlaps(a, b) { return within(a, b) || within(b, a); }

async function safePath(root, target) {
  if (target === root || !within(root, target)) throw new Error(`Path must be inside project: ${target}`);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in managed paths: ${current}`);
    }
  }
  return target;
}

function repositoryPath(url) {
  let value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (!['ssh:', 'https:', 'http:', 'file:', 'git:'].includes(parsed.protocol)) throw new Error('Unsupported repository URL');
    value = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } else if (path.isAbsolute(url)) {
    value = url.replace(/^\/+/, '');
  } else {
    const match = url.match(/^(?:[^@\s]+@)?[^:/\s]+:(.+)$/);
    if (!match) throw new Error(`Unsupported repository URL: ${url}`);
    value = match[1];
  }
  value = value.replace(/\.git$/, '');
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f<>:"|?*]/.test(part))) {
    throw new Error(`Unsafe repository path: ${url}`);
  }
  return value;
}

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

/** UC1: select and validate project configuration before any Git mutation. */
async function loadProject(folder) {
  const root = await fs.realpath(folder);
  const errors = [];
  const data = parse(await fs.readFile(path.join(root, '.vscode/project-worktree.json'), 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`project-worktree.json: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('project-worktree.json must be an object');
  const project = nonempty(data.project, 'project');
  const resolve = async field => {
    const value = nonempty(data[field], field);
    if (path.isAbsolute(value)) throw new Error(`${field} must be relative to project folder`);
    return safePath(root, path.resolve(root, value));
  };
  const workdir = await resolve('workdir');
  const bare = await resolve('bare_repositories_dir_path');
  const original = await resolve('original_repositories_dir_path');
  const main = path.join(workdir, 'main');
  await safePath(root, main);
  for (const target of [workdir, bare, original]) {
    if (['.git', '.vscode'].some(name => overlaps(path.join(root, name), target))) {
      throw new Error('Managed storage must not overlap .git or .vscode');
    }
  }
  if (overlaps(bare, original) || overlaps(bare, main) || overlaps(original, main) || within(bare, workdir) || within(original, workdir)) {
    throw new Error('bare, original and main paths must not overlap');
  }
  if (!Array.isArray(data.repositories) || !data.repositories.length) throw new Error('repositories must be a non-empty array');
  const repositories = [];
  for (const item of data.repositories) {
    if (!item || typeof item !== 'object') throw new Error('Invalid repository');
    const name = nonempty(item.name, 'repository.name');
    const url = nonempty(item.url, 'repository.url');
    if (url.startsWith('-')) throw new Error('Invalid repository URL');
    const branch = nonempty(item.main_branch_name, 'main_branch_name');
    const repoPath = repositoryPath(url);
    if (repositories.some(repo => repo.name === name || overlaps(path.resolve(repo.repoPath), path.resolve(repoPath)))) {
      throw new Error(`Duplicate name or overlapping repository path: ${name}`);
    }
    repositories.push({ name, url, branch, repoPath, bare: path.join(bare, repoPath), original: path.join(original, repoPath), main: path.join(main, repoPath) });
  }
  for (const repo of repositories) {
    for (const target of [repo.bare, repo.original, repo.main]) await safePath(root, target);
  }
  return { root, project, workdir, bare, original, main, repositories };
}

module.exports = { exists, within, overlaps, safePath, repositoryPath, loadProject };
