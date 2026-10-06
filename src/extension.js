'use strict';

const vscode = require('vscode');

const STORAGE_KEY = 'processTabs.state.v1';
const LEGACY_PROCESS_SCHEME = 'process-tabs';
const NEW_GROUP_LEFT_COMMAND = 'workbench.action.newGroupLeft';

function activate(context) {
  const manager = new ProcessTabsManager(context);

  const registrations = [
    vscode.commands.registerCommand('processTabs.switcher', () => manager.showSwitcher()),
    vscode.commands.registerCommand('processTabs.manage', () => manager.showManageMenu()),
    vscode.commands.registerCommand('processTabs.createFromCurrentTabGroup', () => manager.createFromCurrentTabGroup()),
    vscode.commands.registerCommand('processTabs.addCurrentFile', () => manager.addCurrentFile()),
    vscode.commands.registerCommand('processTabs.addCurrentTabGroup', () => manager.addCurrentTabGroup()),
    vscode.commands.registerCommand('processTabs.setProcessArea', () => manager.setCurrentProcessArea()),

    // Backwards-compatible command ids from v0.1/v0.2. They are intentionally
    // not exposed in the new UI, but existing keybindings keep working.
    vscode.commands.registerCommand('processTabs.menu', () => manager.showSwitcher()),
    vscode.commands.registerCommand('processTabs.switchProcess', () => manager.showSwitcher()),
    vscode.commands.registerCommand('processTabs.createFromOpenTabs', () => manager.createFromCurrentTabGroup()),
    vscode.commands.registerCommand('processTabs.addAllOpenFiles', () => manager.addCurrentTabGroup()),
    vscode.commands.registerCommand('processTabs.openActiveProcess', () => manager.openActiveProcess()),
    vscode.commands.registerCommand('processTabs.closeActiveProcess', () => manager.closeActiveProcess()),
    vscode.commands.registerCommand('processTabs.showFolderTabs', () => manager.removeLegacyFolderTabs()),

    vscode.window.onDidChangeActiveTextEditor(editor => {
      void manager.handleActiveEditorChange(editor);
    }),
    vscode.window.tabGroups.onDidChangeTabs(event => {
      void manager.handleTabsChanged(event);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('processTabs.showStatusBar')) {
        manager.refreshStatusBar();
      }
    })
  ];

  context.subscriptions.push(...registrations);
  void manager.initialize();
}

class ProcessTabsManager {
  constructor(context) {
    this.context = context;
    this.statusBar = vscode.window.createStatusBarItem(
      'processTabs.activeProcess',
      vscode.StatusBarAlignment.Right,
      1000
    );
    this.statusBar.name = 'Process Tabs';
    this.statusBar.command = 'processTabs.switcher';
    context.subscriptions.push(this.statusBar);
    this.suppressTabEvents = 0;
  }

  async initialize() {
    // v0.2 experimented with fake folder documents in the native tab strip.
    // v0.3 removes them completely.
    await this.removeLegacyFolderTabs();
    await this.ensureProcessArea();
    this.refreshStatusBar();
  }

  async removeLegacyFolderTabs() {
    const legacyTabs = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tabUri(tab);
        if (uri && uri.scheme === LEGACY_PROCESS_SCHEME) {
          legacyTabs.push(tab);
        }
      }
    }
    if (legacyTabs.length > 0) {
      try {
        await vscode.window.tabGroups.close(legacyTabs, true);
      } catch (error) {
        console.error('Process Tabs: could not remove legacy folder tabs', error);
      }
    }
  }

  async handleActiveEditorChange(editor) {
    this.refreshStatusBar();
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    await this.rememberActiveFile(editor.document.uri);
  }

  async handleTabsChanged(event) {
    this.refreshStatusBar();
    if (this.suppressTabEvents > 0 || !event) {
      return;
    }

    // A manual close means "this source no longer belongs to what I am
    // working on". Remove it from the active process only when its last open
    // tab is gone. This avoids treating a tab move (or closing one duplicate
    // view) as a removal. Extension-driven closes are wrapped in
    // suppressTabEvents, so switching/Close active process never erases the
    // saved process membership.
    const removeClosed = vscode.workspace
      .getConfiguration('processTabs')
      .get('removeClosedFiles', true);

    if (removeClosed && Array.isArray(event.closed) && event.closed.length > 0) {
      const state = this.getState();
      const active = this.getActiveGroup(state);
      if (active) {
        const closedKeys = new Set();
        for (const tab of event.closed) {
          const uri = tabUri(tab);
          if (!uri || uri.scheme !== 'file') {
            continue;
          }
          // If the same source is still open somewhere (for example after a
          // drag between editor groups), keep it in the process.
          if (this.findOpenFileTabs(uri).length === 0) {
            closedKeys.add(uriKey(uri));
          }
        }

        if (closedKeys.size > 0) {
          const before = active.files.length;
          active.files = active.files.filter(raw => !closedKeys.has(uriKey(vscode.Uri.parse(raw))));
          if (active.lastActiveFile && closedKeys.has(uriKey(vscode.Uri.parse(active.lastActiveFile)))) {
            active.lastActiveFile = undefined;
          }
          if (active.files.length !== before) {
            active.updatedAt = new Date().toISOString();
            await this.saveState(state);
          }
        }
      }
    }

    const autoAdd = vscode.workspace.getConfiguration('processTabs').get('autoAddOpenedFiles', true);
    if (!autoAdd || !Array.isArray(event.opened) || event.opened.length === 0) {
      return;
    }

    const state = this.getState();
    const active = this.getActiveGroup(state);
    if (!active) {
      return;
    }

    const moveToArea = vscode.workspace.getConfiguration('processTabs').get('moveNewFilesToProcessArea', true);

    for (const tab of event.opened) {
      const uri = tabUri(tab);
      if (!uri || uri.scheme !== 'file') {
        continue;
      }

      // Resolve the process area at the moment the file opens. Numeric view
      // columns are not stable when an editor group disappears: a tool pane
      // such as Claude can become column 1 after the code group is emptied.
      // When that happens we recreate a code group to the left instead of
      // turning the tool pane into a mixed tool+source tab group.
      const targetColumn = await this.ensureStableProcessArea(active, uri);

      const alreadyInActive = active.files.some(raw => sameUri(vscode.Uri.parse(raw), uri));
      if (!alreadyInActive) {
        await this.addUrisToGroup(active.name, [uri], targetColumn, true);
      }

      if (moveToArea) {
        const locations = this.findOpenFileTabs(uri);
        const inTarget = locations.some(item => item.group.viewColumn === targetColumn);
        if (!inTarget) {
          await this.relocateFileToColumn(uri, targetColumn);
        }
      }
    }
  }

  async ensureProcessArea() {
    const state = this.getState();
    if (!state.processViewColumn) {
      // Stable default: the left-most editor group. Users can change it from
      // Manage Processes -> Use current editor group as process area.
      state.processViewColumn = vscode.ViewColumn.One;
      await this.saveState(state);
    }
  }

  async showSwitcher() {
    const state = this.getState();

    if (state.groups.length === 0) {
      const picked = await vscode.window.showQuickPick([
        actionItem('create-current', '$(new-folder) Create process from current tab group', 'Group the tabs in the editor group you are working in'),
        actionItem('create-empty', '$(add) Create empty process', 'Create a process and add files later')
      ], {
        title: 'Process Tabs',
        placeHolder: 'Create your first process'
      });
      await this.handleSwitcherAction(picked);
      return;
    }

    const active = this.getActiveGroup(state);
    const processItems = [];

    if (active) {
      processItems.push({
        label: `$(check) ${active.name}`,
        description: `${active.files.length} file${active.files.length === 1 ? '' : 's'} · active`,
        detail: 'Reopen any missing tabs and return to this process',
        processName: active.name,
        alwaysShow: true
      });
    }

    for (const group of state.groups
      .filter(group => !active || group.name !== active.name)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))) {
      processItems.push({
        label: `$(folder) ${group.name}`,
        description: `${group.files.length} file${group.files.length === 1 ? '' : 's'}`,
        processName: group.name,
        alwaysShow: true
      });
    }

    const items = [
      ...processItems,
      separator('Actions'),
      actionItem('create-current', '$(new-folder) New process from current tab group', 'Use only the tabs in the current editor group'),
      actionItem('create-empty', '$(add) New empty process'),
      actionItem('manage', '$(gear) Manage processes…', 'Add/remove files, rename or delete processes')
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: active ? `Process Tabs · ${active.name}` : 'Process Tabs',
      placeHolder: 'Switch process'
    });

    if (!picked) {
      return;
    }

    if (picked.processName) {
      await this.activateProcessByName(picked.processName);
      return;
    }

    await this.handleSwitcherAction(picked);
  }

  async handleSwitcherAction(picked) {
    if (!picked || !picked.action) {
      return;
    }
    switch (picked.action) {
      case 'create-current':
        await this.createFromCurrentTabGroup();
        break;
      case 'create-empty':
        await this.createEmptyProcess();
        break;
      case 'manage':
        await this.showManageMenu();
        break;
    }
  }

  async showManageMenu() {
    const state = this.getState();
    const active = this.getActiveGroup(state);
    const activeName = active ? active.name : 'No active process';

    const items = [
      actionItem('switch', '$(arrow-swap) Switch process', active ? `Current: ${active.name}` : undefined),
      separator(activeName),
      actionItem('add-current', '$(file-add) Add current file', active ? `Add to ${active.name}` : 'Choose a process first'),
      actionItem('add-group', '$(files) Add current tab group', active ? `Add all file tabs in this editor group to ${active.name}` : 'Choose a process first'),
      actionItem('set-area', '$(layout) Use current editor group as process area', 'Newly opened process files will be kept in this editor group'),
      actionItem('remove-current', '$(remove) Remove current file', active ? `Remove from ${active.name}` : 'Choose a process first'),
      actionItem('reopen', '$(folder-opened) Reopen active process', 'Open any saved files that are currently closed'),
      actionItem('close', '$(close-all) Close active process', 'Unsaved files and other editor groups are left untouched'),
      separator('Process'),
      actionItem('create-current', '$(new-folder) New process from current tab group'),
      actionItem('create-empty', '$(add) New empty process'),
      actionItem('rename', '$(edit) Rename active process'),
      actionItem('delete', '$(trash) Delete active process', 'Only removes the saved group; files on disk are never deleted')
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: active ? `Manage Process Tabs · ${active.name}` : 'Manage Process Tabs',
      placeHolder: 'Choose an action'
    });
    if (!picked || !picked.action) {
      return;
    }

    switch (picked.action) {
      case 'switch': return this.showSwitcher();
      case 'add-current': return this.addCurrentFile();
      case 'add-group': return this.addCurrentTabGroup();
      case 'set-area': return this.setCurrentProcessArea();
      case 'remove-current': return this.removeCurrentFile();
      case 'reopen': return this.openActiveProcess();
      case 'close': return this.closeActiveProcess();
      case 'create-current': return this.createFromCurrentTabGroup();
      case 'create-empty': return this.createEmptyProcess();
      case 'rename': return this.renameActiveProcess();
      case 'delete': return this.deleteActiveProcess();
    }
  }

  async createFromCurrentTabGroup() {
    const column = this.resolveCurrentWorkingColumn();
    const uris = this.getOpenFileUrisInColumn(column);
    if (uris.length === 0) {
      void vscode.window.showInformationMessage('Process Tabs: there are no file tabs in the current editor group.');
      return;
    }

    const name = await this.askForNewProcessName();
    if (!name) {
      return;
    }

    const now = new Date().toISOString();
    const state = this.getState();
    state.groups.push({
      name,
      files: unique(uris.map(uri => uri.toString())),
      createdAt: now,
      updatedAt: now,
      preferredViewColumn: column,
      lastActiveFile: this.activeFileInUris(uris)
    });
    state.activeProcess = name;
    state.processViewColumn = column;
    await this.saveState(state);

    void vscode.window.showInformationMessage(
      `Process Tabs: created “${name}” with ${uris.length} file${uris.length === 1 ? '' : 's'}.`
    );
  }

  async createEmptyProcess() {
    const name = await this.askForNewProcessName();
    if (!name) {
      return;
    }

    const state = this.getState();
    const previous = this.getActiveGroup(state);
    const targetColumn = await this.ensureStableProcessArea(previous);
    const draft = {
      name,
      files: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      preferredViewColumn: targetColumn
    };

    const closePrevious = vscode.workspace
      .getConfiguration('processTabs')
      .get('closePreviousOnSwitch', true);

    if (previous && closePrevious) {
      const previousColumn = this.resolveHomeColumn(previous) || targetColumn;
      await this.closeGroupInColumn(previous, previousColumn, false);
    }

    state.processViewColumn = targetColumn;
    state.groups.push(draft);
    state.activeProcess = name;
    await this.saveState(state);

    void vscode.window.showInformationMessage(`Process Tabs: created empty process “${name}”. Open a file and it will be added automatically.`);
  }

  async activateProcessByName(name) {
    const state = this.getState();
    const selected = state.groups.find(group => group.name === name);
    if (!selected) {
      return;
    }

    const previous = this.getActiveGroup(state);
    let targetColumn = await this.ensureStableProcessArea(previous || selected);
    const closePrevious = vscode.workspace
      .getConfiguration('processTabs')
      .get('closePreviousOnSwitch', true);

    const switching = previous && previous.name !== selected.name;
    const shared = new Set(selected.files.map(raw => uriKey(vscode.Uri.parse(raw))));
    const previousColumn = previous ? (this.resolveHomeColumn(previous) || targetColumn) : targetColumn;

    if (switching && selected.files.length > 0) {
      // Open the incoming process before closing the outgoing one. This keeps
      // the code editor group alive, so a neighbouring tool group cannot slide
      // into its numeric viewColumn and accidentally receive the source tabs.
      await this.openGroup(selected, targetColumn);

      if (closePrevious) {
        await this.closeGroupInColumn(previous, previousColumn, false, shared);
      }
      return;
    }

    if (switching && closePrevious) {
      await this.closeGroupInColumn(previous, previousColumn, false, shared);
      // An empty target process may leave the code group with no tabs. If VS
      // Code compacted the layout, recreate/resolve the process area now.
      targetColumn = await this.ensureStableProcessArea(selected);
    }

    selected.preferredViewColumn = targetColumn;
    state.processViewColumn = targetColumn;
    state.activeProcess = selected.name;
    selected.updatedAt = new Date().toISOString();
    await this.saveState(state);

    await this.openGroup(selected, targetColumn);
  }

  async addCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    const uri = editor && editor.document.uri;
    if (!uri || uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Process Tabs: open a file first.');
      return;
    }

    const group = await this.requireActiveOrChooseGroup('Add current file to process');
    if (!group) {
      return;
    }

    await this.addUrisToGroup(group.name, [uri], editor.viewColumn);
  }

  async addCurrentTabGroup() {
    const group = await this.requireActiveOrChooseGroup('Add current tab group to process');
    if (!group) {
      return;
    }
    const column = this.resolveCurrentWorkingColumn();
    const uris = this.getOpenFileUrisInColumn(column);
    if (uris.length === 0) {
      void vscode.window.showInformationMessage('Process Tabs: there are no file tabs in the current editor group.');
      return;
    }
    await this.addUrisToGroup(group.name, uris, column);
  }

  async setCurrentProcessArea() {
    const column = (vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.viewColumn)
      || this.resolveCurrentWorkingColumn();
    const state = this.getState();
    state.processViewColumn = column;
    const active = this.getActiveGroup(state);
    if (active) {
      active.preferredViewColumn = column;
      active.updatedAt = new Date().toISOString();
    }
    await this.saveState(state);
    void vscode.window.showInformationMessage(`Process Tabs: this editor group is now the process area.`);
  }

  async removeCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    const uri = editor && editor.document.uri;
    if (!uri || uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Process Tabs: open a file first.');
      return;
    }

    const state = this.getState();
    const active = this.getActiveGroup(state);
    let group = active && active.files.some(raw => sameUri(vscode.Uri.parse(raw), uri)) ? active : undefined;

    if (!group) {
      const matching = state.groups.filter(candidate => candidate.files.some(raw => sameUri(vscode.Uri.parse(raw), uri)));
      if (matching.length === 0) {
        void vscode.window.showInformationMessage('Process Tabs: the current file is not in any process.');
        return;
      }
      if (matching.length === 1) {
        group = matching[0];
      } else {
        group = await this.chooseGroup('Remove current file from process', matching);
      }
    }

    if (!group) {
      return;
    }

    group.files = group.files.filter(raw => !sameUri(vscode.Uri.parse(raw), uri));
    if (group.lastActiveFile && sameUri(vscode.Uri.parse(group.lastActiveFile), uri)) {
      group.lastActiveFile = undefined;
    }
    group.updatedAt = new Date().toISOString();
    await this.saveState(state);
    void vscode.window.showInformationMessage(`Process Tabs: removed current file from “${group.name}”.`);
  }

  async openActiveProcess() {
    const active = this.getActiveGroup(this.getState());
    if (!active) {
      return this.showSwitcher();
    }
    const targetColumn = await this.ensureStableProcessArea(active);
    await this.openGroup(active, targetColumn);
  }

  async closeActiveProcess() {
    const active = this.getActiveGroup(this.getState());
    if (!active) {
      void vscode.window.showInformationMessage('Process Tabs: no active process.');
      return;
    }
    const column = this.resolveHomeColumn(active) || this.resolveCurrentWorkingColumn();
    await this.closeGroupInColumn(active, column, true);
  }

  async renameActiveProcess() {
    const state = this.getState();
    const active = this.getActiveGroup(state);
    if (!active) {
      void vscode.window.showInformationMessage('Process Tabs: no active process.');
      return;
    }

    const value = await vscode.window.showInputBox({
      title: 'Rename process',
      value: active.name,
      prompt: 'Process name',
      validateInput: input => this.validateProcessName(input, active.name)
    });
    const nextName = value && value.trim();
    if (!nextName || nextName === active.name) {
      return;
    }

    const oldName = active.name;
    active.name = nextName;
    active.updatedAt = new Date().toISOString();
    state.activeProcess = nextName;
    await this.saveState(state);
    void vscode.window.showInformationMessage(`Process Tabs: renamed “${oldName}” to “${nextName}”.`);
  }

  async deleteActiveProcess() {
    const state = this.getState();
    const active = this.getActiveGroup(state);
    if (!active) {
      void vscode.window.showInformationMessage('Process Tabs: no active process.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Delete process “${active.name}”? Files on disk will not be touched.`,
      { modal: true },
      'Delete process'
    );
    if (answer !== 'Delete process') {
      return;
    }

    state.groups = state.groups.filter(group => group.name !== active.name);
    state.activeProcess = state.groups[0] ? state.groups[0].name : undefined;
    await this.saveState(state);
  }

  async openGroup(group, targetColumn) {
    if (group.files.length === 0) {
      void vscode.window.showInformationMessage(`Process Tabs: “${group.name}” has no files yet. Open a file and it will be added automatically.`);
      return;
    }

    const missing = [];
    const documents = new Map();

    // Load document buffers first. This does not reveal editors, so the visible
    // tab does not jump file-by-file while a process is being restored.
    await Promise.all(group.files.map(async raw => {
      const uri = vscode.Uri.parse(raw);
      try {
        await vscode.workspace.fs.stat(uri);
        const document = await vscode.workspace.openTextDocument(uri);
        documents.set(uriKey(uri), document);
      } catch {
        missing.push(uri.fsPath || raw);
      }
    }));

    const focusRaw = (group.lastActiveFile && documents.has(uriKey(vscode.Uri.parse(group.lastActiveFile))))
      ? group.lastActiveFile
      : group.files.find(raw => documents.has(uriKey(vscode.Uri.parse(raw))));

    this.suppressTabEvents += 1;
    try {
      if (focusRaw) {
        const focusUri = vscode.Uri.parse(focusRaw);
        const focusDocument = documents.get(uriKey(focusUri));
        await vscode.window.showTextDocument(focusDocument, {
          viewColumn: targetColumn,
          preview: false,
          preserveFocus: false
        });
      }

      for (const raw of group.files) {
        if (raw === focusRaw) {
          continue;
        }
        const uri = vscode.Uri.parse(raw);
        const document = documents.get(uriKey(uri));
        if (!document) {
          continue;
        }
        const targetAlreadyOpen = this.findOpenFileTabs(uri)
          .some(item => item.group.viewColumn === targetColumn);
        if (!targetAlreadyOpen) {
          await vscode.window.showTextDocument(document, {
            viewColumn: targetColumn,
            preview: false,
            preserveFocus: true
          });
        }
      }

      // If an older version (or a manual open) left a clean process file in a
      // different editor group, keep the target copy and close the stray view.
      // This makes the process area stable without touching non-process tabs.
      const duplicateTabs = [];
      for (const raw of group.files) {
        const uri = vscode.Uri.parse(raw);
        const document = documents.get(uriKey(uri));
        if (!document || document.isDirty) {
          continue;
        }
        for (const location of this.findOpenFileTabs(uri)) {
          if (location.group.viewColumn !== targetColumn) {
            duplicateTabs.push(location.tab);
          }
        }
      }
      if (duplicateTabs.length > 0) {
        await vscode.window.tabGroups.close(duplicateTabs, true);
      }

      // Reassert the one file the user should see. Background tab creation can
      // otherwise make VS Code visually walk through each source.
      if (focusRaw) {
        const focusUri = vscode.Uri.parse(focusRaw);
        const focusDocument = documents.get(uriKey(focusUri));
        await vscode.window.showTextDocument(focusDocument, {
          viewColumn: targetColumn,
          preview: false,
          preserveFocus: false
        });
      }
    } finally {
      this.suppressTabEvents -= 1;
    }

    const state = this.getState();
    const stored = state.groups.find(item => item.name === group.name);
    if (stored) {
      stored.preferredViewColumn = targetColumn;
      stored.updatedAt = new Date().toISOString();
      state.processViewColumn = targetColumn;
      state.activeProcess = stored.name;
      await this.saveState(state);
    }

    if (missing.length > 0) {
      void vscode.window.showWarningMessage(
        `Process Tabs: ${missing.length} saved file${missing.length === 1 ? ' is' : 's are'} missing and could not be opened.`
      );
    }
  }

  async relocateFileToColumn(uri, targetColumn) {
    const locations = this.findOpenFileTabs(uri);
    if (locations.some(item => item.group.viewColumn === targetColumn)) {
      return;
    }

    // If the source was opened in a tool/editor group (Claude, ChatGPT, a
    // webview, etc.), keep that group focused and only move the source tab.
    // Closing the temporary source copy then reveals the tool exactly where it
    // was instead of making the tool look like another source tab.
    const openedInToolGroup = locations.some(item => this.groupHasNonFileTabs(item.group, uri));

    const document = vscode.workspace.textDocuments.find(doc => sameUri(doc.uri, uri))
      || await vscode.workspace.openTextDocument(uri);

    this.suppressTabEvents += 1;
    try {
      await vscode.window.showTextDocument(document, {
        viewColumn: targetColumn,
        preview: false,
        preserveFocus: openedInToolGroup
      });

      const oldTabs = this.findOpenFileTabs(uri)
        .filter(item => item.group.viewColumn !== targetColumn)
        .map(item => item.tab);
      if (oldTabs.length > 0) {
        await vscode.window.tabGroups.close(oldTabs, true);
      }
    } finally {
      this.suppressTabEvents -= 1;
    }
  }

  async ensureStableProcessArea(processGroup, ignoreUri) {
    const protectTools = vscode.workspace
      .getConfiguration('processTabs')
      .get('keepToolEditorsSeparate', true);

    const groups = () => vscode.window.tabGroups.all
      .slice()
      .sort((a, b) => (a.viewColumn || 999) - (b.viewColumn || 999));

    const cleanGroup = tabGroup => !protectTools || !this.groupHasNonFileTabs(tabGroup, ignoreUri);

    // Best signal: where the current process files already live. Prefer a
    // code-only editor group so a tool webview never becomes the process area.
    if (processGroup && Array.isArray(processGroup.files) && processGroup.files.length > 0) {
      const wanted = new Set(processGroup.files.map(raw => uriKey(vscode.Uri.parse(raw))));
      let best;
      let bestCount = 0;
      for (const tabGroup of groups()) {
        if (!cleanGroup(tabGroup)) {
          continue;
        }
        let count = 0;
        for (const tab of tabGroup.tabs) {
          const uri = tabUri(tab);
          if (uri && uri.scheme === 'file' && wanted.has(uriKey(uri))) {
            count += 1;
          }
        }
        if (count > bestCount) {
          best = tabGroup;
          bestCount = count;
        }
      }
      if (best) {
        await this.rememberProcessColumn(best.viewColumn, processGroup);
        return best.viewColumn;
      }
    }

    const state = this.getState();
    const preferredColumn = state.processViewColumn || (processGroup && processGroup.preferredViewColumn);
    const preferredGroup = groups().find(item => item.viewColumn === preferredColumn);
    if (preferredGroup && cleanGroup(preferredGroup)) {
      return preferredGroup.viewColumn;
    }

    // Reuse an existing code-only group before creating anything new.
    const existingCodeGroup = groups().find(cleanGroup);
    if (existingCodeGroup) {
      await this.rememberProcessColumn(existingCodeGroup.viewColumn, processGroup);
      return existingCodeGroup.viewColumn;
    }

    // Only tool groups remain. Create a fresh group on the left so tools such
    // as Claude stay on the right and sources get their own normal editor area.
    if (protectTools && groups().length > 0) {
      try {
        await vscode.commands.executeCommand(NEW_GROUP_LEFT_COMMAND);
        const after = groups();
        const created = after.find(group => !this.groupHasNonFileTabs(group, ignoreUri)) || after[0];
        if (created) {
          await this.rememberProcessColumn(created.viewColumn, processGroup);
          return created.viewColumn;
        }
      } catch (error) {
        console.error('Process Tabs: could not create a separate process editor group', error);
      }
    }

    return vscode.ViewColumn.One;
  }

  async rememberProcessColumn(column, processGroup) {
    if (!column) {
      return;
    }
    const state = this.getState();
    state.processViewColumn = column;
    if (processGroup) {
      const stored = state.groups.find(group => group.name === processGroup.name);
      if (stored) {
        stored.preferredViewColumn = column;
      }
    }
    await this.saveState(state);
  }

  groupHasNonFileTabs(tabGroup, ignoreUri) {
    for (const tab of tabGroup.tabs) {
      const uri = tabUri(tab);
      if (uri && uri.scheme === 'file') {
        if (ignoreUri && sameUri(uri, ignoreUri)) {
          continue;
        }
        continue;
      }
      return true;
    }
    return false;
  }

  async focusBestFile(group, targetColumn) {
    const candidates = unique([
      ...(group.lastActiveFile ? [group.lastActiveFile] : []),
      ...group.files
    ]);

    for (const raw of candidates) {
      const uri = vscode.Uri.parse(raw);
      const location = this.findOpenFileTabs(uri).find(item => item.group.viewColumn === targetColumn);
      if (!location) {
        continue;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
          viewColumn: targetColumn,
          preview: false,
          preserveFocus: false
        });
        return;
      } catch {
        // Try next candidate.
      }
    }
  }

  async closeGroupInColumn(group, column, showResult, exceptUris) {
    const wanted = new Set(group.files.map(raw => uriKey(vscode.Uri.parse(raw))));
    const dirty = new Set(
      vscode.workspace.textDocuments
        .filter(document => document.isDirty)
        .map(document => uriKey(document.uri))
    );

    const matchingHere = [];
    let matchingElsewhere = 0;

    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        const uri = tabUri(tab);
        if (!uri || uri.scheme !== 'file') {
          continue;
        }
        const key = uriKey(uri);
        if (!wanted.has(key) || (exceptUris && exceptUris.has(key))) {
          continue;
        }
        if (tabGroup.viewColumn === column) {
          matchingHere.push({ tab, uri });
        } else {
          matchingElsewhere += 1;
        }
      }
    }

    const closable = matchingHere.filter(item => !dirty.has(uriKey(item.uri))).map(item => item.tab);
    const protectedCount = matchingHere.length - closable.length;

    if (closable.length > 0) {
      // Closing tabs because Process Tabs is switching/hiding a process must
      // not be interpreted as the user removing those sources from the saved
      // process. Manual tab closes remain observable outside this guard.
      this.suppressTabEvents += 1;
      try {
        await vscode.window.tabGroups.close(closable, true);
      } finally {
        this.suppressTabEvents -= 1;
      }
    }

    if (showResult) {
      const details = [];
      if (protectedCount > 0) {
        details.push(`${protectedCount} unsaved file${protectedCount === 1 ? ' was' : 's were'} kept open`);
      }
      if (matchingElsewhere > 0) {
        details.push(`${matchingElsewhere} matching tab${matchingElsewhere === 1 ? '' : 's'} in other editor groups ${matchingElsewhere === 1 ? 'was' : 'were'} left untouched`);
      }
      const suffix = details.length ? ` ${details.join('; ')}.` : '';
      void vscode.window.showInformationMessage(
        `Process Tabs: closed ${closable.length} tab${closable.length === 1 ? '' : 's'} from “${group.name}”.${suffix}`
      );
    } else if (protectedCount > 0) {
      void vscode.window.showWarningMessage(
        `Process Tabs: ${protectedCount} unsaved file${protectedCount === 1 ? ' was' : 's were'} kept open while switching.`
      );
    }
  }

  async rememberActiveFile(uri) {
    const state = this.getState();
    const active = this.getActiveGroup(state);
    if (!active || !active.files.some(raw => sameUri(vscode.Uri.parse(raw), uri))) {
      return;
    }

    const raw = uri.toString();
    if (active.lastActiveFile === raw) {
      return;
    }

    active.lastActiveFile = raw;
    active.updatedAt = new Date().toISOString();
    await this.saveState(state);
  }

  async addUrisToGroup(groupName, uris, preferredColumn, silent = false) {
    const state = this.getState();
    const group = state.groups.find(item => item.name === groupName);
    if (!group) {
      return;
    }

    const before = group.files.length;
    group.files = unique([
      ...group.files,
      ...uris.filter(uri => uri.scheme === 'file').map(uri => uri.toString())
    ]);
    group.preferredViewColumn = preferredColumn || state.processViewColumn || group.preferredViewColumn;
    state.processViewColumn = state.processViewColumn || group.preferredViewColumn || preferredColumn;
    group.updatedAt = new Date().toISOString();
    state.activeProcess = group.name;
    await this.saveState(state);

    const added = group.files.length - before;
    if (!silent) {
      void vscode.window.showInformationMessage(
        added > 0
          ? `Process Tabs: added ${added} file${added === 1 ? '' : 's'} to “${group.name}”.`
          : `Process Tabs: those files are already in “${group.name}”.`
      );
    }
  }

  async requireActiveOrChooseGroup(title) {
    const state = this.getState();
    const active = this.getActiveGroup(state);
    if (active) {
      return active;
    }
    if (state.groups.length === 0) {
      void vscode.window.showInformationMessage('Process Tabs: create a process first.');
      return undefined;
    }
    return this.chooseGroup(title, state.groups);
  }

  async chooseGroup(title, groups) {
    const list = (groups || this.getState().groups)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(group => ({
        label: `$(folder) ${group.name}`,
        description: `${group.files.length} file${group.files.length === 1 ? '' : 's'}`,
        group
      }));
    const picked = await vscode.window.showQuickPick(list, {
      title,
      placeHolder: 'Select a process'
    });
    return picked && picked.group;
  }

  async askForNewProcessName() {
    const value = await vscode.window.showInputBox({
      title: 'Create process',
      prompt: 'Example: TLMAT143 - COMEX, PADRONES, Pedido de Venta',
      placeHolder: 'Process name',
      validateInput: input => this.validateProcessName(input)
    });
    return value && value.trim() ? value.trim() : undefined;
  }

  validateProcessName(value, currentName) {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'Enter a process name.';
    }
    const exists = this.getState().groups.some(group =>
      group.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase() && group.name !== currentName
    );
    return exists ? 'A process with that name already exists.' : undefined;
  }

  refreshStatusBar() {
    const show = vscode.workspace.getConfiguration('processTabs').get('showStatusBar', true);
    if (!show) {
      this.statusBar.hide();
      return;
    }

    const state = this.getState();
    const active = this.getActiveGroup(state);
    if (active) {
      this.statusBar.text = `$(folder-library) ${active.name} (${active.files.length})`;
      this.statusBar.tooltip = `Process Tabs · ${active.name}\nClick to switch process.`;
    } else {
      this.statusBar.text = '$(folder-library) Process Tabs';
      this.statusBar.tooltip = 'Click to create or switch process.';
    }
    this.statusBar.show();
  }

  resolveSwitchTargetColumn(previous, selected) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file' && activeEditor.viewColumn) {
      if (previous && previous.files.some(raw => sameUri(vscode.Uri.parse(raw), activeEditor.document.uri))) {
        return activeEditor.viewColumn;
      }
    }

    return this.resolveHomeColumn(previous)
      || this.resolveHomeColumn(selected)
      || (activeEditor && activeEditor.viewColumn)
      || (vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.viewColumn)
      || vscode.ViewColumn.One;
  }

  resolveHomeColumn(group) {
    if (!group) {
      return undefined;
    }

    const wanted = new Set(group.files.map(raw => uriKey(vscode.Uri.parse(raw))));
    let bestColumn;
    let bestCount = 0;
    for (const tabGroup of vscode.window.tabGroups.all) {
      let count = 0;
      for (const tab of tabGroup.tabs) {
        const uri = tabUri(tab);
        if (uri && uri.scheme === 'file' && wanted.has(uriKey(uri))) {
          count += 1;
        }
      }
      if (count > bestCount) {
        bestColumn = tabGroup.viewColumn;
        bestCount = count;
      }
    }

    if (bestColumn) {
      return bestColumn;
    }
    if (group.preferredViewColumn && this.viewColumnExists(group.preferredViewColumn)) {
      return group.preferredViewColumn;
    }
    return undefined;
  }

  resolveCurrentWorkingColumn() {
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    if (activeGroup && activeGroup.viewColumn) {
      return activeGroup.viewColumn;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file' && editor.viewColumn) {
      return editor.viewColumn;
    }
    return vscode.ViewColumn.One;
  }

  getOpenFileUrisInColumn(column) {
    const group = vscode.window.tabGroups.all.find(item => item.viewColumn === column);
    if (!group) {
      return [];
    }
    const map = new Map();
    for (const tab of group.tabs) {
      const uri = tabUri(tab);
      if (uri && uri.scheme === 'file') {
        map.set(uriKey(uri), uri);
      }
    }
    return [...map.values()];
  }

  findOpenFileTabs(uri) {
    const result = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const candidate = tabUri(tab);
        if (candidate && candidate.scheme === 'file' && sameUri(candidate, uri)) {
          result.push({ tab, group });
        }
      }
    }
    return result;
  }

  activeFileInUris(uris) {
    const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    if (!active || active.scheme !== 'file') {
      return undefined;
    }
    return uris.some(uri => sameUri(uri, active)) ? active.toString() : undefined;
  }

  viewColumnExists(column) {
    return vscode.window.tabGroups.all.some(group => group.viewColumn === column);
  }

  getState() {
    const raw = this.context.workspaceState.get(STORAGE_KEY, { groups: [] }) || { groups: [] };
    const state = {
      groups: Array.isArray(raw.groups) ? raw.groups : [],
      activeProcess: raw.activeProcess,
      processViewColumn: raw.processViewColumn
    };

    for (const group of state.groups) {
      group.files = unique(Array.isArray(group.files) ? group.files : []);
      group.createdAt = group.createdAt || new Date().toISOString();
      group.updatedAt = group.updatedAt || group.createdAt;
    }

    if (state.activeProcess && !state.groups.some(group => group.name === state.activeProcess)) {
      state.activeProcess = state.groups[0] ? state.groups[0].name : undefined;
    }
    return state;
  }

  async saveState(state) {
    state.groups.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.workspaceState.update(STORAGE_KEY, state);
    this.refreshStatusBar();
  }

  getActiveGroup(state) {
    return state.activeProcess
      ? state.groups.find(group => group.name === state.activeProcess)
      : undefined;
  }
}

function actionItem(action, label, description) {
  return { action, label, description, alwaysShow: true };
}

function separator(label) {
  return { kind: vscode.QuickPickItemKind.Separator, label };
}

function tabUri(tab) {
  if (tab.input instanceof vscode.TabInputText) {
    return tab.input.uri;
  }
  return undefined;
}

function uriKey(uri) {
  if (uri.scheme === 'file') {
    const filePath = uri.fsPath.replace(/\\/g, '/');
    return process.platform === 'win32' ? filePath.toLocaleLowerCase() : filePath;
  }
  return uri.toString();
}

function sameUri(a, b) {
  return uriKey(a) === uriKey(b);
}

function unique(values) {
  const result = new Map();
  for (const value of values) {
    const uri = vscode.Uri.parse(value);
    result.set(uriKey(uri), value);
  }
  return [...result.values()];
}

function deactivate() {}

module.exports = { activate, deactivate };
