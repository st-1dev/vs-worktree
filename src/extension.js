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
  if (dirty) throw new Error(`Save or close the unsaved editor before changing its worktree: ${dirty.uri.fsPath}`);
}

function createSidebar(context) {
  const changed = new vscode.EventEmitter();
  let busy = false;
  let activeAction;
  let status = 'Ready';
  let message = 'Create feature workspaces with New. Refresh their base with Update. First use: Maintenance → Reset repositories.';
  const actions = [
    ['new', 'New worktrees', 'add', 'Create feature worktrees across all project repositories.'],
    ['update', 'Update repositories', 'repo-fetch', 'Fetch origin and fast-forward original/main across all project repositories.'],
    ['done', 'Remove feature worktrees', 'trash', 'Remove feature worktrees and keep Git branches (confirmation required).'],
    ['showOutput', 'Show Output', 'output', 'Open the VS Worktree command log.']
  ];
  const reset = ['reset', 'Reset repositories', 'warning', 'Reclone all repositories and replace original/main, including ignored files. Confirmation and safety checks required.'];
  const maintenance = new vscode.TreeItem('Maintenance', vscode.TreeItemCollapsibleState.Collapsed);
  maintenance.id = 'maintenance';
  maintenance.tooltip = 'Initial setup or full reclone. Use Update for routine remote changes.';
  function actionItem([action, label, icon, tooltip]) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const disabled = action !== 'showOutput' && (busy || !vscode.workspace.isTrusted);
    item.id = action;
    item.iconPath = activeAction === action && busy ? new vscode.ThemeIcon('loading~spin')
      : new vscode.ThemeIcon(icon, disabled ? new vscode.ThemeColor('disabledForeground') : undefined);
    item.description = disabled ? (busy ? (activeAction === action ? 'running…' : 'busy') : 'trust required')
      : action === 'reset' ? 'reclone' : undefined;
    item.tooltip = disabled ? `${tooltip}\n${busy ? 'Wait for the current operation to finish.' : 'Trust this workspace to run WT commands.'}` : tooltip;
    item.accessibilityInformation = { label: `${label}${disabled ? `, unavailable, ${item.description}` : ''}. ${tooltip}` };
    if (!disabled) item.command = { command: `vsWorktree.${action}`, title: label };
    return item;
  }
  function statusItem() {
    const item = new vscode.TreeItem(status, vscode.TreeItemCollapsibleState.None);
    item.id = 'status';
    item.iconPath = new vscode.ThemeIcon(busy ? 'loading~spin' : status.endsWith('Failed') ? 'error'
      : status.includes('warning') ? 'warning' : status.includes('Completed') ? 'pass' : 'info');
    item.tooltip = message;
    item.accessibilityInformation = { label: message };
    item.command = { command: 'vsWorktree.showOutput', title: 'Show Output' };
    return item;
  }
  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren: element => element ? (element.id === 'maintenance' ? [actionItem(reset)] : [])
      : [...(status === 'Ready' ? [] : [statusItem()]), ...actions.slice(0, 3).map(actionItem), maintenance, actionItem(actions[3])],
    getTreeItem: item => item
  };
  const view = vscode.window.createTreeView('vsWorktree.controls', { treeDataProvider: provider });
  view.description = status;
  view.message = vscode.workspace.isTrusted ? message : 'Trust this workspace to run WT commands. Show Output remains available.';
  context.subscriptions.push(changed, view);
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { view.message = message; changed.fire(); }));
  return {
    get status() { return status; },
    get message() { return message; },
    update(running, nextStatus, nextMessage = message, action) {
      busy = running;
      activeAction = action;
      status = nextStatus;
      message = nextMessage;
      view.description = status;
      // Native TreeView messages collapse newlines and clip long paths. Keep the
      // context brief; the status row exposes the full result via tooltip/Output.
      view.message = status === 'Ready' ? message : message.split('\n')[0].replace(/([/\\_.-])/g, '$1\u200b');
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

  for (const action of ['reset', 'new', 'done', 'update']) {
    context.subscriptions.push(vscode.commands.registerCommand(`vsWorktree.${action}`, async () => {
      if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage('WT commands require a trusted workspace.'); return; }
      if (busy) { await vscode.window.showWarningMessage('A WT operation is already running in this window.'); return; }
      busy = true;
      let status = sidebar.status;
      let message = sidebar.message;
      let summary = '';
      let completion, failure;
      sidebar.update(true, `WT ${action}: waiting for selection…`, 'Select a project and review the operation. Other actions will be available when this finishes.', action);
      try {
        const project = await selectProject();
        if (!project) return;
        summary = `${project.project} · ${project.repositories.length} ${project.repositories.length === 1 ? 'repository' : 'repositories'}`;
        sidebar.update(true, `WT ${action}: waiting for selection…`, `${summary}\nWaiting for ${action === 'new' ? 'a feature branch' : action === 'done' ? 'a feature selection' : action === 'reset' ? 'confirmation' : 'saved-editor checks'}…`, action);
        const service = new Worktrees(project, text => output.append(text));
        let branch;
        if (action === 'new') {
          branch = await vscode.window.showInputBox({ title: `WT: New — ${project.project}`, prompt: 'Feature branch (for example feat/SHOP-42)', ignoreFocusOut: true,
            validateInput: async value => { try { await service.featureBase(value); } catch { return 'Enter a valid Git branch outside main and service directories.'; } } });
          if (!branch) return;
        }
        if (action === 'done') {
          const branches = await service.features();
          if (!branches.length) {
            status = 'No feature worktrees';
            message = `${summary}\nNo feature worktrees found. Use New worktrees to create a feature workspace.`;
            await vscode.window.showInformationMessage('No feature worktrees found.'); return;
          }
          branch = await vscode.window.showQuickPick(branches, { title: `WT: Done — ${project.project}`, placeHolder: 'Select feature worktrees to remove' });
          if (!branch) return;
          assertSaved([await service.featureBase(branch)]);
          if (await vscode.window.showWarningMessage(`Remove ${project.project} worktrees for ${branch}? Git branches will be kept.`, { modal: true }, 'Remove worktrees') !== 'Remove worktrees') return;
        }
        if (action === 'reset') {
          assertSaved(project.repositories.flatMap(repo => [repo.original, repo.main]));
          if (await vscode.window.showWarningMessage(`Reclone ${project.project}: ${project.repositories.length} repositories in ${project.original}, ${project.bare} and ${project.main}? Existing original/main directories, including ignored files, will be replaced.`, { modal: true }, 'Reset repositories') !== 'Reset repositories') return;
        }
        if (action === 'update') assertSaved(project.repositories.flatMap(repo => [repo.original, repo.main]));
        output.show(true);
        output.appendLine(`\nWT ${action}: ${project.project}${branch ? ` [${branch}]` : ''}`);
        sidebar.update(true, `WT ${action}: running…`, `${summary}${branch ? `\n${branch}` : ''}\n${action === 'update' ? 'Fetching and updating original/main…' : action === 'new' ? 'Creating feature worktrees…' : action === 'done' ? 'Removing feature worktrees; keeping branches…' : 'Checking and recloning repositories…'}\nSee Show Output for live details.`, action);
        const workspace = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `WT: ${action} — ${project.project}`, cancellable: false }, () =>
          withProjectLock(project, () => action === 'new' ? service.newFeature(branch) : action === 'done' ? service.done(branch) : service[action]()));
        const result = service.warnings.length ? `Completed with ${service.warnings.length} warning(s)` : 'Completed';
        output.appendLine(`\nWT ${action}: ${result} — ${project.project}${branch ? ` [${branch}]` : ''}.`);
        if (workspace) output.appendLine(`Workspace: ${workspace}`);
        if (action === 'done') output.appendLine('Feature worktrees removed; Git branches kept.');
        if (action === 'update') output.appendLine('Original repositories, bare remote refs and main worktrees updated; feature branches kept.');
        status = `WT ${action}: ${result}`;
        message = `${summary}${branch ? `\n${branch}` : ''}\n${status}${service.warnings.length ? '\nSee Show Output for dependency warnings.' : ''}`;
        completion = { workspace, project: project.project, branch, action, warnings: service.warnings.length };
      } catch (error) {
        failure = error;
        status = `WT ${action}: Failed`;
        message = `${summary ? `${summary}\n` : ''}${status}\n${error.message}\nSee Show Output for details.`;
        output.appendLine(`ERROR: ${error.message}`);
        output.show(true);
      } finally {
        busy = false;
        sidebar.update(false, status, message);
      }
      // Notifications must not keep the controls locked after the work has finished.
      if (failure) {
        if (await vscode.window.showErrorMessage(`WT: ${failure.message}`, 'Show Output') === 'Show Output') output.show(true);
        return;
      }
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
      } else if (completion.action === 'update') {
        await vscode.window.showInformationMessage(`WT: ${completion.project} original, bare and main updated.`);
      } else await vscode.window.showInformationMessage(`WT: ${completion.branch} worktrees removed; Git branches kept.`);
    }));
  }
}

module.exports = { activate, selectProject };
