# Process Tabs

**Process Tabs** lets you save named sets of related editor tabs and switch between them without reorganizing your folders or keeping a sidebar open.

It is useful when one workspace contains many unrelated tasks, modules, tickets, features, or processes and you want each context to have its own set of open files.

> **Status:** public beta. Version `0.4.0` is the first repository-ready release candidate.

## Why Process Tabs?

A large workspace can easily turn into a long row of unrelated tabs. Process Tabs adds a lightweight context layer on top of the files you already have:

- Create a named process from the tabs in your current editor group.
- Create an empty process and add files simply by opening them.
- Switch between processes from the editor title button or status bar.
- Close clean tabs from the previous process automatically.
- Keep unsaved files open and protected.
- Remember the last active file for each process.
- Keep source files in a dedicated editor group while tool/custom editors such as Claude or ChatGPT stay separate.
- Remove a source from the process when you close its last tab manually.
- Store process definitions per workspace.

No files are moved or renamed on disk. Processes are virtual groups stored in VS Code workspace state.

## Typical workflow

1. Open the files for a task.
2. Run **Process Tabs: Create Process from Current Tab Group**.
3. Give it a name, for example `Payments`, `Bug #431`, `COMEX`, or `Padrones`.
4. Create another process for another task.
5. Use the **Process Tabs** button or status bar item to switch between them.

You can also create an empty process. With auto-add enabled, any file you open while that process is active is added automatically.

## Commands

- **Process Tabs: Switch Process**
- **Process Tabs: Manage Processes**
- **Process Tabs: Create Process from Current Tab Group**
- **Process Tabs: Add Current File to Active Process**
- **Process Tabs: Add Current Tab Group to Active Process**
- **Process Tabs: Use Current Editor Group as Process Area**

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `processTabs.closePreviousOnSwitch` | `true` | Close clean tabs from the previous process when switching. |
| `processTabs.showStatusBar` | `true` | Show the active process in the status bar. |
| `processTabs.autoAddOpenedFiles` | `true` | Add newly opened files to the active process automatically. |
| `processTabs.removeClosedFiles` | `true` | Remove a file from the active process after its last tab is closed manually. |
| `processTabs.moveNewFilesToProcessArea` | `true` | Keep newly opened process files in the configured process editor area. |
| `processTabs.keepToolEditorsSeparate` | `true` | Keep tool/custom-editor tabs separate from source files. |

## Safety behavior

Process Tabs is deliberately conservative around unsaved work:

- Dirty/unsaved documents are not closed automatically during a process switch.
- Deleting a process only deletes the virtual group. It never deletes files from disk.
- Closing tabs as part of an internal process switch does not remove those files from the saved process.

## Compilation and other extensions

Process Tabs only manages editor tabs. It does **not** change the behavior or scope of compiler commands provided by other extensions.

For example, if another extension compiles all currently open source editors, switching Process Tabs contexts can be useful because clean sources from the previous context are closed. Always verify the compile behavior of the language/tooling extension you use.

## Privacy

Process Tabs does not include analytics, telemetry, advertising, remote services, or account access. Process definitions are stored locally in VS Code workspace state. See [PRIVACY.md](PRIVACY.md).

## Compatibility

Process Tabs targets VS Code `1.90.0` and newer and is designed to work with VS Code-compatible editors that implement the same extension APIs.

## Development

The extension is intentionally small and currently uses plain JavaScript with the VS Code Extension API.

```text
src/extension.js   source
out/extension.js   packaged runtime copy
```

To test locally, open this repository in VS Code and run an Extension Development Host, or package it as a VSIX with `@vscode/vsce`.

## Issues and contributions

Bug reports and feature ideas are welcome in [GitHub Issues](https://github.com/nahuel-canseco/process-tabs/issues).

If reporting a tab-layout bug, please include:

- VS Code/editor version
- Process Tabs version
- whether split editor groups are in use
- whether the affected file had unsaved changes
- minimal steps to reproduce the behavior

## License

MIT License. See [LICENSE](LICENSE).

---

## Español

Process Tabs permite guardar grupos virtuales de archivos por tarea o proceso y cambiar entre ellos sin mover archivos de carpeta ni depender de una barra lateral. Los procesos se guardan por workspace, los archivos sin guardar se protegen y, por defecto, los archivos que abrís se agregan automáticamente al proceso activo.
