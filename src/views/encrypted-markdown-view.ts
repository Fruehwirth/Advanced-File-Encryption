/**
 * EncryptedMarkdownView — The core of Advanced File Encryption.
 *
 * Extends Obsidian's MarkdownView so encrypted notes get the FULL editor:
 * syntax highlighting, preview mode, links, backlinks, tags, vim mode, etc.
 *
 * Save interception pattern (from Meld Encrypt):
 * - getViewData() returns plaintext normally, encrypted only during save
 * - save() sets isSavingInProgress, encrypts, calls super.save()
 * - setViewData() blocks during loading, decrypts vault sync data
 * - onLoadFile() hides view via setViewBusy, decrypts, calls
 *   super.onLoadFile() with isLoadingFile guard, sets plaintext
 *   via super.setViewData() AFTER initialization, then reveals view
 */

import {
  MarkdownView,
  WorkspaceLeaf,
  TFile,
  Notice,
  setIcon,
} from "obsidian";

import type AFEPlugin from "../main";
import { parse, encode, decode, isEncryptedFile, isPendingFile, needsMigration } from "../services/file-data";
import type { AFEFileData } from "../services/file-data";
import { deriveKeyFromData, decryptTextWithKey } from "../crypto/index";

export const VIEW_TYPE_ENCRYPTED = "advanced-file-encrypter-encrypted-view";

export class EncryptedMarkdownView extends MarkdownView {
  plugin: AFEPlugin;
  private fileData: AFEFileData | null = null;
  private currentPassword: string | null = null;
  private cachedPlaintext: string = "";
  private encryptedJsonForSave: string = "";
  isSavingEnabled: boolean = false;
  private isLoadingFile: boolean = false;
  private isSavingInProgress: boolean = false;

  /**
   * When getViewType() returns "markdown", Obsidian may reuse this leaf
   * for regular .md files (e.g. following a link). In that case, all our
   * encryption overrides become transparent pass-throughs to the parent
   * MarkdownView so the .md file works normally.
   */
  private _isPlaintextMode = false;

  constructor(leaf: WorkspaceLeaf, plugin: AFEPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
  }

  getViewType(): string {
    // Return "markdown" so Obsidian's sidebar panels (backlinks, outgoing
    // links, local graph, properties) stay visible for encrypted notes.
    // VIEW_TYPE_ENCRYPTED is still used for registerView/registerExtensions
    // (factory routing), but the *instance* identifies as "markdown".
    return "markdown";
  }

  getDisplayText(): string {
    if (this._isPlaintextMode) return super.getDisplayText();
    return this.file?.basename ?? "Encrypted note";
  }

  getIcon(): string {
    if (this._isPlaintextMode) return super.getIcon();
    return "file-lock";
  }

  canAcceptExtension(extension: string): boolean {
    // Accept both .locked (our primary) and .md (since getViewType
    // returns "markdown", Obsidian may route .md files here).
    return extension === "locked" || extension === "md";
  }

  // ── Data interception ────────────────────────────────────────────

  /**
   * Called by Obsidian's save pipeline to get data for disk.
   * During save: returns encrypted JSON.
   * Otherwise: returns plaintext from the editor (for preview, search, etc.)
   */
  getViewData(): string {
    if (this._isPlaintextMode) return super.getViewData();
    if (this.isSavingInProgress) {
      return this.encryptedJsonForSave;
    }
    return super.getViewData();
  }

  /**
   * Intercept data coming from Obsidian (vault sync, file re-read, etc.)
   * - During loading: block completely (we pre-set content before super.onLoadFile)
   * - If file is null: ignore
   * - If encrypted: update cache, decrypt, then pass plaintext to super
   * - If plaintext: pass through
   */
  setViewData(data: string, clear: boolean): void {
    if (this._isPlaintextMode) {
      super.setViewData(data, clear);
      return;
    }
    if (this.file == null) return;
    if (this.isLoadingFile) return;

    if (isEncryptedFile(data)) {
      // Always update the encrypted cache (vault sync, external edit)
      this.encryptedJsonForSave = data;
      if (!this.currentPassword) return;
      decode(data, this.currentPassword).then((plaintext) => {
        if (plaintext !== null) {
          this.cachedPlaintext = plaintext;
          try {
            this.fileData = parse(data);
          } catch {
            /* ignore */
          }
          super.setViewData(plaintext, false);
        }
      });
      return;
    }

    this.cachedPlaintext = data;
    super.setViewData(data, false);
  }

  clear(): void {
    // Do NOT reset _isPlaintextMode here — it is set by onLoadFile before
    // super.onLoadFile(), which calls clear() internally. Resetting it here
    // would break .md files loaded in this view (locked → md transitions).
    this.currentPassword = null;
    this.fileData = null;
    this.cachedPlaintext = "";
    this.encryptedJsonForSave = "";
    this.isSavingEnabled = false;
    this.isSavingInProgress = false;
    this.isLoadingFile = false;
  }

  // ── Save ─────────────────────────────────────────────────────────

  async save(clear?: boolean): Promise<void> {
    if (this._isPlaintextMode) return super.save(clear);
    if (this.isSavingInProgress) return;
    if (!this.file || !this.isSavingEnabled) return;

    const password =
      this.currentPassword ??
      this.plugin.sessionManager.getPassword(this.file.path);
    if (!password) return;

    this.isSavingInProgress = true;
    try {
      const plaintext = super.getViewData();

      // Safety: never double-encrypt
      if (isEncryptedFile(plaintext)) return;

      // Skip if unchanged
      if (plaintext === this.cachedPlaintext) return;

      this.cachedPlaintext = plaintext;
      const hint = this.fileData?.hint ?? "";

      const encryptedJson = await encode(plaintext, password, hint);
      this.encryptedJsonForSave = encryptedJson;

      try {
        this.fileData = parse(encryptedJson);
      } catch {
        /* ignore */
      }

      // super.save() → getViewData() → isSavingInProgress → encrypted
      await super.save(clear);
    } finally {
      this.isSavingInProgress = false;
    }
  }

  // ── File lifecycle ───────────────────────────────────────────────

  async onLoadFile(file: TFile): Promise<void> {
    // If this isn't a .locked file, Obsidian routed a regular .md file
    // to our view (because getViewType returns "markdown"). Handle it
    // as a normal MarkdownView with no encryption logic.
    if (file.extension !== "locked") {
      this._isPlaintextMode = true;
      return super.onLoadFile(file);
    }
    this._isPlaintextMode = false;

    this.isSavingEnabled = false;
    this.isSavingInProgress = false;
    this.currentPassword = null;

    // Hide the view during initialization to prevent encrypted JSON from
    // flashing. Uses Obsidian's internal setViewBusy (same as Meld Encrypt)
    // plus a CSS fallback for robustness.
    (this as any).setViewBusy?.(true);
    this.contentEl.style.visibility = "hidden";

    try {
      // Read file directly from vault
      const rawContent = await this.app.vault.read(file);
      if (!rawContent || !rawContent.trim()) {
        await this.initViewEmpty(file);
        this.showLockedState("Empty encrypted file.");
        return;
      }

      // Check for pending (uninitialized) encrypted note — needs initial password setup
      if (isPendingFile(rawContent)) {
        await this.initViewEmpty(file);
        this.showEncryptState();
        return;
      }

      // Parse metadata
      let fileData: AFEFileData;
      try {
        fileData = parse(rawContent);
      } catch {
        await this.initViewEmpty(file);
        this.showLockedState("Invalid encrypted file format.");
        return;
      }
      this.fileData = fileData;
      this.encryptedJsonForSave = rawContent;

      // Try cached password
      const sessionMgr = this.plugin.sessionManager;
      let password = sessionMgr.getPassword(file.path);
      let plaintext: string | null = null;

      if (password) {
        plaintext = await decode(rawContent, password);
        if (plaintext === null) password = null;
      }

      // Try cached key (keys-only mode)
      if (plaintext === null && sessionMgr.getMode() === "keys-only") {
        const key = sessionMgr.getKey(file.path);
        if (key) {
          plaintext = await decryptTextWithKey(
            fileData.data,
            key,
            fileData.encryption
          );
        }
      }

      // No cached password/key — show locked state instead of prompting.
      // The user clicks "Unlock" when ready. This avoids modal storms on
      // startup (workspace restoration, orphaned tab recovery, etc.).
      // After the first unlock, the session cache auto-decrypts other tabs.
      if (plaintext === null) {
        await this.initViewEmpty(file);
        this.showLockedState("Encrypted note.");
        return;
      }

      // Decryption successful
      this.currentPassword = password;
      this.cachedPlaintext = plaintext;
      this.encryptedJsonForSave = rawContent;

      // Let MarkdownView fully initialize (sets this.file, creates toolbar, etc.)
      // Our setViewData override blocks the encrypted content it reads from disk.
      this.isLoadingFile = true;
      try {
        await super.onLoadFile(file);
      } finally {
        this.isLoadingFile = false;
      }

      // Restore encryption state — clear() is called during super.onLoadFile
      // and wipes currentPassword, cachedPlaintext, etc. Without this,
      // subsequent setViewData calls (e.g. from link/metadata resolution)
      // silently drop encrypted data because currentPassword is null.
      this.currentPassword = password;
      this.cachedPlaintext = plaintext;
      this.encryptedJsonForSave = rawContent;
      this.fileData = fileData;

      // Set decrypted plaintext into the now-initialized editor.
      // Must be AFTER super.onLoadFile so the CM6 editor and toolbar
      // are fully created. Uses super.setViewData to properly update
      // MarkdownView's internal state pipeline.
      super.setViewData(plaintext, false);
      this.isSavingEnabled = true;

      // Auto-migrate legacy format files to current format
      await this.migrateIfNeeded();
    } catch (err) {
      // Defensive: if anything fails, show locked state instead of crashing.
      // This prevents the "plugin has gone away" error on workspace restore.
      console.error("Advanced File Encryption: failed to load encrypted file", file.path, err);
      try {
        await this.initViewEmpty(file);
        this.showLockedState("Failed to load. Click to retry.");
      } catch {
        // Last resort — at least don't crash the plugin
      }
    } finally {
      // Reveal the view — editor now has plaintext (or locked state overlay)
      this.contentEl.style.visibility = "";
      (this as any).setViewBusy?.(false);
    }
  }

  async onUnloadFile(file: TFile): Promise<void> {
    if (this._isPlaintextMode) {
      this._isPlaintextMode = false;
      return super.onUnloadFile(file);
    }

    // If a save is already in progress, reset the flag so the final
    // save triggered by super.onUnloadFile can go through.
    if (this.isSavingInProgress) {
      this.isSavingInProgress = false;
    }

    if (this.plugin.sessionManager.getMode() === "no-storage") {
      this.plugin.sessionManager.clearFile(file.path);
    }

    // Don't clear password/saving state BEFORE super.onUnloadFile —
    // it may trigger a final save that needs them.
    await super.onUnloadFile(file);

    this.currentPassword = null;
    this.fileData = null;
    this.isSavingEnabled = false;
  }

  async setState(state: any, result: any): Promise<void> {
    // When the file is changing (navigation), remove any overlay from the
    // previous file. Skip for mode-only changes (source↔preview) or state
    // restoration on the same file so we don't remove freshly added overlays.
    if (state.file && state.file !== this.file?.path) {
      this.contentEl.querySelectorAll(".afe-locked-state").forEach(el => el.remove());
    }

    if (this._isPlaintextMode) return super.setState(state, result);

    if (state.mode === "preview" && this.isSavingEnabled) {
      await this.save();
    }

    this.isSavingEnabled = false;
    const fileBefore = this.file?.path;
    try {
      await super.setState(state, result);
      // Only restore cached plaintext for mode changes (source↔preview)
      // on the SAME file. During file transitions, cachedPlaintext holds
      // the previous file's content and must not overwrite the new file.
      if (this.cachedPlaintext && this.file?.path === fileBefore) {
        super.setViewData(this.cachedPlaintext, false);
      }
    } finally {
      if (this.currentPassword) {
        this.isSavingEnabled = true;
      }
    }
  }

  // ── Actions ──────────────────────────────────────────────────────

  async lockAndClose(): Promise<void> {
    if (this.isSavingEnabled && this.file) {
      await this.save();
      this.plugin.sessionManager.clearFile(this.file.path);
    }
    this.currentPassword = null;
    this.isSavingEnabled = false;
    this.leaf.detach();
  }

  async changePassword(): Promise<void> {
    if (!this.file || !this.isSavingEnabled) return;
    this.showChangePasswordState();
  }

  /**
   * Show an inline "Change password" card overlaying the editor.
   * Cancel returns to the editor without changes.
   */
  private showChangePasswordState(): void {
    const container = this.contentEl;
    const overlay = container.createDiv("afe-locked-state");
    const card = overlay.createDiv("afe-unlock-card");

    // Header: icon + title
    const header = card.createDiv("afe-unlock-header");
    const headerIcon = header.createDiv("afe-unlock-header-icon");
    setIcon(headerIcon, "lock");
    header.createEl("span", { text: `Change password: ${this.file?.basename ?? "Encrypted note"}` });

    // New password field
    const fieldGroup = card.createDiv("afe-field-group");
    const labelRow = fieldGroup.createDiv("afe-unlock-label-row");
    labelRow.createEl("label", { text: "New password", cls: "afe-field-label" });
    const errorEl = labelRow.createSpan({ cls: "afe-unlock-inline-error" });
    errorEl.style.display = "none";
    const inputWrapper = fieldGroup.createDiv("afe-password-wrapper");
    const defaultType = this.plugin.settings.showCleartextPassword ? "text" : "password";
    const passwordInput = inputWrapper.createEl("input", {
      type: defaultType,
      placeholder: "Enter new password",
      cls: "afe-input afe-password-input",
    });
    const eyeToggle = inputWrapper.createDiv("afe-eye-toggle");
    setIcon(eyeToggle, defaultType === "password" ? "eye" : "eye-off");
    eyeToggle.setAttribute("aria-label", "Toggle password visibility");
    eyeToggle.addEventListener("click", () => {
      const isHidden = passwordInput.type === "password";
      passwordInput.type = isHidden ? "text" : "password";
      eyeToggle.empty();
      setIcon(eyeToggle, isHidden ? "eye-off" : "eye");
      // Sync confirm field visibility if it exists
      if (confirmInput) {
        confirmInput.type = passwordInput.type;
        confirmEyeToggle?.empty();
        if (confirmEyeToggle) setIcon(confirmEyeToggle, isHidden ? "eye-off" : "eye");
      }
    });

    // Confirm password field (conditional)
    let confirmInput: HTMLInputElement | null = null;
    let confirmEyeToggle: HTMLDivElement | null = null;
    if (this.plugin.settings.confirmPassword) {
      const confirmGroup = card.createDiv("afe-field-group");
      confirmGroup.createEl("label", { text: "Confirm password", cls: "afe-field-label" });
      const confirmWrapper = confirmGroup.createDiv("afe-password-wrapper");
      confirmInput = confirmWrapper.createEl("input", {
        type: defaultType,
        placeholder: "Confirm password",
        cls: "afe-input afe-password-input",
      });
      confirmEyeToggle = confirmWrapper.createDiv("afe-eye-toggle");
      setIcon(confirmEyeToggle, defaultType === "password" ? "eye" : "eye-off");
      confirmEyeToggle.setAttribute("aria-label", "Toggle password visibility");
      confirmEyeToggle.addEventListener("click", () => {
        if (!confirmInput || !confirmEyeToggle) return;
        const isHidden = confirmInput.type === "password";
        confirmInput.type = isHidden ? "text" : "password";
        confirmEyeToggle.empty();
        setIcon(confirmEyeToggle, isHidden ? "eye-off" : "eye");
      });
      confirmInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doChange(); }
      });
      confirmInput.addEventListener("input", () => {
        errorEl.style.display = "none";
        passwordInput.removeClass("afe-input-error");
        confirmInput?.removeClass("afe-input-error");
      });
    }

    // Hint field (conditional)
    let hintInput: HTMLInputElement | null = null;
    if (this.plugin.settings.showPasswordHint) {
      const hintGroup = card.createDiv("afe-field-group");
      hintGroup.createEl("label", { text: "Password hint", cls: "afe-field-label" });
      hintInput = hintGroup.createEl("input", {
        type: "text",
        placeholder: "Optional \u2014 stored unencrypted",
        cls: "afe-input",
      });
      hintInput.value = this.fileData?.hint ?? "";
      hintInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doChange(); }
      });
    }

    // Buttons row
    const btnRow = card.createDiv("afe-change-pw-buttons");

    const submitBtn = btnRow.createEl("button", {
      text: "Change password",
      cls: "mod-cta afe-unlock-btn",
    });

    const cancelBtn = btnRow.createEl("button", {
      text: "Cancel",
      cls: "afe-unlock-btn",
    });

    // Focus the password input after the view is revealed
    setTimeout(() => passwordInput.focus(), 100);

    // Submit handler
    const doChange = async () => {
      if (!this.file) return;

      const newPassword = passwordInput.value;
      if (!newPassword) {
        errorEl.textContent = "Password cannot be empty.";
        errorEl.style.display = "";
        passwordInput.addClass("afe-input-error");
        passwordInput.focus();
        return;
      }

      // Check confirm
      if (confirmInput && newPassword !== confirmInput.value) {
        errorEl.textContent = "Passwords do not match.";
        errorEl.style.display = "";
        confirmInput.addClass("afe-input-error");
        confirmInput.focus();
        return;
      }

      const hint = hintInput?.value ?? "";

      // Disable UI
      submitBtn.disabled = true;
      submitBtn.textContent = "Changing...";
      cancelBtn.disabled = true;
      passwordInput.disabled = true;
      if (confirmInput) confirmInput.disabled = true;
      if (hintInput) hintInput.disabled = true;
      errorEl.style.display = "none";
      passwordInput.removeClass("afe-input-error");
      confirmInput?.removeClass("afe-input-error");

      try {
        this.currentPassword = newPassword;
        if (this.fileData) {
          this.fileData.hint = hint;
        }

        this.plugin.sessionManager.put(this.file.path, newPassword, hint);

        // Force re-encrypt by clearing cached plaintext
        this.cachedPlaintext = "";
        await this.save();

        overlay.remove();
        new Notice("Password changed successfully.");
      } catch {
        errorEl.textContent = "Failed to change password.";
        errorEl.style.display = "";
        submitBtn.disabled = false;
        submitBtn.textContent = "Change password";
        cancelBtn.disabled = false;
        passwordInput.disabled = false;
        if (confirmInput) confirmInput.disabled = false;
        if (hintInput) hintInput.disabled = false;
      }
    };

    // Cancel handler — just remove overlay
    cancelBtn.addEventListener("click", () => overlay.remove());

    submitBtn.addEventListener("click", doChange);
    passwordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doChange(); }
    });
    passwordInput.addEventListener("input", () => {
      errorEl.style.display = "none";
      passwordInput.removeClass("afe-input-error");
    });
  }

  /**
   * Auto-migrate legacy format files (v1) to current format (v2).
   * Called after successful decryption when isSavingEnabled is true.
   * Silently re-encodes with the current password and writes back to disk.
   */
  private async migrateIfNeeded(): Promise<void> {
    if (!this.file || !this.fileData || !this.currentPassword) return;
    if (!needsMigration(this.fileData)) return;

    try {
      const plaintext = this.cachedPlaintext;
      const hint = this.fileData.hint ?? "";
      const newJson = await encode(plaintext, this.currentPassword, hint);

      // Write migrated format back to disk
      await this.app.vault.modify(this.file, newJson);

      // Update internal state with new format
      this.encryptedJsonForSave = newJson;
      this.fileData = parse(newJson);
    } catch (err) {
      // Migration failed — don't break the user experience, just log it
      console.error("Advanced File Encryption: failed to migrate file format", this.file.path, err);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async initViewEmpty(file: TFile): Promise<void> {
    this.isLoadingFile = true;
    try {
      await super.onLoadFile(file);
    } finally {
      this.isLoadingFile = false;
    }
    super.setViewData("", false);
  }

  private showLockedState(message: string): void {
    const container = this.contentEl;
    const overlay = container.createDiv("afe-locked-state");

    // If no fileData (empty file, invalid format), show simple message only
    if (!this.fileData) {
      const iconEl = overlay.createDiv("afe-lock-icon");
      setIcon(iconEl, "lock");
      overlay.createEl("p", { text: message });
      return;
    }

    // ── Inline unlock form ──────────────────────────────────────────
    const card = overlay.createDiv("afe-unlock-card");

    // Header: icon + title
    const header = card.createDiv("afe-unlock-header");
    const headerIcon = header.createDiv("afe-unlock-header-icon");
    setIcon(headerIcon, "lock");
    header.createEl("span", { text: `Unlock note: ${this.file?.basename ?? "Encrypted note"}` });

    // Hint display
    const hint = this.fileData.hint;
    if (hint) {
      const hintEl = card.createDiv("afe-unlock-hint");
      hintEl.createSpan({ text: "Hint: ", cls: "afe-unlock-hint-label" });
      hintEl.createSpan({ text: hint, cls: "afe-unlock-hint-text" });
    }

    // Password field with eye toggle
    const fieldGroup = card.createDiv("afe-field-group");
    const labelRow = fieldGroup.createDiv("afe-unlock-label-row");
    labelRow.createEl("label", { text: "Password", cls: "afe-field-label" });
    const errorEl = labelRow.createSpan({ cls: "afe-unlock-inline-error" });
    errorEl.style.display = "none";
    const inputWrapper = fieldGroup.createDiv("afe-password-wrapper");
    const defaultType = this.plugin.settings.showCleartextPassword ? "text" : "password";
    const passwordInput = inputWrapper.createEl("input", {
      type: defaultType,
      placeholder: "Enter password",
      cls: "afe-input afe-password-input",
    });
    const eyeToggle = inputWrapper.createDiv("afe-eye-toggle");
    setIcon(eyeToggle, defaultType === "password" ? "eye" : "eye-off");
    eyeToggle.setAttribute("aria-label", "Toggle password visibility");
    eyeToggle.addEventListener("click", () => {
      const isHidden = passwordInput.type === "password";
      passwordInput.type = isHidden ? "text" : "password";
      eyeToggle.empty();
      setIcon(eyeToggle, isHidden ? "eye-off" : "eye");
    });

    // Unlock button
    const btn = card.createEl("button", {
      text: "Unlock",
      cls: "mod-cta afe-unlock-btn",
    });

    // Focus the password input after the view is revealed
    setTimeout(() => passwordInput.focus(), 100);

    // Submit handler
    const doUnlock = async () => {
      if (!this.file) return;

      const enteredPassword = passwordInput.value;
      if (!enteredPassword) {
        errorEl.textContent = "Password cannot be empty.";
        errorEl.style.display = "";
        passwordInput.addClass("afe-input-error");
        passwordInput.focus();
        return;
      }

      // Disable UI while decrypting
      btn.disabled = true;
      btn.textContent = "Decrypting...";
      passwordInput.disabled = true;
      errorEl.style.display = "none";
      passwordInput.removeClass("afe-input-error");

      try {
        const raw = await this.app.vault.read(this.file);
        let fileData: AFEFileData;
        try {
          fileData = parse(raw);
        } catch {
          errorEl.textContent = "Invalid file format.";
          errorEl.style.display = "";
          passwordInput.addClass("afe-input-error");
          btn.disabled = false;
          btn.textContent = "Unlock";
          passwordInput.disabled = false;
          return;
        }
        this.fileData = fileData;

        const plaintext = await decode(raw, enteredPassword);
        if (plaintext === null) {
          errorEl.textContent = "Incorrect password";
          errorEl.style.display = "";
          passwordInput.addClass("afe-input-error");
          btn.disabled = false;
          btn.textContent = "Unlock";
          passwordInput.disabled = false;
          passwordInput.value = "";
          passwordInput.focus();
          return;
        }

        // Success — cache in session
        const sessionMgr = this.plugin.sessionManager;
        if (sessionMgr.getMode() === "keys-only") {
          const key = await deriveKeyFromData(
            fileData.data,
            enteredPassword,
            fileData.encryption,
            false
          );
          if (key) {
            sessionMgr.put(
              this.file.path,
              enteredPassword,
              fileData.hint ?? "",
              key
            );
          }
        } else {
          sessionMgr.put(
            this.file.path,
            enteredPassword,
            fileData.hint ?? ""
          );
        }

        this.currentPassword = enteredPassword;
        this.cachedPlaintext = plaintext;
        this.encryptedJsonForSave = raw;

        overlay.remove();
        super.setViewData(plaintext, false);
        this.isSavingEnabled = true;

        // Auto-migrate legacy format files to current format
        await this.migrateIfNeeded();
      } catch {
        errorEl.textContent = "Failed to decrypt";
        errorEl.style.display = "";
        passwordInput.addClass("afe-input-error");
        btn.disabled = false;
        btn.textContent = "Unlock";
        passwordInput.disabled = false;
      }
    };

    btn.addEventListener("click", doUnlock);
    passwordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doUnlock();
      }
    });
    passwordInput.addEventListener("input", () => {
      errorEl.style.display = "none";
      passwordInput.removeClass("afe-input-error");
    });
  }

  /**
   * Show an inline "Set password" card for newly created encrypted notes.
   * This mirrors showLockedState() but for the initial encryption setup.
   * The user enters a password (+ optional confirm + hint), and the note
   * is encrypted and saved with that password.
   */
  private showEncryptState(): void {
    const container = this.contentEl;
    const overlay = container.createDiv("afe-locked-state");
    const card = overlay.createDiv("afe-unlock-card");

    // Header: icon + title
    const header = card.createDiv("afe-unlock-header");
    const headerIcon = header.createDiv("afe-unlock-header-icon");
    setIcon(headerIcon, "lock");
    header.createEl("span", { text: `Set up encryption: ${this.file?.basename ?? "New note"}` });

    // Password field
    const fieldGroup = card.createDiv("afe-field-group");
    const labelRow = fieldGroup.createDiv("afe-unlock-label-row");
    labelRow.createEl("label", { text: "Password", cls: "afe-field-label" });
    const errorEl = labelRow.createSpan({ cls: "afe-unlock-inline-error" });
    errorEl.style.display = "none";
    const inputWrapper = fieldGroup.createDiv("afe-password-wrapper");
    const defaultType = this.plugin.settings.showCleartextPassword ? "text" : "password";
    const passwordInput = inputWrapper.createEl("input", {
      type: defaultType,
      placeholder: "Enter password",
      cls: "afe-input afe-password-input",
    });
    const eyeToggle = inputWrapper.createDiv("afe-eye-toggle");
    setIcon(eyeToggle, defaultType === "password" ? "eye" : "eye-off");
    eyeToggle.setAttribute("aria-label", "Toggle password visibility");
    eyeToggle.addEventListener("click", () => {
      const isHidden = passwordInput.type === "password";
      passwordInput.type = isHidden ? "text" : "password";
      eyeToggle.empty();
      setIcon(eyeToggle, isHidden ? "eye-off" : "eye");
      // Sync confirm field visibility if it exists
      if (confirmInput) {
        confirmInput.type = passwordInput.type;
        confirmEyeToggle?.empty();
        if (confirmEyeToggle) setIcon(confirmEyeToggle, isHidden ? "eye-off" : "eye");
      }
    });

    // Confirm password field (conditional)
    let confirmInput: HTMLInputElement | null = null;
    let confirmEyeToggle: HTMLDivElement | null = null;
    if (this.plugin.settings.confirmPassword) {
      const confirmGroup = card.createDiv("afe-field-group");
      confirmGroup.createEl("label", { text: "Confirm password", cls: "afe-field-label" });
      const confirmWrapper = confirmGroup.createDiv("afe-password-wrapper");
      confirmInput = confirmWrapper.createEl("input", {
        type: defaultType,
        placeholder: "Confirm password",
        cls: "afe-input afe-password-input",
      });
      confirmEyeToggle = confirmWrapper.createDiv("afe-eye-toggle");
      setIcon(confirmEyeToggle, defaultType === "password" ? "eye" : "eye-off");
      confirmEyeToggle.setAttribute("aria-label", "Toggle password visibility");
      confirmEyeToggle.addEventListener("click", () => {
        if (!confirmInput || !confirmEyeToggle) return;
        const isHidden = confirmInput.type === "password";
        confirmInput.type = isHidden ? "text" : "password";
        confirmEyeToggle.empty();
        setIcon(confirmEyeToggle, isHidden ? "eye-off" : "eye");
      });
      confirmInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doEncrypt(); }
      });
      confirmInput.addEventListener("input", () => {
        errorEl.style.display = "none";
        passwordInput.removeClass("afe-input-error");
        confirmInput?.removeClass("afe-input-error");
      });
    }

    // Hint field (conditional)
    let hintInput: HTMLInputElement | null = null;
    if (this.plugin.settings.showPasswordHint) {
      const hintGroup = card.createDiv("afe-field-group");
      hintGroup.createEl("label", { text: "Password hint", cls: "afe-field-label" });
      hintInput = hintGroup.createEl("input", {
        type: "text",
        placeholder: "Optional \u2014 stored unencrypted",
        cls: "afe-input",
      });
      hintInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doEncrypt(); }
      });
    }

    // Encrypt button
    const btn = card.createEl("button", {
      text: "Encrypt",
      cls: "mod-cta afe-unlock-btn",
    });

    // Focus the password input after the view is revealed
    setTimeout(() => passwordInput.focus(), 100);

    // Submit handler
    const doEncrypt = async () => {
      if (!this.file) return;

      const enteredPassword = passwordInput.value;
      if (!enteredPassword) {
        errorEl.textContent = "Password cannot be empty.";
        errorEl.style.display = "";
        passwordInput.addClass("afe-input-error");
        passwordInput.focus();
        return;
      }

      // Check confirm password
      if (confirmInput && enteredPassword !== confirmInput.value) {
        errorEl.textContent = "Passwords do not match.";
        errorEl.style.display = "";
        confirmInput.addClass("afe-input-error");
        confirmInput.focus();
        return;
      }

      const hint = hintInput?.value ?? "";

      // Disable UI while encrypting
      btn.disabled = true;
      btn.textContent = "Encrypting...";
      passwordInput.disabled = true;
      if (confirmInput) confirmInput.disabled = true;
      if (hintInput) hintInput.disabled = true;
      errorEl.style.display = "none";
      passwordInput.removeClass("afe-input-error");
      confirmInput?.removeClass("afe-input-error");

      try {
        // Retrieve pending plaintext if this note was converted from .md,
        // otherwise encrypt empty content for a brand new note.
        const pendingPlaintext = this.plugin.pendingPlaintext.get(this.file.path) ?? "";
        this.plugin.pendingPlaintext.delete(this.file.path);

        const encryptedJson = await encode(pendingPlaintext, enteredPassword, hint);

        // Write to disk
        await this.app.vault.modify(this.file, encryptedJson);

        // Set up internal state
        this.fileData = parse(encryptedJson);
        this.currentPassword = enteredPassword;
        this.cachedPlaintext = pendingPlaintext;
        this.encryptedJsonForSave = encryptedJson;

        // Cache in session manager
        const sessionMgr = this.plugin.sessionManager;
        if (sessionMgr.getMode() === "keys-only") {
          const key = await deriveKeyFromData(
            this.fileData.data,
            enteredPassword,
            this.fileData.encryption,
            false
          );
          if (key) {
            sessionMgr.put(this.file.path, enteredPassword, hint, key);
          }
        } else {
          sessionMgr.put(this.file.path, enteredPassword, hint);
        }

        // Remove overlay and enable editing
        overlay.remove();
        super.setViewData(pendingPlaintext, false);
        this.isSavingEnabled = true;

        new Notice(`Encrypted: ${this.file.basename}`);
      } catch {
        errorEl.textContent = "Failed to encrypt.";
        errorEl.style.display = "";
        btn.disabled = false;
        btn.textContent = "Encrypt";
        passwordInput.disabled = false;
        if (confirmInput) confirmInput.disabled = false;
        if (hintInput) hintInput.disabled = false;
      }
    };

    btn.addEventListener("click", doEncrypt);
    passwordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doEncrypt();
      }
    });
    passwordInput.addEventListener("input", () => {
      errorEl.style.display = "none";
      passwordInput.removeClass("afe-input-error");
    });
  }
}
