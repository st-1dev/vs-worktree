'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { exists, loadProject, within } = require('./config');
const { Worktrees, withProjectLock } = require('./worktrees');

/** UC1: discover project roots from folders and generated multi-root workspaces. */
async function selectProject() {
  const roots = new Set();
  const configured = vscode.workspace.getConfiguration('vsWorktree').get('projectRoot', '');
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('vsWorktree.projectRoot must be an absolute folder path');
    roots.add(configured);
  }
  const locations = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri);
  if (vscode.workspace.workspaceFile) locations.push(vscode.workspace.workspaceFile);
  for (const uri of locations) {
    if (!['file', 'vscode-remote'].includes(uri.scheme)) continue;
    let folder = uri === vscode.workspace.workspaceFile ? path.dirname(uri.fsPath) : uri.fsPath;
    while (true) {
      if (await exists(path.join(folder, '.vscode/project-worktree.json'))) { roots.add(folder); break; }
      const parent = path.dirname(folder);
      if (folder === parent) break;
      folder = parent;
    }
  }
  const projects = [];
  for (const root of roots) {
    const configFile = path.join(root, '.vscode/project-worktree.json');
    if (vscode.workspace.textDocuments.some(doc => doc.isDirty && path.resolve(doc.uri.fsPath) === configFile)) {
      throw new Error(`Save ${configFile} before running WT commands.`);
    }
    const project = await loadProject(root);
    if (!projects.some(item => item.root === project.root)) projects.push(project);
  }
  if (!projects.length) throw new Error('Open a project folder containing .vscode/project-worktree.json.');
  if (projects.length === 1) return projects[0];
  return (await vscode.window.showQuickPick(projects.map(project => ({ label: project.project, description: project.root, project })), { title: 'WT: Select project' }))?.project;
}

function assertSaved(directories) {
  const dirty = vscode.workspace.textDocuments.find(doc => doc.isDirty && directories.some(dir => within(dir, doc.uri.fsPath)));
  if (dirty) throw new Error(`Save or close the unsaved editor before removing its worktree: ${dirty.uri.fsPath}`);
}

function createSidebar(context) {
  const changed = new vscode.EventEmitter();
  let busy = false;
  const actions = [
    ['new', 'New worktrees', 'add', 'Create feature worktrees across all project repositories.'],
    ['reset', 'Reset repositories', 'sync', 'Reclone repositories and recreate main worktrees (confirmation required).'],
    ['done', 'Remove feature worktrees', 'trash', 'Remove feature worktrees and keep Git branches (confirmation required).'],
    ['showOutput', 'Show Output', 'output', 'Open the VS Worktree command log.']
  ];
  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren: element => element ? [] : actions.map(([action, label, icon, tooltip]) => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = tooltip;
      if (!busy || action === 'showOutput') item.command = { command: `vsWorktree.${action}`, title: label };
      return item;
    }),
    getTreeItem: item => item
  };
  const view = vscode.window.createTreeView('vsWorktree.controls', { treeDataProvider: provider });
  view.description = 'Ready';
  context.subscriptions.push(changed, view);
  return {
    update(running, status) {
      busy = running;
      view.description = status;
      changed.fire();
    }
  };
}

function activate(context) {
  const output = vscode.window.createOutputChannel('VS Worktree');
  context.subscriptions.push(output);
  const sidebar = createSidebar(context);
  context.subscriptions.push(vscode.commands.registerCommand('vsWorktree.showOutput', () => output.show(true)));
  let busy = false;

  for (const action of ['reset', 'new', 'done']) {
    context.subscriptions.push(vscode.commands.registerCommand(`vsWorktree.${action}`, async () => {
      if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage('WT commands require a trusted workspace.'); return; }
      if (busy) { await vscode.window.showWarningMessage('A WT operation is already running in this window.'); return; }
      busy = true;
      let status = 'Ready';
      let completion, failure;
      sidebar.update(true, `WT ${action}: waiting for selection…`);
      try {
        const project = await selectProject();
        if (!project) return;
        const service = new Worktrees(project, text => output.append(text));
        let branch;
        if (action === 'new') {
          branch = await vscode.window.showInputBox({ title: `WT: New — ${project.project}`, prompt: 'Feature branch (for example feat/SHOP-42)', ignoreFocusOut: true,
            validateInput: async value => { try { await service.featureBase(value); } catch { return 'Enter a valid Git branch outside main and service directories.'; } } });
          if (!branch) return;
        }
        if (action === 'done') {
          const branches = await service.features();
          if (!branches.length) { await vscode.window.showInformationMessage('No feature worktrees found.'); return; }
          branch = await vscode.window.showQuickPick(branches, { title: `WT: Done — ${project.project}`, placeHolder: 'Select feature worktrees to remove' });
          if (!branch) return;
          assertSaved([await service.featureBase(branch)]);
          if (await vscode.window.showWarningMessage(`Remove ${project.project} worktrees for ${branch}? Git branches will be kept.`, { modal: true }, 'Remove worktrees') !== 'Remove worktrees') return;
        }
        if (action === 'reset') {
          assertSaved(project.repositories.flatMap(repo => [repo.original, repo.main]));
          if (await vscode.window.showWarningMessage(`Reclone ${project.project}: ${project.repositories.length} repositories in ${project.original}, ${project.bare} and ${project.main}? Existing original/main directories, including ignored files, will be replaced.`, { modal: true }, 'Reset repositories') !== 'Reset repositories') return;
        }
        output.show(true);
        output.appendLine(`\nWT ${action}: ${project.project}${branch ? ` [${branch}]` : ''}`);
        sidebar.update(true, `WT ${action}: running…`);
        const workspace = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `WT: ${action} — ${project.project}`, cancellable: false }, () =>
          withProjectLock(project, () => action === 'reset' ? service.reset() : action === 'new' ? service.newFeature(branch) : service.done(branch)));
        const result = service.warnings.length ? `Completed with ${service.warnings.length} warning(s)` : 'Completed';
        output.appendLine(`\nWT ${action}: ${result} — ${project.project}${branch ? ` [${branch}]` : ''}.`);
        if (workspace) output.appendLine(`Workspace: ${workspace}`);
        if (action === 'done') output.appendLine('Feature worktrees removed; Git branches kept.');
        status = `WT ${action}: ${result}`;
        completion = { workspace, project: project.project, branch, warnings: service.warnings.length };
      } catch (error) {
        failure = error;
        status = `WT ${action}: Failed`;
        output.appendLine(`ERROR: ${error.message}`);
        output.show(true);
      } finally {
        busy = false;
        sidebar.update(false, status);
      }
      // Notifications must not keep the controls locked after the work has finished.
      if (failure) { await vscode.window.showErrorMessage(`WT: ${failure.message}`); return; }
      if (completion.warnings) void vscode.window.showWarningMessage(`WT: ${completion.warnings} dependency preparation warning(s). See VS Worktree Output.`);
      if (completion.workspace) {
        if (await vscode.window.showInformationMessage(`WT: ${completion.project} workspace is ready.`, 'Open workspace') === 'Open workspace') {
          try {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(completion.workspace), { forceNewWindow: true });
          } catch (error) {
            output.appendLine(`ERROR opening workspace: ${error.message}`);
            output.show(true);
            await vscode.window.showErrorMessage(`WT: Could not open workspace: ${error.message}`);
          }
        }
      } else await vscode.window.showInformationMessage(`WT: ${completion.branch} worktrees removed; Git branches kept.`);
    }));
  }
}

module.exports = { activate, selectProject };
