# Roadmap

- [x] [Process Manager](prompts/process-manager.md)
- [x] [Sidebar hover actions truncation](prompts/sidebar-hover-actions-truncation.md)
- [x] [Sidebar project/worktree context menus](prompts/sidebar-project-worktree-context-menus.md)
- [x] [Terminal rich text links](prompts/terminal-rich-text-links.md)
- [x] [VS Code CLI `serve-web` support](prompts/vscode-cli-serve-web.md)
- [x] [Integrated browser tab](prompts/integrated-browser-tab.md)
- [x] [Tab splitting](prompts/tab-splitting.md)
- [x] [Task system](prompts/task-system.md)
- [x] [Worktree state persistence](prompts/worktree-state-persistence.md)
- [x] [Terminal tab naming](prompts/terminal-tab-naming.md)
- [x] [Frontend command system](prompts/frontend-command-system.md)
- [x] [Keyboard shortcuts system](prompts/keyboard-shortcuts-system.md)
- [ ] [Agent chat UI](prompts/agent-chat-ui.md)
- [ ] Support project/worktree local settings in a `.hubris` directory in the
      project root. Starting with `.hubris/environments.toml` which defines zero
      or more named environments for the project. One can optionally be set as
      the default. Initially the only environment setting will be a setup script
      to execute after creating a new worktree. Execution will happen by simply
      taking the setup script body, and executing it in a new terminal tab
      that's auto-created after creating the worktree. The setup tab should have
      a custom label of "Setup".
