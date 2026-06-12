// popup.js - Action Popup logic for SessionMigrator

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("testCaptureBtn");
  const refreshBtn = document.getElementById("refreshUsageBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const statusDiv = document.getElementById("status");
  const profilesListDiv = document.getElementById("profilesList");

  // Load and render profiles on startup
  renderProfiles();

  // Settings page click handler
  settingsBtn.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  });

  // Refresh active profile usage stats
  refreshBtn.addEventListener("click", () => {
    statusDiv.textContent = "Refreshing active profile usage...";
    refreshBtn.disabled = true;

    chrome.runtime.sendMessage({ action: "refreshUsage" }, (response) => {
      refreshBtn.disabled = false;
      if (chrome.runtime.lastError) {
        statusDiv.innerHTML = `<span style="color: var(--danger-color);">Error: ${chrome.runtime.lastError.message}</span>`;
        return;
      }

      if (response && response.success) {
        const data = response.data;
        statusDiv.innerHTML = `<span style="color: var(--success-color);">Refreshed: ${data.utilization}% Used</span>`;
        renderProfiles();
      } else {
        statusDiv.innerHTML = `<span style="color: var(--danger-color);">Refresh failed. Make sure you are logged in to Claude on the active profile.</span>`;
      }
    });
  });

  // Capture event listener
  btn.addEventListener("click", () => {
    statusDiv.textContent = "Opening incognito window to capture session...";
    btn.disabled = true;

    chrome.runtime.sendMessage({ action: "startCapture" }, (response) => {
      btn.disabled = false;
      
      if (chrome.runtime.lastError) {
        statusDiv.innerHTML = `<span style="color: var(--danger-color);">Error: ${chrome.runtime.lastError.message}</span>`;
        return;
      }

      if (response && response.success) {
        const cookies = response.cookies;
        const defaultName = `Profile ${Math.floor(Math.random() * 1000)}`;
        const labelName = prompt("Enter a label for this account profile:", defaultName);

        if (!labelName || !labelName.trim()) {
          statusDiv.innerHTML = `<span style="color: var(--warning-color);">Capture cancelled (no name given).</span>`;
          return;
        }

        // Save the profile using background action
        chrome.runtime.sendMessage({ action: "saveProfile", label: labelName.trim(), cookies }, (saveRes) => {
          if (saveRes && saveRes.success) {
            statusDiv.innerHTML = `<span style="color: var(--success-color);">Profile "${labelName.trim()}" saved!</span>`;
            renderProfiles();
          } else {
            statusDiv.innerHTML = `<span style="color: var(--danger-color);">Failed to save profile.</span>`;
          }
        });
      } else {
        const errMsg = response ? response.error : "Unknown response error";
        if (errMsg === "INCOGNITO_NOT_ALLOWED") {
          statusDiv.innerHTML = `<span style="color: var(--danger-color); font-weight: bold;">Error: Incognito Access not enabled!</span><br>
            Please check <b>"Allow in incognito"</b> in details for this extension under <i>chrome://extensions</i>.`;
        } else {
          statusDiv.innerHTML = `<span style="color: var(--danger-color);">Failed: ${errMsg}</span>`;
        }
      }
    });
  });

  // Render profiles list from storage
  function renderProfiles() {
    chrome.storage.local.get({ profiles: [], activeProfile: null }, (data) => {
      profilesListDiv.innerHTML = "";
      const { profiles, activeProfile } = data;

      if (profiles.length === 0) {
        profilesListDiv.innerHTML = `<div class="empty-state">No saved profiles. Click "Add Profile" to capture a login.</div>`;
        return;
      }

      // Sort profiles so the active one is always at the top
      const sortedProfiles = [...profiles].sort((a, b) => {
        if (a.label === activeProfile) return -1;
        if (b.label === activeProfile) return 1;
        return a.label.localeCompare(b.label);
      });

      sortedProfiles.forEach((profile) => {
        const isActive = activeProfile === profile.label;
        
        const card = document.createElement("div");
        card.className = `profile-card${isActive ? ' active' : ''}`;

        const usageVal = typeof profile.lastKnownUsage === 'number' ? profile.lastKnownUsage : 0;
        
        // Pick usage bar color dynamically
        let barColor = "var(--success-color)";
        if (usageVal >= 80) {
          barColor = "var(--danger-color)";
        } else if (usageVal >= 50) {
          barColor = "var(--warning-color)";
        }

        // Parse reset timer
        let resetsText = '';
        if (profile.resetsAt) {
          const resetsDate = new Date(profile.resetsAt);
          const msLeft = resetsDate.getTime() - Date.now();
          if (msLeft > 0) {
            const minsLeft = Math.ceil(msLeft / 60000);
            const hours = Math.floor(minsLeft / 60);
            const mins = minsLeft % 60;
            resetsText = `Resets in ${hours > 0 ? hours + 'h ' : ''}${mins}m`;
          } else {
            resetsText = 'Quota resets now';
          }
        } else {
          resetsText = 'No active reset timer';
        }

        card.innerHTML = `
          <div class="profile-header">
            <div class="profile-title-container">
              <span class="profile-name" title="Double click to rename">${escapeHtml(profile.label)}</span>
              ${isActive ? '<span class="badge-active">Active</span>' : ''}
            </div>
            <div class="profile-actions">
              ${!isActive ? `<button class="action-btn switch-btn" data-label="${escapeHtml(profile.label)}">Use</button>` : ''}
              <button class="action-btn action-btn-danger delete-btn" data-label="${escapeHtml(profile.label)}">Delete</button>
            </div>
          </div>
          <div class="quota-info">
            <div class="quota-meta">
              <span>Usage Stats</span>
              <span class="quota-value">${usageVal}% Used</span>
            </div>
            <div class="quota-bar-container">
              <div class="quota-bar" style="width: ${usageVal}%; background-color: ${barColor};"></div>
            </div>
            <div class="quota-meta" style="margin-top: 2px;">
              <span style="font-size: 10px; color: var(--text-secondary);">${resetsText}</span>
            </div>
          </div>
        `;

        // Inline double-click rename functionality
        const nameSpan = card.querySelector(".profile-name");
        nameSpan.addEventListener("dblclick", () => {
          const currentLabel = profile.label;
          const newLabel = prompt(`Rename profile "${currentLabel}" to:`, currentLabel);
          if (newLabel && newLabel.trim() && newLabel.trim() !== currentLabel) {
            const trimmed = newLabel.trim();
            chrome.runtime.sendMessage({ action: "renameProfile", oldLabel: currentLabel, newLabel: trimmed }, (res) => {
              if (res && res.success) {
                statusDiv.innerHTML = `<span style="color: var(--success-color);">Profile renamed to "${trimmed}"</span>`;
                renderProfiles();
              }
            });
          }
        });

        // Bind switch handler
        if (!isActive) {
          card.querySelector(".switch-btn").addEventListener("click", () => {
            statusDiv.textContent = `Switching to "${profile.label}"...`;
            chrome.runtime.sendMessage({ action: "switchProfile", label: profile.label, cookies: profile.cookies }, (res) => {
              if (res && res.success) {
                statusDiv.innerHTML = `<span style="color: var(--success-color);">Switched to "${profile.label}"</span>`;
                renderProfiles();
              } else {
                statusDiv.innerHTML = `<span style="color: var(--danger-color);">Failed to switch profile.</span>`;
              }
            });
          });
        }

        // Bind delete handler
        card.querySelector(".delete-btn").addEventListener("click", () => {
          if (!confirm(`Delete profile "${profile.label}"?`)) return;
          chrome.runtime.sendMessage({ action: "deleteProfile", label: profile.label }, (res) => {
            if (res && res.success) {
              statusDiv.innerHTML = `<span>Deleted profile.</span>`;
              renderProfiles();
            }
          });
        });

        profilesListDiv.appendChild(card);
      });
    });
  }

  // HTML escaping utility
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
});
