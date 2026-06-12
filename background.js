// background.js - Service Worker for Claude Session Migrator

console.log("[Background] Service worker loaded.");

// On Installed/Updated Event
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Background] Extension installed or updated: ${details.reason}`);
});

// Runtime message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Message received:", message);

  if (message.action === "ping") {
    sendResponse({ status: "ok", message: "pong from background service worker" });
    return true;
  }

  if (message.action === "startCapture") {
    // Check if allowed incognito access first
    chrome.extension.isAllowedIncognitoAccess((allowed) => {
      if (!allowed) {
        console.error("[Background] Incognito access not allowed by user.");
        sendResponse({ success: false, error: "INCOGNITO_NOT_ALLOWED" });
        return;
      }

      console.log("[Background] Incognito access allowed. Spawning capture window...");
      startCapture()
        .then((result) => {
          sendResponse({ success: true, cookies: result.cookies });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message || String(err) });
        });
    });
    return true; // Keep channel open for async response
  }

  if (message.action === "switchProfile") {
    console.log("[Background] Received switchProfile request for:", message.label);
    switchProfile(message.label, message.cookies)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("[Background] Profile switch failed:", err.message);
        sendResponse({ success: false, error: err.message || String(err) });
      });
    return true; // Keep channel open for async response
  }

  if (message.action === "saveProfile") {
    chrome.storage.local.get({ profiles: [] }, (data) => {
      const profiles = data.profiles;
      const filtered = profiles.filter((p) => p.label !== message.label);
      filtered.push({
        label: message.label,
        cookies: message.cookies,
        lastKnownUsage: 0,
        resetsAt: null,
        lastUpdated: Date.now()
      });
      chrome.storage.local.set({ profiles: filtered }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.action === "deleteProfile") {
    chrome.storage.local.get({ profiles: [], activeProfile: null }, (data) => {
      const filtered = data.profiles.filter((p) => p.label !== message.label);
      const updates = { profiles: filtered };
      if (data.activeProfile === message.label) {
        updates.activeProfile = null;
      }
      chrome.storage.local.set(updates, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.action === "renameProfile") {
    chrome.storage.local.get({ profiles: [], activeProfile: null }, (data) => {
      const profiles = data.profiles;
      const profile = profiles.find((p) => p.label === message.oldLabel);
      if (profile) {
        profile.label = message.newLabel;
      }
      const updates = { profiles };
      if (data.activeProfile === message.oldLabel) {
        updates.activeProfile = message.newLabel;
      }
      chrome.storage.local.set(updates, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.action === "refreshUsage") {
    updateUsageDataForActiveProfile()
      .then((data) => {
        sendResponse({ success: Boolean(data), data });
      });
    return true; // Keep channel open for async response
  }

  // Fallback response for unhandled messages
  sendResponse({ status: "error", message: `Unhandled background action: ${message.action}` });
  return true;
});

// Spawn incognito window to capture login cookies
function startCapture() {
  return new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url: "https://claude.ai",
        incognito: true,
        type: "popup",
        width: 620,
        height: 660
      },
      (newWindow) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message;
          console.error("[Background] Window creation error:", errMsg);
          return reject(new Error(errMsg));
        }
        if (!newWindow) {
          return reject(new Error("Failed to open incognito window."));
        }

        console.log("[Background] Incognito window created:", newWindow.id);

        const windowId = newWindow.id;
        const POLL_INTERVAL = 2500;
        const MAX_WAIT_MS = 180000; // 3 minutes timeout
        let elapsed = 0;
        let settled = false;

        // Clean up when the window is closed manually by the user
        const onWindowRemoved = (removedId) => {
          if (removedId !== windowId) return;
          chrome.windows.onRemoved.removeListener(onWindowRemoved);
          clearInterval(intervalId);
          if (!settled) {
            settled = true;
            reject(new Error("Login window was closed before sign-in completed."));
          }
        };
        chrome.windows.onRemoved.addListener(onWindowRemoved);

        // Interval poller to check for sessionKey cookie
        const intervalId = setInterval(() => {
          elapsed += POLL_INTERVAL;
          if (elapsed >= MAX_WAIT_MS) {
            clearInterval(intervalId);
            chrome.windows.onRemoved.removeListener(onWindowRemoved);
            chrome.windows.remove(windowId, () => {});
            if (!settled) {
              settled = true;
              reject(new Error("Timed out waiting for sessionKey cookie."));
            }
            return;
          }

          chrome.tabs.query({ windowId }, (tabs) => {
            if (chrome.runtime.lastError || !tabs || tabs.length === 0) return;
            const tab = tabs[0];
            const storeId = tab.cookieStoreId || "1";

            chrome.cookies.getAll({ domain: "claude.ai", storeId }, (cookies) => {
              if (chrome.runtime.lastError) return;
              const sessionKey = cookies.find((c) => c.name === "sessionKey");
              if (!sessionKey) return; // sessionKey not yet set, user still logging in

              console.log("[Background] sessionKey cookie found!");
              clearInterval(intervalId);
              chrome.windows.onRemoved.removeListener(onWindowRemoved);
              chrome.windows.remove(windowId, () => {});

              if (!settled) {
                settled = true;
                resolve({ cookies });
              }
            });
          });
        }, POLL_INTERVAL);
      }
    );
  });
}

// Remove existing sessionKey and set target cookies, then reload tabs
async function switchProfile(label, cookies) {
  console.log(`[Background] Restoring ${cookies.length} cookie(s) for profile: ${label}`);
  
  // Remove existing sessionKey to prevent session collision
  await new Promise((res) => {
    chrome.cookies.remove({ url: "https://claude.ai", name: "sessionKey" }, () => res());
  });

  // Restore all cookies
  await Promise.allSettled(
    cookies.map((cookie) => {
      const payload = {
        url: "https://claude.ai",
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite || "lax",
      };
      if (cookie.expirationDate) payload.expirationDate = cookie.expirationDate;

      return new Promise((res, rej) => {
        chrome.cookies.set(payload, (result) => {
          if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
          else res(result);
        });
      });
    })
  );

  // Update active profile, reset its usage to 0 to avoid stale limit lock, and save switch time
  const storage = await new Promise((res) => chrome.storage.local.get({ profiles: [] }, res));
  const updatedProfiles = storage.profiles.map(p => {
    if (p.label === label) {
      return { ...p, lastKnownUsage: 0, resetsAt: null, lastUpdated: Date.now() };
    }
    return p;
  });
  await new Promise((res) => {
    chrome.storage.local.set({
      activeProfile: label,
      profiles: updatedProfiles,
      lastProfileSwitchTime: Date.now()
    }, res);
  });

  // Reload all active claude.ai tabs
  chrome.tabs.query({ url: "https://claude.ai/*" }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    tabs.forEach((tab) => {
      // Chat UUIDs are owned by the original account. Redirect them to
      // the home page to start a new thread instead of reloading them into a 404 error page.
      if (tab.url && tab.url.includes('/chat/')) {
        chrome.tabs.update(tab.id, { url: "https://claude.ai/" });
      } else {
        chrome.tabs.reload(tab.id);
      }
    });
  });

  // Query and cache the new credentials usage stats immediately after tab reload
  setTimeout(() => {
    updateUsageDataForActiveProfile(true);
  }, 2000);
}

// Fetch active organization ID from Claude's API
async function getActiveOrganizationId() {
  try {
    const response = await fetch("https://claude.ai/api/organizations", {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`Orgs API returned status ${response.status}`);
    }
    const orgs = await response.json();
    const orgId = orgs?.[0]?.uuid;
    if (!orgId) {
      throw new Error("No organization ID found in response.");
    }
    return orgId;
  } catch (err) {
    console.warn("[Background] Failed to fetch organization ID:", err.message || err);
    throw err;
  }
}

// Fetch active organization usage statistics
async function getUsageStats(orgId) {
  try {
    const response = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`Usage API returned status ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.warn("[Background] Failed to fetch usage stats:", err.message || err);
    throw err;
  }
}

let lastUsagePollTime = 0;
const MIN_POLL_INTERVAL = 30000; // 30 seconds throttle minimum

// Orchestrate active profile usage fetching and storage updates
async function updateUsageDataForActiveProfile(bypassThrottle = false) {
  try {
    const storage = await new Promise((res) => chrome.storage.local.get({ activeProfile: null, profiles: [] }, res));
    const activeLabel = storage.activeProfile;
    if (!activeLabel) {
      console.log("[Background] No active profile set. Skipping usage poll.");
      return null;
    }

    // Verify sessionKey cookie exists before polling to avoid useless fetch failures
    const cookies = await new Promise((res) => chrome.cookies.getAll({ domain: "claude.ai" }, res));
    if (!cookies || !cookies.some(c => c.name === "sessionKey")) {
      console.log("[Background] No sessionKey cookie for claude.ai found. Skipping usage poll.");
      return null;
    }

    const now = Date.now();
    if (!bypassThrottle && (now - lastUsagePollTime < MIN_POLL_INTERVAL)) {
      console.log("[Background] Usage poll request throttled.");
      const active = storage.profiles.find(p => p.label === activeLabel);
      if (active) return { label: activeLabel, utilization: active.lastKnownUsage ?? 0, resetsAt: active.resetsAt };
      return null;
    }
    lastUsagePollTime = now;

    console.log("[Background] Updating usage stats for active profile...");
    const orgId = await getActiveOrganizationId();
    const usage = await getUsageStats(orgId);

    // Extract 5-hour utilization percentage and resets_at time
    const utilization = Math.min(100, Math.max(0, Math.round(usage?.five_hour?.utilization || 0)));
    const resetsAt = usage?.five_hour?.resets_at || null;

    // Update in profiles list
    const profiles = storage.profiles.map((p) => {
      if (p.label === activeLabel) {
        return {
          ...p,
          lastKnownUsage: utilization,
          resetsAt: resetsAt,
          lastUpdated: Date.now()
        };
      }
      return p;
    });

    await new Promise((res) => chrome.storage.local.set({ profiles }, res));
    console.log(`[Background] Quota updated for "${activeLabel}": ${utilization}% Used, Resets at: ${resetsAt}`);
    return { label: activeLabel, utilization, resetsAt };
  } catch (err) {
    console.warn("[Background] Failed to update usage stats:", err.message || err);
    return null;
  }
}

// ── Background Alarms for Auto-Update ─────────────────────────────────────
// Register a recurring alarm that fires every 1 minute to poll quota (Chrome minimum)
chrome.alarms.create("poll_usage_stats", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll_usage_stats") {
    console.log("[Background] Alarm triggered. Polling usage stats...");
    updateUsageDataForActiveProfile(true); // Bypass throttle for alarms
  }
});

// ── Tab Event Listeners ──────────────────────────────────────────────────
// Automatically poll usage stats when a Claude tab completes loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('https://claude.ai/')) {
    console.log('[Background] Claude tab load complete. Checking usage quota...');
    updateUsageDataForActiveProfile(false); // Respect throttle to prevent API spam
  }
});

// Run an initial poll when the background service worker starts up/loads
setTimeout(() => {
  updateUsageDataForActiveProfile(true);
}, 1000);
