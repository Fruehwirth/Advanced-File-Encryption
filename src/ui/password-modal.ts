/**
 * Password modal for encrypt/decrypt operations.
 *
 * Encrypt mode: password + confirm + optional hint
 * Decrypt mode: password only (hint shown as read-only)
 */

import { App, Modal, setIcon } from "obsidian";

export interface PasswordResult {
  password: string;
  hint: string;
}

export class PasswordModal extends Modal {
  private mode: "encrypt" | "decrypt";
  private hint: string;
  private confirmRequired: boolean;
  private showHint: boolean;
  private showCleartext: boolean;
  private heading: string;
  private resolvePromise: ((result: PasswordResult | null) => void) | null = null;

  private passwordEl: HTMLInputElement | null = null;
  private confirmEl: HTMLInputElement | null = null;
  private hintEl: HTMLInputElement | null = null;
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    mode: "encrypt" | "decrypt",
    hint: string = "",
    confirmRequired: boolean = true,
    showHint: boolean = true,
    showCleartext: boolean = false,
    heading?: string
  ) {
    super(app);
    this.mode = mode;
    this.hint = hint;
    this.confirmRequired = confirmRequired;
    this.showHint = showHint;
    this.showCleartext = showCleartext;
    this.heading = heading ?? (mode === "encrypt" ? "Encrypt note" : "Decrypt note");
  }

  /**
   * Open the modal and return a promise that resolves with the password/hint
   * or null if the user cancels.
   */
  static prompt(
    app: App,
    mode: "encrypt" | "decrypt",
    hint: string = "",
    confirmRequired: boolean = true,
    showHint: boolean = true,
    showCleartext: boolean = false,
    heading?: string
  ): Promise<PasswordResult | null> {
    return new Promise((resolve) => {
      const modal = new PasswordModal(app, mode, hint, confirmRequired, showHint, showCleartext, heading);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("afe-password-modal");

    // Title
    const title = contentEl.createDiv("afe-modal-title");
    const iconEl = title.createSpan("afe-modal-icon");
    setIcon(iconEl, this.mode === "encrypt" ? "lock" : "unlock");
    title.createSpan({ text: this.heading });

    // Hint display in decrypt mode
    if (this.mode === "decrypt" && this.hint) {
      const hintContainer = contentEl.createDiv("afe-hint-display");
      hintContainer.createSpan({ text: "Hint: ", cls: "afe-hint-label" });
      hintContainer.createSpan({ text: this.hint, cls: "afe-hint-text" });
    }

    // Error display
    this.errorEl = contentEl.createDiv("afe-error");
    this.errorEl.style.display = "none";

    // Password field
    const defaultType = this.showCleartext ? "text" : "password";
    this.passwordEl = this.createPasswordField(contentEl, "Password", "Enter password", defaultType);
    setTimeout(() => this.passwordEl?.focus(), 50);

    // Confirm field (encrypt mode only)
    if (this.mode === "encrypt" && this.confirmRequired) {
      this.confirmEl = this.createPasswordField(contentEl, "Confirm password", "Confirm password", defaultType);
    }

    // Hint field (encrypt mode only, when enabled)
    if (this.mode === "encrypt" && this.showHint) {
      const group = contentEl.createDiv("afe-field-group");
      group.createEl("label", { text: "Password hint", cls: "afe-field-label" });
      this.hintEl = group.createEl("input", {
        type: "text",
        placeholder: "Optional — stored unencrypted",
        cls: "afe-input",
      });
      this.hintEl.value = this.hint;
      this.hintEl.addEventListener("keydown", (e) => this.handleKeydown(e));
    }

    // Buttons
    const buttons = contentEl.createDiv("afe-modal-buttons");

    const submitBtn = buttons.createEl("button", {
      text: this.mode === "encrypt" ? "Encrypt" : "Decrypt",
      cls: "mod-cta",
    });
    submitBtn.addEventListener("click", () => this.submit());

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.cancel());
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }

  private createPasswordField(
    parent: HTMLElement,
    label: string,
    placeholder: string,
    defaultType: string
  ): HTMLInputElement {
    const group = parent.createDiv("afe-field-group");
    group.createEl("label", { text: label, cls: "afe-field-label" });

    const inputWrapper = group.createDiv("afe-password-wrapper");
    const input = inputWrapper.createEl("input", {
      type: defaultType,
      placeholder,
      cls: "afe-input afe-password-input",
    });

    const toggle = inputWrapper.createEl("button", { cls: "afe-eye-toggle", type: "button" });
    setIcon(toggle, defaultType === "password" ? "eye" : "eye-off");
    toggle.setAttribute("aria-label", "Toggle password visibility");
    toggle.addEventListener("click", () => {
      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      toggle.empty();
      setIcon(toggle, isHidden ? "eye-off" : "eye");
    });

    input.addEventListener("keydown", (e) => this.handleKeydown(e));
    return input;
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this.submit();
    }
  }

  private submit(): void {
    const password = this.passwordEl?.value ?? "";

    if (!password) {
      this.showError("Password cannot be empty.");
      return;
    }

    if (this.mode === "encrypt" && this.confirmRequired && this.confirmEl) {
      if (password !== this.confirmEl.value) {
        this.showError("Passwords do not match.");
        return;
      }
    }

    const hint = this.hintEl?.value ?? this.hint;

    if (this.resolvePromise) {
      this.resolvePromise({ password, hint });
      this.resolvePromise = null;
    }
    this.close();
  }

  private cancel(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
    this.close();
  }

  private showError(message: string): void {
    if (this.errorEl) {
      this.errorEl.textContent = message;
      this.errorEl.style.display = "block";
    }
  }
}
