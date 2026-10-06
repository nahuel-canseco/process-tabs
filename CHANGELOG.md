# Changelog

All notable changes to Process Tabs will be documented in this file.

## 0.4.0

- Prepared the project for public GitHub and extension-registry distribution.
- Added repository, issue tracker, homepage, author, icon and gallery metadata.
- Added public documentation, privacy information and issue templates.
- Kept the tested 0.3.4 runtime behavior unchanged.

## 0.3.4

- Closing a source tab manually now removes that source from the active process.
- Closing one duplicate view or moving a tab between editor groups does not remove the source while another view remains open.
- Process Tabs internal closes are suppressed so switching processes never erases saved process membership.
- Added `processTabs.removeClosedFiles`, enabled by default.

## 0.3.3

- Keep tool/custom-editor tabs such as Claude/ChatGPT separate from process source tabs by default.
- Recreate a code group on the left when the process editor group disappears.
- Resolve the process area dynamically after layout changes.
- Keep the code group alive while switching between populated processes.

## 0.3.2

- Automatically add newly opened files to the active process by default.
- Added a workspace-level process area for source tabs.
- Added **Use current editor group as process area**.
- Improved process restore behavior and duplicate-tab cleanup.

## 0.3.1

- Fixed empty-process creation so it acts as a real context switch.

## 0.3.0

- Removed the experimental fake-folder tabs.
- Added the compact process switcher UX.
- Prevented blindly duplicating already-open files during switching.
