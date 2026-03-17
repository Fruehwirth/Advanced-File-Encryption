/**
 * Advanced File Encryption — Transparent whole-note encryption for Obsidian.
 *
 * Notes are encrypted on disk (.locked files) but appear as normal markdown
 * in the editor. Keys and plaintext exist only in memory and are cleared
 * when Obsidian closes.
 *
 * Architecture:
 *   crypto/          — Standalone encryption package (extractable as @fruehwirth/afe-crypto)
 *   services/        — File format handling, session/key management
 *   views/           — Custom MarkdownView for .locked files
 *   features/        — Modular feature modules (whole-note, future: voice recorder, hardware key)
 *   ui/              — Modals and UI components
 */

import { Plugin, MarkdownView, TFile } from "obsidian";
import { AFESettings, DEFAULT_SETTINGS } from "./types";
import { SessionManager } from "./services/session-manager";
import {
  VIEW_TYPE_ENCRYPTED,
  EncryptedMarkdownView,
} from "./views/encrypted-markdown-view";
import { WholeNoteFeature } from "./features/whole-note/feature";
import { AFESettingsTab } from "./settings";
import { LOCKED_EXTENSION } from "./services/file-data";

export default class AFEPlugin extends Plugin {
  settings!: AFESettings;
  sessionManager!: SessionManager;
  private wholeNoteFeature!: WholeNoteFeature;

  /**
   * Temporary plaintext storage for notes being converted from .md to .locked
   * when no session password is available. The view's inline encrypt card
   * retrieves and clears this after the user enters a password.
   * Key: file path, Value: original plaintext
   */
  pendingPlaintext = new Map<string, string>();

  async onload(): Promise<void> {
    // Load settings
    await this.loadSettings();

    // Initialize session manager
    this.sessionManager = new SessionManager(
      this.settings.sessionMode,
      this.settings.sessionTimeout,
      this.settings.timedPasswordWindow
    );

    // Register the .locked file extension with our custom view
    this.registerView(VIEW_TYPE_ENCRYPTED, (leaf) => {
      return new EncryptedMarkdownView(leaf, this);
    });

    // Register .locked as a known extension
    this.registerExtensions([LOCKED_EXTENSION], VIEW_TYPE_ENCRYPTED);

    // Hide .locked suffix in rendered link display text (reading + live preview)
    this.registerMarkdownPostProcessor((el) => {
      for (const a of el.querySelectorAll<HTMLAnchorElement>("a.internal-link")) {
        const href = a.dataset.href ?? "";
        if (href.endsWith(".locked") && (a.textContent ?? "").endsWith(".locked")) {
          a.textContent = a.textContent!.slice(0, -".locked".length);
        }
      }
    });

    // Handle file renames — keep session manager in sync
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.sessionManager.handleRename(oldPath, file.path);
      })
    );

    // Safety net: if a .locked file somehow opens in a regular MarkdownView
    // (e.g. during startup race, plugin reload, or leftover workspace state),
    // swap it to our encrypted view.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async (leaf) => {
        if (!leaf) return;
        const view = leaf.view;
        if (
          view instanceof MarkdownView &&
          !(view instanceof EncryptedMarkdownView) &&
          view.file?.extension === LOCKED_EXTENSION
        ) {
          const state = leaf.getViewState();
          state.type = VIEW_TYPE_ENCRYPTED;
          await leaf.setViewState(state);
        }
      })
    );

    // On layout ready: recover orphaned tabs, fix misrouted views.
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const viewState = leaf.getViewState();

        // Recover orphaned "plugin has gone away" tabs for our view type.
        // These happen when the workspace was saved with our type but the
        // plugin wasn't loaded in time (e.g. quick reload, plugin error).
        if (
          viewState.type === VIEW_TYPE_ENCRYPTED &&
          !(leaf.view instanceof EncryptedMarkdownView)
        ) {
          leaf.setViewState(viewState);
          return;
        }

        // Fix .locked files stuck in a regular MarkdownView (migration
        // from old workspace state where getViewType returned "markdown").
        if (
          leaf.view instanceof MarkdownView &&
          !(leaf.view instanceof EncryptedMarkdownView) &&
          leaf.view.file?.extension === LOCKED_EXTENSION
        ) {
          viewState.type = VIEW_TYPE_ENCRYPTED;
          leaf.setViewState(viewState);
        }
      });

      // Register our view type with the editing-toolbar plugin
      this.registerWithEditingToolbar();
    });

    // Load features
    this.wholeNoteFeature = new WholeNoteFeature();
    await this.wholeNoteFeature.onload(this);

    // Settings tab
    this.addSettingTab(new AFESettingsTab(this.app, this));
  }

  onunload(): void {
    // Force-save all open encrypted views BEFORE clearing session.
    // Each view uses its own this.currentPassword (not session manager),
    // so saves still work. Fire-and-forget since onunload is synchronous.
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof EncryptedMarkdownView) {
        const view = leaf.view as EncryptedMarkdownView;
        if (view.isSavingEnabled && view.file) {
          view.save();
        }
      }
    });

    // Clear all sensitive data from memory
    this.sessionManager.clear();

    // Unload features
    this.wholeNoteFeature?.onunload();
  }

  /**
   * Register our view type with the editing-toolbar plugin so its
   * toolbar shows up in encrypted notes.
   */
  private registerWithEditingToolbar(): void {
    const toolbar = (this.app as any).plugins?.getPlugin?.("editing-toolbar");
    if (!toolbar?.settings) return;

    if (!toolbar.settings.viewTypeSettings) {
      toolbar.settings.viewTypeSettings = {};
    }

    if (toolbar.settings.viewTypeSettings[VIEW_TYPE_ENCRYPTED] === true) return;

    toolbar.settings.viewTypeSettings[VIEW_TYPE_ENCRYPTED] = true;
    toolbar.saveSettings?.();
    dispatchEvent(new Event("editingToolbar-NewCommand"));
  }

  /** Refresh the ribbon icon to reflect current session state. */
  refreshRibbonIcon(): void {
    this.wholeNoteFeature?.updateRibbonIcon();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
