/**
 * Whole-note encryption feature.
 *
 * Registers commands, ribbon icons, and file menu items for:
 * - Creating new encrypted notes
 * - Locking/closing all encrypted notes
 * - Changing passwords
 * - Converting notes between .md and .locked
 * - Clearing the session cache
 * - Auto-encrypting new daily notes
 */

import { TFile, TFolder, Notice, Menu, WorkspaceLeaf, MarkdownView, setIcon, normalizePath } from "obsidian";
import type { IAFEFeature } from "../feature-interface";
import type AFEPlugin from "../../main";
import { NoteConverter } from "./note-converter";
import { PasswordModal } from "../../ui/password-modal";
import { encode, LOCKED_EXTENSION, createPendingFile } from "../../services/file-data";
import {
  EncryptedMarkdownView,
} from "../../views/encrypted-markdown-view";

export class WholeNoteFeature implements IAFEFeature {
  private plugin!: AFEPlugin;
  private converter!: NoteConverter;
  private ribbonIconEl: HTMLElement | null = null;
  private originalGetLeavesOfType: ((type: string) => WorkspaceLeaf[]) | null = null;

  async onload(plugin: AFEPlugin): Promise<void> {
    this.plugin = plugin;
    this.converter = new NoteConverter(plugin);

    // --- Commands ---

    plugin.addCommand({
      id: "create-encrypted-note",
      name: "Create new encrypted note",
      callback: () => this.createEncryptedNote(),
    });

    plugin.addCommand({
      id: "lock-all",
      name: "Lock and close all encrypted notes",
      callback: () => this.lockAll(),
    });

    plugin.addCommand({
      id: "change-password",
      name: "Change password of current note",
      checkCallback: (checking) => {
        const view = plugin.app.workspace.getActiveViewOfType(EncryptedMarkdownView);
        if (!view) return false;
        if (!checking) view.changePassword();
        return true;
      },
    });

    plugin.addCommand({
      id: "clear-session",
      name: "Clear session cache",
      callback: () => {
        plugin.sessionManager.clear();
        this.updateRibbonIcon();
        new Notice("Advanced File Encryption: Session cache cleared.");
      },
    });

    plugin.addCommand({
      id: "convert-to-encrypted",
      name: "Encrypt current note",
      checkCallback: (checking) => {
        const file = plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.converter.toEncrypted(file);
        return true;
      },
    });

    plugin.addCommand({
      id: "convert-to-decrypted",
      name: "Decrypt current note",
      checkCallback: (checking) => {
        const file = plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== LOCKED_EXTENSION) return false;
        if (!checking) this.converter.toDecrypted(file);
        return true;
      },
    });

    // --- Ribbon icon ---

    this.ribbonIconEl = plugin.addRibbonIcon("lock-keyhole", "Set session password", () => {
      this.ribbonAction();
    });

    // --- File menu (right-click) ---

    plugin.registerEvent(
      (plugin.app.workspace as any).on("file-menu", (menu: Menu, file: TFile | TFolder) => {
        if (file instanceof TFile) {
          if (file.extension === "md") {
            menu.addItem((item) => {
              item.setTitle("Encrypt note")
                .setIcon("lock")
                .onClick(() => this.converter.toEncrypted(file));
            });
          } else if (file.extension === LOCKED_EXTENSION) {
            menu.addItem((item) => {
              item.setTitle("Decrypt note")
                .setIcon("unlock")
                .onClick(() => this.converter.toDecrypted(file));
            });
            menu.addItem((item) => {
              item.setTitle("Lock and close")
                .setIcon("lock")
                .onClick(() => this.lockFile(file));
            });
          }
        } else if (file instanceof TFolder) {
          menu.addItem((item) => {
            item.setTitle("New encrypted note")
              .setIcon("file-lock")
              .onClick(() => this.createEncryptedNote(file));
          });
        }
      })
    );

    // --- View header encrypt/decrypt icons ---

    plugin.registerEvent(
      plugin.app.workspace.on("active-leaf-change", (leaf) => {
        // Update ribbon icon to reflect session state
        this.updateRibbonIcon();

        if (!leaf) return;
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) return;

        const actions = (view as any).actionsEl as HTMLElement | undefined;
        if (!actions) return;

        // Remove stale AFE action buttons — the file may have changed
        actions.querySelector(".afe-encrypt-action")?.remove();
        actions.querySelector(".afe-decrypt-action")?.remove();

        const file = view.file;
        if (!file) return;

        if (file.extension === "md") {
          // .md file → show lock icon to encrypt
          const action = view.addAction("lock", "Encrypt note", () => {
            if (view.file) this.converter.toEncrypted(view.file);
          });
          action.addClass("afe-encrypt-action");
          this.positionAfterBookmark(actions, action);
        } else if (file.extension === "locked") {
          // .locked file → show unlock icon to decrypt
          const action = view.addAction("unlock", "Decrypt note", () => {
            if (view.file) this.converter.toDecrypted(view.file);
          });
          action.addClass("afe-decrypt-action");
          this.positionAfterBookmark(actions, action);
        }
      })
    );

    // --- Auto-encrypt daily notes & duplicate prevention ---

    plugin.registerEvent(
      plugin.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== "md") return;
        if (this.converter.isConverting) return;
        if (!this.isDailyNote(file)) return;

        // If an encrypted version already exists, the daily notes plugin
        // (or calendar, navbar, etc.) created a duplicate .md. Delete it
        // and open the .locked instead.
        const lockedPath = normalizePath(file.path.replace(/\.md$/, `.${LOCKED_EXTENSION}`));
        const lockedFile = this.plugin.app.vault.getAbstractFileByPath(lockedPath);
        if (lockedFile instanceof TFile) {
          setTimeout(async () => {
            // Navigate any leaf showing the duplicate .md away BEFORE
            // deleting it to prevent Obsidian's "file not found" error.
            const leavesToRedirect: WorkspaceLeaf[] = [];
            this.plugin.app.workspace.iterateAllLeaves((leaf) => {
              if (
                leaf.view instanceof MarkdownView &&
                (leaf.view as any).file?.path === file.path
              ) {
                leavesToRedirect.push(leaf);
              }
            });
            for (const leaf of leavesToRedirect) {
              await leaf.setViewState({ type: "empty", state: {} });
            }

            // Delete the duplicate .md
            const current = this.plugin.app.vault.getAbstractFileByPath(file.path);
            if (current instanceof TFile) {
              await this.plugin.app.vault.delete(current);
            }
            // Open the encrypted version
            const leaf = leavesToRedirect[0] ?? this.plugin.app.workspace.getLeaf(false);
            await leaf.openFile(lockedFile);
          }, 100);
          return;
        }

        // Auto-encrypt if enabled
        if (this.plugin.settings.autoEncryptDailyNotes) {
          setTimeout(() => this.autoEncryptFile(file), 500);
        }
      })
    );

    // --- Patch daily notes command to find .locked files ---

    plugin.app.workspace.onLayoutReady(() => {
      this.patchDailyNotesCommand();
      this.patchGetLeavesOfType();
    });
  }

  onunload(): void {
    // Restore original getLeavesOfType if we patched it
    if (this.originalGetLeavesOfType) {
      this.plugin.app.workspace.getLeavesOfType = this.originalGetLeavesOfType;
      this.originalGetLeavesOfType = null;
    }
  }

  buildSettingsUi(_containerEl: HTMLElement, _saveCallback: () => Promise<void>): void {
    // No feature-specific settings beyond the global ones
  }

  // --- Actions ---

  private async createEncryptedNote(folder?: TFolder): Promise<void> {
    // Determine target folder
    const targetFolder = folder
      ?? this.plugin.app.fileManager.getNewFileParent("")
      ?? this.plugin.app.vault.getRoot();

    // Generate unique filename
    let baseName = "Encrypted note";
    let counter = 0;
    let filePath = normalizePath(`${targetFolder.path}/${baseName}.${LOCKED_EXTENSION}`);
    while (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
      counter++;
      filePath = normalizePath(`${targetFolder.path}/${baseName} ${counter}.${LOCKED_EXTENSION}`);
    }

    // Create a pending (uninitialized) .locked file — the view will detect
    // this and show the inline "Set up encryption" card instead of a modal.
    const pendingContent = createPendingFile();
    const file = await this.plugin.app.vault.create(filePath, pendingContent);

    // Open the new note — the view's onLoadFile will show the encrypt card
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(file, { state: { mode: "source" } });
  }

  /**
   * Ribbon button toggle:
   * - No session → prompt for password → store as session password
   * - Has session → lock all encrypted notes + clear session
   */
  private async ribbonAction(): Promise<void> {
    if (this.plugin.sessionManager.hasEntries()) {
      // Session active → lock all
      this.lockAll();
    } else {
      // No session → prompt for password
      const result = await PasswordModal.prompt(
        this.plugin.app,
        "encrypt",
        "",
        this.plugin.settings.confirmPassword,
        false, // no hint for session password
        this.plugin.settings.showCleartextPassword,
        "Set session password",
      );
      if (!result) return;
      // Store as a global session password (use empty path as a global entry)
      this.plugin.sessionManager.put("__session__", result.password, "");
      this.updateRibbonIcon();
      new Notice("Session password set.");
    }
  }

  private lockAll(): void {
    for (const leaf of this.getEncryptedLeaves()) {
      (leaf.view as EncryptedMarkdownView).lockAndClose();
    }
    this.plugin.sessionManager.clear();
    this.updateRibbonIcon();
    new Notice("All encrypted notes locked.");
  }

  private async lockFile(file: TFile): Promise<void> {
    for (const leaf of this.getEncryptedLeaves()) {
      if ((leaf.view as any).file?.path === file.path) {
        (leaf.view as EncryptedMarkdownView).lockAndClose();
      }
    }
  }

  /**
   * Patch the core daily-notes "Open today's daily note" command to check
   * for an encrypted .locked version before falling through to the default.
   * This makes the daily notes button, hotkey, and calendar plugin all
   * open the encrypted daily note if one exists.
   */
  private patchDailyNotesCommand(): void {
    const dailyNotes = (this.plugin.app as any).internalPlugins?.getPluginById?.("daily-notes");
    if (!dailyNotes?.enabled) return;

    const options = dailyNotes.instance?.options;
    const folder = (options?.folder ?? "").replace(/^\/|\/$/g, "");
    const format = options?.format ?? "YYYY-MM-DD";

    const allCommands = (this.plugin.app as any).commands?.commands;
    if (!allCommands) return;

    // The core daily notes command ID is "daily-notes"
    for (const [id, cmd] of Object.entries(allCommands)) {
      if (id !== "daily-notes") continue;
      const command = cmd as any;
      if (!command.callback) continue;

      const original = command.callback;
      command.callback = async () => {
        const today = (window as any).moment().format(format);
        const lockedPath = normalizePath(folder
          ? `${folder}/${today}.${LOCKED_EXTENSION}`
          : `${today}.${LOCKED_EXTENSION}`);

        const lockedFile = this.plugin.app.vault.getAbstractFileByPath(lockedPath);
        if (lockedFile instanceof TFile) {
          const leaf = this.plugin.app.workspace.getLeaf(false);
          await leaf.openFile(lockedFile);
          return;
        }

        // No encrypted version — fall through to original
        original();
      };
      break;
    }
  }

  /**
   * Patch workspace.getLeavesOfType so that querying "markdown" also
   * returns leaves with an EncryptedMarkdownView. This makes encrypted
   * notes visible to plugins like Daily Note Navbar that enumerate
   * markdown leaves.
   */
  private patchGetLeavesOfType(): void {
    if (!this.plugin.settings.dailyNoteNavbarIntegration) return;

    const navbar = (this.plugin.app as any).plugins?.plugins?.["daily-note-navbar"];
    if (!navbar) return;

    const workspace = this.plugin.app.workspace;
    this.originalGetLeavesOfType = workspace.getLeavesOfType.bind(workspace);
    const original = this.originalGetLeavesOfType;

    workspace.getLeavesOfType = (type: string): WorkspaceLeaf[] => {
      const leaves = original(type);
      if (type === "markdown") {
        workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
          if (leaf.view instanceof EncryptedMarkdownView && !leaves.includes(leaf)) {
            leaves.push(leaf);
          }
        });
      }
      return leaves;
    };
  }

  /**
   * Check if a file is in the daily notes folder.
   * Reads the core daily-notes plugin settings for the configured folder.
   */
  private isDailyNote(file: TFile): boolean {
    const dailyNotes = (this.plugin.app as any).internalPlugins?.getPluginById?.("daily-notes");
    if (!dailyNotes?.enabled) return false;
    const folder = (dailyNotes.instance?.options?.folder ?? "").replace(/^\/|\/$/g, "");
    if (!folder) return false;
    const fileFolder = file.parent?.path ?? "";
    return fileFolder === folder;
  }

  /**
   * Auto-encrypt a file using the session password. Silent — never prompts.
   * If no password is cached, the file stays as .md until the user encrypts
   * it manually or a session password becomes available.
   *
   * Uses the blank-tab approach (same as NoteConverter) to avoid breaking
   * the local graph panel.
   */
  private async autoEncryptFile(file: TFile): Promise<void> {
    // Verify the file still exists and is still .md (might have been encrypted already)
    const current = this.plugin.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile) || current.extension !== "md") return;

    // Only encrypt when a session password is available — never prompt
    const password = this.plugin.sessionManager.getPassword(file.path);
    if (!password) return;
    const hint = "";

    const plaintext = await this.plugin.app.vault.read(current);
    const encryptedJson = await encode(plaintext, password, hint);
    const oldPath = current.path;
    const newPath = normalizePath(current.path.replace(/\.md$/, `.${LOCKED_EXTENSION}`));

    // Find editor leaves (MarkdownView only, not sidebar panels)
    const leaves: WorkspaceLeaf[] = [];
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.view instanceof MarkdownView &&
        (leaf.view as any).file?.path === current.path
      ) {
        leaves.push(leaf);
      }
    });

    // Navigate leaves to blank state to detach local graph
    for (const leaf of leaves) {
      await leaf.setViewState({ type: "empty", state: {} });
    }

    // Let sidebar panels settle
    if (leaves.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Cache password BEFORE rename so EncryptedMarkdownView can auto-decrypt
    this.plugin.sessionManager.put(newPath, password, hint);

    // Encrypt on disk while no view displays the file
    await this.plugin.app.vault.process(current, () => encryptedJson);
    await this.plugin.app.fileManager.renameFile(current, newPath);

    // Open the encrypted file — EncryptedMarkdownView loads and auto-decrypts
    for (const leaf of leaves) {
      await leaf.openFile(current);
    }

    await this.converter.updateManualSortOrder(oldPath, newPath);

    new Notice(`Daily note encrypted: ${current.basename}`);
  }

  /**
   * Move an action button so it sits right after the bookmark button
   * in the view header.  Order: [bookmark] [our icon] [edit/view toggle] ...
   * addAction() prepends, so without this our icon lands before the bookmark.
   */
  private positionAfterBookmark(actionsEl: HTMLElement, actionEl: HTMLElement): void {
    const bookmarkBtn = Array.from(actionsEl.children).find((el) =>
      el.getAttribute("aria-label")?.toLowerCase().includes("bookmark")
    );
    if (bookmarkBtn) {
      bookmarkBtn.after(actionEl);
    }
  }

  /**
   * Update the ribbon icon and tooltip based on session state:
   * - lock-keyhole + "Set session password": no passwords stored
   * - rotate-ccw-key + "Lock all encrypted notes": session active
   */
  updateRibbonIcon(): void {
    if (!this.ribbonIconEl) return;
    const hasSession = this.plugin.sessionManager.hasEntries();
    const icon = hasSession ? "rotate-ccw-key" : "lock-keyhole";
    const tooltip = hasSession ? "Lock all encrypted notes" : "Set session password";
    this.ribbonIconEl.empty();
    setIcon(this.ribbonIconEl, icon);
    this.ribbonIconEl.setAttribute("aria-label", tooltip);
  }

  /** Find all leaves with an EncryptedMarkdownView (by instanceof, not view type). */
  private getEncryptedLeaves(): WorkspaceLeaf[] {
    const result: WorkspaceLeaf[] = [];
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof EncryptedMarkdownView) {
        result.push(leaf);
      }
    });
    return result;
  }
}
