/**
 * Advanced File Encryption settings tab.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type AFEPlugin from "./main";
import type { SessionMode } from "./services/session-manager";

const SESSION_MODE_DESCRIPTIONS: Record<SessionMode, { name: string; desc: string }> = {
  "session-password": {
    name: "Session password (recommended)",
    desc: "Your password is kept in memory for the session duration so you don't have to re-enter it for every file. It auto-expires after the configured timeout. Best balance of convenience and security.",
  },
  "timed-password": {
    name: "Timed password",
    desc: "Your password is briefly kept in memory after you enter it, allowing you to open multiple files quickly. After the timeout, it's discarded and you'll need to enter it again.",
  },
  "keys-only": {
    name: "Keys only",
    desc: "Only cryptographic keys are kept in memory \u2014 your password is discarded immediately after use. Most secure option, but you'll need to re-enter your password for each new file you open.",
  },
  "no-storage": {
    name: "No storage",
    desc: "Nothing is stored in memory. Every time you open or switch to an encrypted file, you must enter the password. Maximum security, least convenient.",
  },
};

export class AFESettingsTab extends PluginSettingTab {
  plugin: AFEPlugin;

  constructor(app: App, plugin: AFEPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Session Security Mode ---
    new Setting(containerEl).setHeading().setName("Session security");

    new Setting(containerEl)
      .setName("Security mode")
      .setDesc("Controls how your password and encryption keys are handled in memory.")
      .addDropdown((dropdown) => {
        for (const [key, value] of Object.entries(SESSION_MODE_DESCRIPTIONS)) {
          dropdown.addOption(key, value.name);
        }
        dropdown.setValue(this.plugin.settings.sessionMode);
        dropdown.onChange(async (value) => {
          this.plugin.settings.sessionMode = value as SessionMode;
          this.plugin.sessionManager.setMode(value as SessionMode);
          await this.plugin.saveSettings();
          this.display(); // Refresh to show/hide relevant options
        });
      });

    // Description for current mode
    const modeInfo = SESSION_MODE_DESCRIPTIONS[this.plugin.settings.sessionMode];
    const descEl = containerEl.createDiv("afe-mode-description");
    descEl.createEl("p", { text: modeInfo.desc, cls: "setting-item-description" });

    // Session timeout (only for session-password mode)
    if (this.plugin.settings.sessionMode === "session-password") {
      new Setting(containerEl)
        .setName("Session timeout")
        .setDesc("Minutes until the cached password expires. Set to 0 to keep until Obsidian closes.")
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.setValue(String(this.plugin.settings.sessionTimeout));
          text.onChange(async (value) => {
            const num = parseInt(value) || 0;
            this.plugin.settings.sessionTimeout = num;
            this.plugin.sessionManager.setSessionTimeout(num);
            await this.plugin.saveSettings();
          });
        });
    }

    // Timed window (only for timed-password mode)
    if (this.plugin.settings.sessionMode === "timed-password") {
      new Setting(containerEl)
        .setName("Password window")
        .setDesc("Seconds to keep the password after entry.")
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "5";
          text.setValue(String(this.plugin.settings.timedPasswordWindow));
          text.onChange(async (value) => {
            const num = parseInt(value) || 60;
            this.plugin.settings.timedPasswordWindow = num;
            this.plugin.sessionManager.setTimedWindow(num);
            await this.plugin.saveSettings();
          });
        });
    }

    // --- Encryption ---
    new Setting(containerEl).setHeading().setName("Encryption");

    new Setting(containerEl)
      .setName("Confirm password")
      .setDesc("Require password confirmation when creating or encrypting a note.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.confirmPassword);
        toggle.onChange(async (value) => {
          this.plugin.settings.confirmPassword = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Password hint")
      .setDesc("Show the password hint field when encrypting a note.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showPasswordHint);
        toggle.onChange(async (value) => {
          this.plugin.settings.showPasswordHint = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show password as cleartext")
      .setDesc("Always reveal passwords in the password modal by default. You can still toggle visibility per field.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showCleartextPassword);
        toggle.onChange(async (value) => {
          this.plugin.settings.showCleartextPassword = value;
          await this.plugin.saveSettings();
        });
      });

    // --- Integration ---
    const hasDailyNotes = (this.plugin.app as any).internalPlugins?.getPluginById?.("daily-notes")?.enabled;
    const hasManualSorting = !!(this.plugin.app as any).plugins?.plugins?.["manual-sorting"];
    const hasDailyNoteNavbar = !!(this.plugin.app as any).plugins?.plugins?.["daily-note-navbar"];

    if (hasDailyNotes || hasManualSorting || hasDailyNoteNavbar) {
      new Setting(containerEl).setHeading().setName("Integration");

      if (hasDailyNotes) {
        new Setting(containerEl)
          .setName("Auto-encrypt daily notes")
          .setDesc("Automatically encrypt new daily notes when they are created. Uses your session password if available, otherwise prompts you.")
          .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.autoEncryptDailyNotes);
            toggle.onChange(async (value) => {
              this.plugin.settings.autoEncryptDailyNotes = value;
              await this.plugin.saveSettings();
            });
          });
      }

      if (hasManualSorting) {
        new Setting(containerEl)
          .setName("Preserve file position")
          .setDesc("Keep the file in the same position in the file explorer when converting between .md and .locked. Requires the Manual Sorting plugin.")
          .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.manualSortIntegration);
            toggle.onChange(async (value) => {
              this.plugin.settings.manualSortIntegration = value;
              await this.plugin.saveSettings();
            });
          });
      }

      if (hasDailyNoteNavbar) {
        new Setting(containerEl)
          .setName("Daily Note Navbar")
          .setDesc("Allow the Daily Note Navbar plugin to recognize encrypted daily notes. Requires a reload to take effect.")
          .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.dailyNoteNavbarIntegration);
            toggle.onChange(async (value) => {
              this.plugin.settings.dailyNoteNavbarIntegration = value;
              await this.plugin.saveSettings();
            });
          });
      }
    }
  }
}
