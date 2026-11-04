'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exists, within, overlaps, safePath } = require('./config');

function run(command, args, cwd, log = () => {}) {
  log(`> ${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}\n`);
  return new Promise((resolve, reject) => {
    // No stdin: a prompting tool fails instead of hanging the locked operation.
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    // Keep complete stdout: truncated ref lists would skip safety checks.
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => { stdout.push(chunk); log(chunk.toString()); });
    child.stderr.on('data', chunk => { stderr.push(chunk); log(chunk.toString()); });
    child.on('error', error => reject(new Error(`${command} could not start in ${cwd}: ${error.message}`)));
    child.on('close', code => {
      // Leading spaces are significant in porcelain status output.
      const out = Buffer.concat(stdout).toString().trimEnd();
      if (code === 0) resolve(out);
      else reject(new Error(`${command} failed (${code}) in ${cwd}: ${(Buffer.concat(stderr).toString().trim() || out).slice(-4000)}`));
    });
  });
}

/** UC1: serialize project mutations across extension hosts. */
async function withProjectLock(project, operation) {
  const file = await safePath(project.root, path.join(project.root, '.vscode/vs-worktree.lock'));
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another WT operation is active. If its process crashed, remove ${file} after checking other VS Code windows.`);
    throw error;
  }
  const release = async () => { try { await handle.close(); } finally { await fs.unlink(file); } };
  let result;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    result = await operation();
  } catch (error) {
    // A release failure must not hide the operation error.
    await release().catch(() => {});
    throw error;
  }
  await release();
  return result;
}

// Literal gitignore pattern anchored at the repository root.
function excludePattern(file) {
  return `/${file.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ ')}`;
}

class Worktrees {
  constructor(project, log = () => {}) {
    this.project = project;
    this.log = log;
    this.warnings = [];
  }

  git(cwd, ...args) { return run('git', args, cwd, this.log); }

  async checkBranch(branch) {
    if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('Invalid Git branch');
    await this.git(this.project.root, 'check-ref-format', `refs/heads/${branch}`);
  }

  async featureBase(branch) {
    await this.checkBranch(branch);
    const base = await safePath(this.project.root, path.resolve(this.project.workdir, branch));
    if (!within(this.project.workdir, base) || [this.project.main, this.project.bare, this.project.original].some(dir => overlaps(dir, base))) {
      throw new Error(`Reserved or unsafe feature branch: ${branch}`);
    }
    return base;
  }

  async registered(repo) {
    if (!await exists(repo.bare)) return [];
    await this.assertRepository(repo.bare, repo.url, true);
    const output = await this.git(repo.bare, 'worktree', 'list', '--porcelain', '-z');
    return output.split('\0\0').filter(Boolean).map(block => {
      const fields = block.split('\0');
      const value = prefix => fields.find(field => field.startsWith(`${prefix} `))?.slice(prefix.length + 1);
      return { path: value('worktree'), branch: value('branch')?.replace(/^refs\/heads\//, ''), bare: fields.includes('bare'), locked: fields.some(field => field === 'locked' || field.startsWith('locked ')) };
    });
  }

  async assertRepository(target, url, bare) {
    await safePath(this.project.root, target);
    if (bare) {
      if (await this.git(target, 'rev-parse', '--is-bare-repository') !== 'true') throw new Error(`Not a bare repository: ${target}`);
    } else {
      const top = await this.git(target, 'rev-parse', '--show-toplevel');
      if (path.resolve(top) !== path.resolve(target)) throw new Error(`Not a repository root: ${target}`);
    }
    if (await this.git(target, 'remote', 'get-url', 'origin') !== url) throw new Error(`Origin does not match project-worktree.json: ${target}`);
  }

  async clean(target) {
    const status = await this.git(target, 'status', '--porcelain', '--untracked-files=all');
    if (status) throw new Error(`Uncommitted or untracked files in ${target}. Commit, stash or move them first.`);
  }

  async remoteBacked(target) {
    // Mirror origin branches as remote-tracking refs; --prune drops branches deleted on the server.
    await this.git(target, 'fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
    const remoteTags = new Map((await this.git(target, 'ls-remote', '--tags', 'origin')).split('\n').filter(Boolean).map(line => {
      const [sha, ref] = line.split(/\s+/); return [ref, sha];
    }));
    const local = await this.git(target, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags');
    const branches = [], tags = [];
    for (const line of local.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(' ');
      if (ref.startsWith('refs/tags/')) {
        if (remoteTags.get(ref) !== sha) throw new Error(`Reset would discard local tag ${ref} in ${target}. Push or remove it first.`);
        tags.push(sha);
      } else branches.push({ sha, ref });
    }
    // A commit is safe when origin still has it, even if its branch was merged and deleted there.
    const unpushed = async sha => Boolean(await this.git(target, 'rev-list', '--max-count=1', sha, '--not', '--remotes=origin', ...tags));
    const tracking = new Set((await this.git(target, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).split('\n'));
    const dropped = [];
    for (const { sha, ref } of branches) {
      if (await unpushed(sha)) throw new Error(`Reset would discard unpushed commits of ${ref} in ${target}. Push or remove it first.`);
      const name = ref.slice('refs/heads/'.length);
      if (!tracking.has(`refs/remotes/origin/${name}`)) dropped.push(name);
    }
    if (dropped.length) this.log(`Reset will drop local branches already contained in origin: ${dropped.join(', ')}\n`);
    const other = await this.git(target, 'for-each-ref', '--format=%(refname)', 'refs/stash');
    if (other) throw new Error(`Reset would discard stashes in ${target}`);
    // A clean detached HEAD can still contain the only copy of a commit.
    if (await this.git(target, 'rev-parse', '--is-bare-repository') !== 'true' && await unpushed('HEAD')) {
      throw new Error(`Reset would discard detached or unpushed HEAD in ${target}`);
    }
  }

  /** UC2: preflight every repository before resetting any of them. */
  async preflightReset() {
    for (const repo of this.project.repositories) {
      await this.checkBranch(repo.branch);
      await this.git(this.project.root, 'ls-remote', '--exit-code', '--heads', repo.url, `refs/heads/${repo.branch}`);
      for (const target of [repo.original, repo.bare, repo.main]) await safePath(this.project.root, target);
      const trees = await this.registered(repo);
      if (trees.some(tree => !tree.bare && (path.resolve(tree.path) !== repo.main || tree.locked))) {
        throw new Error(`Active or locked feature worktrees in ${repo.name}. Run WT: Done first.`);
      }
      if (await exists(repo.bare)) await this.remoteBacked(repo.bare);
      if (await exists(repo.original)) {
        await this.assertRepository(repo.original, repo.url, false);
        await this.clean(repo.original);
        await this.remoteBacked(repo.original);
      }
      if (await exists(repo.main)) {
        if (!trees.some(tree => path.resolve(tree.path) === repo.main && tree.branch === repo.branch)) {
          throw new Error(`Main directory is not the expected registered worktree: ${repo.main}`);
        }
        await this.clean(repo.main);
      }
    }
  }

  async status(target) {
    const entries = (await this.git(target, 'status', '--porcelain', '-z', '--untracked-files=normal')).split('\0').filter(Boolean);
    const untracked = new Set(), changed = new Set();
    for (let i = 0; i < entries.length; i++) {
      const [code, file] = [entries[i].slice(0, 2), entries[i].slice(3)];
      if (code === '??') untracked.add(file); else changed.add(file);
      if (/[RC]/.test(code)) i++; // Skip the rename source.
    }
    return { untracked, changed };
  }

  /** Ignore files created by dependency preparation so later Done/Reset safety checks stay meaningful. */
  async excludeGenerated(target, before) {
    const after = await this.status(target);
    const generated = [...after.untracked].filter(file => !before.untracked.has(file) && !/[\r\n]/.test(file));
    if (generated.length) {
      // Linked worktrees share the exclude file of their bare repository.
      const file = await safePath(this.project.root, path.resolve(target, await this.git(target, 'rev-parse', '--git-path', 'info/exclude')));
      const current = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      const lines = new Set(current.split('\n'));
      const added = generated.map(excludePattern).filter(pattern => !lines.has(pattern));
      if (added.length) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${lines.has('# vs-worktree: dependency preparation output') ? '' : '# vs-worktree: dependency preparation output\n'}${added.join('\n')}\n`);
        this.log(`Ignored dependency preparation output in ${file}: ${added.join(', ')}\n`);
      }
    }
    const modified = [...after.changed].filter(file => !before.changed.has(file));
    if (modified.length) {
      this.warnings.push(`${target}: dependency preparation modified tracked files (${modified.join(', ')}); Done/Reset will refuse until they are committed or reverted.`);
      this.log(`WARNING: ${this.warnings.at(-1)}\n`);
    }
  }

  /** Prepare dependencies, preserving the scripts' nonfatal failures. */
  async prepare(target) {
    const before = await this.status(target);
    for (const [manifest, command, args] of [['go.mod', 'go', ['mod', 'vendor']], ['package.json', 'npm', ['install']]]) {
      if (!await exists(path.join(target, manifest))) continue;
      try {
        if (command === 'npm' && process.platform === 'win32') {
          await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install'], target, this.log);
        } else await run(command, args, target, this.log);
      } catch (error) {
        this.warnings.push(`${target}: ${error.message}`);
        this.log(`WARNING: ${error.message}\n`);
      }
    }
    await this.excludeGenerated(target, before);
  }

  async workspace(base, branch) {
    const file = await safePath(this.project.root, path.join(base, 'workspace.code-workspace'));
    const content = {
      folders: this.project.repositories.map(repo => ({ name: repo.name, path: repo.repoPath })),
      settings: {
        'window.title': `${this.project.project} ${branch === 'main' ? 'main' : `[${branch}]`}`,
        'git.autoRepositoryDetection': 'subFolders',
        'git.enabled': true,
        'vsWorktree.projectRoot': this.project.root
      }
    };
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(content, null, 2)}\n`);
    return file;
  }

  /** UC2: recreate original, bare and main after project-wide preflight. */
  async reset() {
    await this.preflightReset();
    for (const repo of this.project.repositories) {
      this.log(`Reset ${repo.name}\n`);
      for (const target of [repo.main, repo.original, repo.bare]) {
        await safePath(this.project.root, target);
        await fs.rm(target, { recursive: true, force: true });
        await fs.mkdir(path.dirname(target), { recursive: true });
      }
      await this.git(this.project.root, 'clone', '--', repo.url, repo.original);
      await this.prepare(repo.original);
      await this.git(this.project.root, 'clone', '--bare', '--', repo.url, repo.bare);
      await this.git(repo.bare, 'worktree', 'add', repo.main, repo.branch);
      await this.prepare(repo.main);
    }
    await this.workspace(this.project.original, 'main');
    return this.workspace(this.project.main, 'main');
  }

  /** UC3: preflight all destinations, then create or reuse the feature branch. */
  async newFeature(branch) {
    const base = await this.featureBase(branch);
    if (await exists(base)) throw new Error(`Feature directory already exists: ${base}`);
    const plans = [];
    for (const repo of this.project.repositories) {
      if (!await exists(repo.bare)) throw new Error(`${repo.name} is not cloned yet (${repo.bare}). Run WT: Reset first.`);
      await this.assertRepository(repo.bare, repo.url, true);
      await this.git(repo.bare, 'rev-parse', '--verify', `refs/heads/${repo.branch}`);
      if ((await this.registered(repo)).some(tree => tree.branch === branch)) throw new Error(`${branch} is already checked out in ${repo.name}`);
      const refs = await this.git(repo.bare, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`);
      plans.push({ repo, reuse: refs.split('\n').includes(`refs/heads/${branch}`), target: await safePath(this.project.root, path.join(base, repo.repoPath)) });
    }
    for (const { repo, reuse, target } of plans) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.git(repo.bare, 'worktree', 'add', ...(reuse ? [target, branch] : ['-b', branch, target, repo.branch]));
      await this.prepare(target);
    }
    return this.workspace(base, branch);
  }

  async features() {
    const branches = new Set();
    for (const repo of this.project.repositories) {
      for (const tree of await this.registered(repo)) {
        if (tree.bare || !tree.branch) continue;
        let base;
        try { base = await this.featureBase(tree.branch); } catch { continue; }
        if (path.resolve(tree.path) === path.join(base, repo.repoPath)) branches.add(tree.branch);
      }
    }
    return [...branches].sort();
  }

  /** UC4: validate every feature worktree before removing registrations and workspace. */
  async done(branch) {
    const base = await this.featureBase(branch);
    const plans = [];
    for (const repo of this.project.repositories) {
      const target = await safePath(this.project.root, path.join(base, repo.repoPath));
      const trees = await this.registered(repo);
      const tree = trees.find(item => path.resolve(item.path) === target);
      if (!tree) {
        if (await exists(target)) throw new Error(`Unregistered directory will not be removed: ${target}`);
        continue;
      }
      if (tree.branch !== branch || tree.locked) throw new Error(`Unexpected branch or locked worktree: ${target}`);
      // A manually deleted directory only needs its stale Git registration removed.
      if (await exists(target)) await this.clean(target);
      else this.log(`Removing stale registration of missing worktree ${target}\n`);
      plans.push({ repo, target });
    }
    if (!plans.length) throw new Error(`No worktrees found for ${branch}`);
    for (const { repo, target } of plans) {
      await this.git(repo.bare, 'worktree', 'remove', target);
      // Only remove empty repository path parents; preserve unrelated files.
      let parent = path.dirname(target);
      while (parent !== base && within(base, parent)) {
        try { await fs.rmdir(parent); } catch (error) { if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) break; throw error; }
        parent = path.dirname(parent);
      }
    }
    const workspace = await safePath(this.project.root, path.join(base, 'workspace.code-workspace'));
    await fs.rm(workspace, { force: true });
    try { await fs.rmdir(base); } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
    let parent = path.dirname(base);
    while (parent !== this.project.workdir && within(this.project.workdir, parent)) {
      try { await fs.rmdir(parent); } catch (error) { if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) break; throw error; }
      parent = path.dirname(parent);
    }
  }
}

module.exports = { run, withProjectLock, Worktrees };
