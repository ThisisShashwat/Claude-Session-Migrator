// content.js - Injected page content script
console.log("[Content] Script loaded.");

// Establish listener connection for runtime messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!chrome.runtime?.id) return; // Exit silently if context invalidated
  console.log("[Content] Message received from background:", message);
  
  if (message.action === "ping") {
    sendResponse({ status: "alive" });
    return true;
  }
  
  sendResponse({ status: "ignored" });
  return true;
});

let includeThinking = false;
let activeProfileUsage = 0;
let lastProfileSwitchTime = 0;

// Initialize includeThinking and lastProfileSwitchTime from storage
chrome.storage.local.get({ includeThinking: false, lastProfileSwitchTime: 0 }, (data) => {
  if (chrome.runtime?.id) {
    includeThinking = data.includeThinking;
    lastProfileSwitchTime = data.lastProfileSwitchTime || 0;
  }
});

// Establish storage change listener to sync UI states automatically
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (!chrome.runtime?.id) return; // Exit silently if context invalidated
  if (namespace !== "local") return;
  
  if (changes.activeProfile || changes.profiles) {
    updatePanelData();
    // In addition to DOM checks, verify limit status from stored usage stats
    checkUsageLimitFromStorage();
  }
  if (changes.includeThinking) {
    includeThinking = changes.includeThinking.newValue;
  }
  if (changes.lastProfileSwitchTime) {
    lastProfileSwitchTime = changes.lastProfileSwitchTime.newValue || 0;
  }
});

// Run a check from stored metrics on initial load
setTimeout(() => {
  if (chrome.runtime?.id) {
    checkUsageLimitFromStorage();
  }
}, 1000);

let containerElement = null;
let barElement = null;
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 1000;

// Resolve the insert anchor vertically stacked right above the profile button row in sidebar
function getSidebarAnchor() {
  const userMenuBtn = document.querySelector('[data-testid="user-menu-button"]');
  if (!userMenuBtn) return null;

  const profileRow = userMenuBtn.parentElement?.parentElement;
  if (!profileRow) return null;

  return {
    parent: profileRow.parentElement,
    referenceNode: profileRow,
    styles: {
      borderTop: '0.5px solid var(--cds-border)',
      width: '100%',
      boxSizing: 'border-box',
      backgroundColor: 'transparent'
    }
  };
}

// Mounts elements dynamically to standard anchors
function mountToAnchor(element, anchor) {
  if (!anchor) return false;
  
  let needsInsert = false;
  if (anchor.insertAfter) {
    needsInsert = anchor.insertAfter.nextElementSibling !== element;
  } else if (anchor.referenceNode) {
    needsInsert = element.nextElementSibling !== anchor.referenceNode || element.parentElement !== anchor.parent;
  } else {
    needsInsert = element.parentElement !== anchor.parent;
  }

  if (needsInsert) {
    if (anchor.insertAfter) {
      anchor.insertAfter.after(element);
    } else {
      anchor.parent.insertBefore(element, anchor.referenceNode || null);
    }
  }

  if (anchor.styles) Object.assign(element.style, anchor.styles);
  return true;
}

// Create the native-feeling sidebar progress bar container
function createBarElement() {
  if (document.getElementById("claude-session-migrator-container")) {
    containerElement = document.getElementById("claude-session-migrator-container");
    barElement = document.getElementById("claude-session-migrator-bar");
    return;
  }

  containerElement = document.createElement("div");
  containerElement.id = "claude-session-migrator-container";
  containerElement.className = "csm-sidebar-container";
  containerElement.style.cssText = `
    width: 100%;
    background-color: transparent;
  `;

  barElement = document.createElement("div");
  barElement.id = "claude-session-migrator-bar";
  barElement.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    font-family: inherit;
    color: hsl(var(--text-300));
    width: 100%;
    user-select: none;
    box-sizing: border-box;
    background-color: transparent;
    padding: 12px 16px;
    transition: padding 0.15s ease;
  `;

  barElement.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; background-color: transparent;">
      <span id="csm-profile-label" style="background-color: transparent;">Profile: <strong id="csm-active-profile" style="color: hsl(var(--text-100)); font-weight: 500; background-color: transparent;">--</strong></span>
      <span id="csm-quota-text" style="font-weight: 500; color: hsl(var(--text-100)); background-color: transparent;">0%</span>
    </div>
    <div style="width: 100%; height: 6px; background-color: hsl(var(--bg-300)); border-radius: 3px; overflow: hidden; margin-top: 2px;">
      <div id="csm-quota-bar" style="width: 0%; height: 100%; background-color: #2e7d32; border-radius: 3px; transition: width 0.4s ease, background-color 0.3s ease;"></div>
    </div>
    <span id="csm-reset-text" style="font-size: 11px; color: hsl(var(--text-400)); display: none; background-color: transparent; margin-top: 2px;"></span>
  `;

  containerElement.appendChild(barElement);
}

// Update the visual status data on the bar
function updatePanelData() {
  if (!chrome.runtime?.id) return; // Exit if context invalidated
  if (!barElement) return;

  chrome.storage.local.get({ activeProfile: null, profiles: [] }, (data) => {
    if (chrome.runtime.lastError) return; // Catch invalidated context error silently

    const activeLabel = data.activeProfile;
    const profiles = data.profiles;
    
    const profileActiveEl = document.getElementById("csm-active-profile");
    const quotaBarEl = document.getElementById("csm-quota-bar");
    const quotaTextEl = document.getElementById("csm-quota-text");
    const resetTextEl = document.getElementById("csm-reset-text");

    const tooltipText = "Claude 5-hour session quota usage";

    if (!activeLabel) {
      if (profileActiveEl) profileActiveEl.textContent = "None";
      if (quotaBarEl) quotaBarEl.style.width = "0%";
      if (quotaTextEl) quotaTextEl.textContent = "0%";
      if (resetTextEl) {
        resetTextEl.textContent = "";
        resetTextEl.style.display = "none";
      }
      if (barElement.tooltip) {
        barElement.tooltip.updateText(tooltipText);
      } else if (typeof createClaudeTooltip === "function") {
        createClaudeTooltip(barElement, tooltipText);
      }
      return;
    }

    const activeProfile = profiles.find(p => p.label === activeLabel);
    if (profileActiveEl) profileActiveEl.textContent = activeLabel;

    if (activeProfile) {
      const usage = activeProfile.lastKnownUsage ?? 0;
      if (quotaBarEl) {
        quotaBarEl.style.width = `${usage}%`;
        // Color gradient based on utilization
        if (usage < 50) {
          quotaBarEl.style.backgroundColor = "#2e7d32"; // Green
        } else if (usage < 80) {
          quotaBarEl.style.backgroundColor = "#f57c00"; // Orange
        } else {
          quotaBarEl.style.backgroundColor = "#d32f2f"; // Red
        }
      }
      if (quotaTextEl) quotaTextEl.textContent = `${usage}%`;

      if (activeProfile.resetsAt) {
        const resetsDate = new Date(activeProfile.resetsAt);
        const msLeft = resetsDate.getTime() - Date.now();
        if (msLeft > 0) {
          const minsLeft = Math.ceil(msLeft / 60000);
          const hours = Math.floor(minsLeft / 60);
          const mins = minsLeft % 60;
          const timeString = resetsDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
          const timeText = `Resets in ${hours > 0 ? hours + 'h ' : ''}${mins}m (at ${timeString})`;
          if (resetTextEl) {
            resetTextEl.textContent = timeText;
            resetTextEl.style.display = "inline";
          }
        } else {
          if (resetTextEl) {
            resetTextEl.textContent = "Quota Reset";
            resetTextEl.style.display = "inline";
          }
        }
      } else {
        if (resetTextEl) {
          resetTextEl.textContent = "";
          resetTextEl.style.display = "none";
        }
      }
    } else {
      if (quotaBarEl) quotaBarEl.style.width = "0%";
      if (quotaTextEl) quotaTextEl.textContent = "0%";
      if (resetTextEl) {
        resetTextEl.textContent = "";
        resetTextEl.style.display = "none";
      }
    }

    if (barElement.tooltip) {
      barElement.tooltip.updateText(tooltipText);
    } else if (typeof createClaudeTooltip === "function") {
      createClaudeTooltip(barElement, tooltipText);
    }
  });
}

// Start update and mount loop
function startUpdateLoop() {
  const update = (timestamp) => {
    if (!chrome.runtime?.id) {
      console.log("[Content] Context invalidated. Stopping update loop.");
      return;
    }
    
    if (timestamp - lastUpdateTime >= UPDATE_INTERVAL) {
      lastUpdateTime = timestamp;

      // ── Sidebar quota panel ──
      const anchor = getSidebarAnchor();
      if (anchor) {
        if (!containerElement) {
          createBarElement();
        }
        mountToAnchor(containerElement, anchor);
        updatePanelData();
      } else {
        if (containerElement && containerElement.parentElement) {
          containerElement.remove();
        }
      }

      // ── Top-bar action buttons (Export / Import / Migrate) ──
      // injectTopBarButtons() is idempotent — safe to call every tick.
      injectTopBarButtons();

      // Ensure the send button migrate icon is persistent when limit is reached
      if (sendInterceptActive) {
        ensureSendButtonMigrateIcon();
      }
    }
    requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

// Start the loop immediately
startUpdateLoop();

// ── Top Bar Button Injection ─────────────────────────────────────────────────
//
// Strategy: find Claude's native top-bar action container
// (data-testid="wiggle-controls-actions"), then prepend our three icon
// buttons immediately before the Share button.
//
// All buttons use CLAUDE_CLASSES.ICON_BTN so they inherit Claude's own
// hover, focus-ring, and active-press styles with zero custom CSS needed.

/**
 * Returns the Share button element from Claude's top-bar action row,
 * or null if it has not yet been rendered.
 * Uses multiple fallback selectors to survive Claude UI updates.
 */
function findShareButton() {
  // Primary: specific data-testid observed in the live DOM dump
  const byTestId = document.querySelector('[data-testid="wiggle-controls-actions-share"]');
  if (byTestId) return byTestId;

  // Fallback: any button whose aria-label mentions "Share"
  const byAriaLabel = document.querySelector(
    'button[aria-label*="Share"], button[aria-label*="share"]'
  );
  if (byAriaLabel) return byAriaLabel;

  return null;
}

/**
 * Builds one native-looking icon button for Claude's top-bar.
 *
 * @param {string}   id       - Unique DOM id (used as mount guard)
 * @param {string}   svgBody  - Inner SVG markup (paths, polylines, etc.)
 * @param {string}   label    - aria-label + tooltip text shown on hover
 * @param {Function} onClick  - Click handler
 * @returns {HTMLButtonElement}
 */
function createTopBarButton(id, svgBody, label, onClick) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.type = 'button';
  btn.setAttribute('aria-label', label);

  // Use Claude's own icon-button class — inherits all hover/focus ring styles
  btn.className = CLAUDE_CLASSES.ICON_BTN;

  // 18×18 SVG scaled to match Claude's existing toolbar icons
  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"
         viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true">
      ${svgBody}
    </svg>
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });

  // Attach a native Claude tooltip that appears above the button on hover
  if (typeof createClaudeTooltip === 'function') {
    createClaudeTooltip(btn, label, /* deleteOnClick */ true);
  }

  return btn;
}

/**
 * Injects the Export, Import, and Migrate icon buttons into Claude's
 * top-bar action row, immediately before the Share button.
 *
 * This function is idempotent: if the buttons are already mounted and
 * connected to the DOM, it returns immediately without doing any work.
 * This makes it safe to call on every animation-frame tick.
 */
function injectTopBarButtons() {
  const isNew = window.location.pathname === '/new' || window.location.pathname === '/';

  if (isNew) {
    document.getElementById('csm-topbar-export-btn')?.remove();
    document.getElementById('csm-topbar-migrate-btn')?.remove();
    document.getElementById('csm-topbar-import-btn')?.remove();
    if (document.getElementById('csm-topbar-import-new-btn')?.isConnected) return;

    const container = document.querySelector('div.fixed.z-header.right-3')
                   || document.querySelector('.fixed.z-header.draggable-none.right-3')
                   || document.querySelector('[data-testid="page-header"] .right-3.flex.gap-2')
                   || document.querySelector('[data-testid="page-header"] .flex.gap-2:last-child')
                   || document.querySelector('[data-testid="page-header"] > div > div:last-child');
    if (!container) return;

    const IMPORT_SVG = `
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    `;
    const importBtn = createTopBarButton('csm-topbar-import-new-btn', IMPORT_SVG, 'Import Chat', triggerManualImport);
    container.insertBefore(importBtn, container.firstChild);
    return;
  }

  // Remove the new chat page button if we are on a chat page
  document.getElementById('csm-topbar-import-new-btn')?.remove();

  // Guard: already fully mounted — nothing to do
  if (document.getElementById('csm-topbar-export-btn')?.isConnected) return;

  // Clean up any stale imports
  document.getElementById('csm-topbar-export-btn')?.remove();
  document.getElementById('csm-topbar-import-btn')?.remove();
  document.getElementById('csm-topbar-migrate-btn')?.remove();

  // Find the Share button that acts as our insertion anchor
  const shareBtn = findShareButton();
  if (!shareBtn) return; // Top bar not rendered yet; will retry next tick

  const container = shareBtn.parentElement;
  if (!container) return;

  // ── SVG icon bodies (Lucide icon style, matching Claude's icon set) ──

  // Export: download arrow (line + arrow pointing down)
  const EXPORT_SVG = `
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  `;

  // Import: upload arrow (line + arrow pointing up)
  const IMPORT_SVG = `
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  `;

  // Migrate: two-arrow swap (accounts switching)
  const MIGRATE_SVG = `
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
  `;

  // Create the three buttons, wiring them to the existing action functions
  const exportBtn  = createTopBarButton('csm-topbar-export-btn',  EXPORT_SVG,  'Export Chat',  triggerManualExport);
  const importBtn  = createTopBarButton('csm-topbar-import-btn',  IMPORT_SVG,  'Import Chat',  triggerManualImport);
  const migrateBtn = createTopBarButton('csm-topbar-migrate-btn', MIGRATE_SVG, 'Migrate Chat', () => {
    // Open the migration modal — always available, not just when limit fires
    showMigrationModal();
  });

  // Insert order: Export | Import | Migrate | [Share]
  // insertBefore(newNode, referenceNode) places newNode BEFORE referenceNode
  container.insertBefore(migrateBtn, shareBtn);
  container.insertBefore(importBtn,  migrateBtn);
  container.insertBefore(exportBtn,  importBtn);
}

// Chat Scraper functionality (Phase 8)

const MESSAGE_SELECTORS = [
  "[data-testid='user-message']",
  ".font-claude-response",
  "[data-testid*='message']",
  "[data-message-id]",
  "[class*='conversation-message']",
  "[class*='message_']",
  "article[class*='message']",
  "section[class*='message']"
];

function isCodePage() {
  return window.location.pathname.startsWith('/code');
}

function findCodePageMessages() {
  const nodes = [];
  const chatColumn = document.querySelector('.epitaxy-chat-column') || document;
  const entries = chatColumn.querySelectorAll('[data-epitaxy-entry]');
  entries.forEach((entry) => {
    if (isRelevantMessageNode(entry)) {
      nodes.push(entry);
    }
  });

  if (nodes.length > 0) {
    nodes.sort((a, b) => {
      const idxA = parseInt(a.closest('[data-index]')?.getAttribute('data-index') || '0', 10);
      const idxB = parseInt(b.closest('[data-index]')?.getAttribute('data-index') || '0', 10);
      return idxA - idxB;
    });
    return nodes;
  }

  // Fallback for older code page structures
  const chatContainer = document.querySelector('#cli-button-container .overflow-y-auto .w-full');
  if (!chatContainer) return nodes;
  const messageBlocks = chatContainer.querySelectorAll(':scope > .flex.justify-center > .w-full.max-w-3xl > .pb-4');
  messageBlocks.forEach((block) => {
    if (isRelevantMessageNode(block)) {
      nodes.push(block);
    }
  });
  return nodes;
}

function isRelevantMessageNode(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  const text = node.textContent?.trim();
  if (!text || text.length < 2) {
    return false;
  }
  return true;
}

function findMessageNodes() {
  if (isCodePage()) {
    const codeMessages = findCodePageMessages();
    if (codeMessages.length > 0) return codeMessages;
  }

  const nodeSet = new Set();
  MESSAGE_SELECTORS.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      if (node && !nodeSet.has(node) && isRelevantMessageNode(node)) {
        nodeSet.add(node);
      }
    });
  });

  const nodes = Array.from(nodeSet);
  nodes.sort((a, b) => {
    if (a === b) return 0;
    if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return -1;
  });

  return nodes;
}

const ROLE_HINTS = {
  user: ["user", "you", "sent"],
  assistant: ["assistant", "claude", "ai", "response", "reply"]
};

function resolveRole(node) {
  if (isCodePage()) {
    const entryId = node.getAttribute && node.getAttribute('data-epitaxy-entry');
    if (entryId) {
      return entryId.startsWith('msg_') ? 'Claude' : 'User';
    }
    const userBubble = node.querySelector('.ml-auto');
    if (userBubble) return "User";
    const claudeRow = node.querySelector('.flex.items-start.gap-1.text-sm');
    if (claudeRow) return "Claude";
  }

  const userContainer = node.closest("[data-testid='user-message']");
  if (userContainer) return "User";

  const claudeContainer = node.closest(".font-claude-response");
  if (claudeContainer) return "Claude";

  const datasetRole = node.dataset?.role || node.getAttribute("data-role");
  if (datasetRole) {
    return datasetRole.toLowerCase().includes("user") ? "User" : "Claude";
  }

  const testId = node.getAttribute("data-testid") || "";
  if (testId) {
    if (testId.toLowerCase().includes("assistant")) return "Claude";
    if (testId.toLowerCase().includes("user")) return "User";
  }

  const className = node.className?.toString().toLowerCase() || "";
  if (className.includes("assistant") || className.includes("bot")) return "Claude";
  if (className.includes("user")) return "User";

  const text = node.textContent?.toLowerCase() || "";
  const userHint = ROLE_HINTS.user.some((hint) => text.startsWith(hint + ":"));
  if (userHint) return "User";

  return "Claude";
}

function findContentElement(node) {
  if (!(node instanceof HTMLElement)) {
    return null;
  }

  if (isCodePage()) {
    const entryId = node.getAttribute && node.getAttribute('data-epitaxy-entry');
    if (entryId) {
      if (entryId.startsWith('msg_')) {
        const blocks = node.querySelectorAll('.epitaxy-markdown');
        if (blocks.length === 1) return blocks[0];
        if (blocks.length > 1) {
          const wrapper = document.createElement('div');
          blocks.forEach((b) => wrapper.appendChild(b.cloneNode(true)));
          return wrapper;
        }
      } else {
        const paragraphs = node.querySelectorAll('p.text-body.whitespace-pre-wrap');
        if (paragraphs.length === 1) return paragraphs[0];
        if (paragraphs.length > 1) {
          const wrapper = document.createElement('div');
          paragraphs.forEach((p) => wrapper.appendChild(p.cloneNode(true)));
          return wrapper;
        }
      }
      return node;
    }

    const userBubble = node.querySelector('.ml-auto .bg-bg-200 .space-y-2');
    if (userBubble) return userBubble;
    const claudeContent = node.querySelector('.break-words .space-y-2');
    if (claudeContent) return claudeContent;
    const anyContent = node.querySelector('.space-y-2');
    if (anyContent) return anyContent;
  }

  if (node.matches("[data-testid='user-message']")) {
    return node;
  }

  const userAncestor = node.closest("[data-testid='user-message']");
  if (userAncestor) {
    return userAncestor;
  }

  if (node.matches(".font-claude-response")) {
    return node;
  }

  const claudeAncestor = node.closest(".font-claude-response");
  if (claudeAncestor) {
    return claudeAncestor;
  }

  const richContent = node.querySelector("[data-testid*='content'], [class*='content'], [class*='message-body'], article, section");
  return richContent || node;
}

function convertElementToMarkdown(element) {
  if (!element) return "";

  const clone = element.cloneNode(true);

  if (clone.style) {
    clone.style.maxHeight = 'none';
    clone.style.overflow = 'visible';
  }

  // Handle thinking blocks based on includeThinking toggle
  if (!includeThinking) {
    // Remove thinking blocks/details and custom thought tags
    clone.querySelectorAll("details, thinking, [class*='thought'], [class*='thinking']").forEach((el) => el.remove());
    
    // Remove modern Radix-style thinking accordions (using group/status class)
    clone.querySelectorAll('button[class*="group/status"]').forEach((btn) => {
      const container = btn.closest('.row-start-1') || btn.closest('[class*="row-start-1"]');
      if (container) {
        container.remove();
      } else {
        btn.remove();
      }
    });

    // Fallback: Remove old Radix-style/div-based thinking accordions matching static text
    clone.querySelectorAll("button, div, span").forEach((el) => {
      const text = el.textContent?.trim();
      if ((text === "Thinking Process" || text === "Thinking") && text.length < 30) {
        let container = el;
        for (let i = 0; i < 3; i++) {
          if (container.parentElement && 
              container.parentElement !== clone && 
              !container.parentElement.classList.contains("standard-markdown") &&
              !container.parentElement.matches(".font-claude-response")) {
            container = container.parentElement;
          } else {
            break;
          }
        }
        if (container && container !== el) {
          container.remove();
        } else {
          el.remove();
        }
      }
    });
  } else {
    // Format any details tags as clean Markdown <details> blocks
    clone.querySelectorAll("details").forEach((details) => {
      const summary = details.querySelector("summary")?.textContent?.trim() || "Thinking Process";
      const contentClone = details.cloneNode(true);
      contentClone.querySelector("summary")?.remove();
      const contentText = contentClone.textContent?.trim() || "";
      details.replaceWith(`\n\n<details>\n<summary>${summary}</summary>\n\n${contentText}\n\n</details>\n\n`);
    });

    // Format modern Radix-style thinking blocks as details blocks
    clone.querySelectorAll('button[class*="group/status"]').forEach((btn) => {
      const container = btn.closest('.row-start-1') || btn.closest('[class*="row-start-1"]');
      if (container) {
        const summaryText = btn.textContent?.trim() || "Thinking Process";
        const gridEl = container.querySelector('.grid') || container.querySelector('[class*="grid"]');
        let detailsText = "";
        if (gridEl) {
          const gridClone = gridEl.cloneNode(true);
          detailsText = convertElementToMarkdown(gridClone).trim();
        }
        if (!detailsText) {
          // Block is collapsed — Claude unmounts the thought content from the DOM
          // when aria-expanded=false, so there is nothing to extract.
          // Remove the container so the accordion button text doesn’t leak into output.
          container.remove();
        } else {
          const replacement = `\n\n<details>\n<summary>Thinking Process: ${summaryText}</summary>\n\n${detailsText}\n\n</details>\n\n`;
          container.replaceWith(replacement);
        }
      }
    });

    // Fallback: Format old Radix-style thinking blocks as details blocks
    clone.querySelectorAll("button, div, span").forEach((el) => {
      const text = el.textContent?.trim();
      if ((text === "Thinking Process" || text === "Thinking") && text.length < 30) {
        let container = el;
        for (let i = 0; i < 3; i++) {
          if (container.parentElement && 
              container.parentElement !== clone && 
              !container.parentElement.classList.contains("standard-markdown") &&
              !container.parentElement.matches(".font-claude-response")) {
            container = container.parentElement;
          } else {
            break;
          }
        }
        if (container && container !== el) {
          const contentClone = container.cloneNode(true);
          contentClone.querySelectorAll("button, span").forEach((h) => {
            const hText = h.textContent?.trim();
            if (hText === "Thinking Process" || hText === "Thinking") h.remove();
          });
          const contentText = contentClone.textContent?.trim() || "";
          container.replaceWith(`\n\n<details>\n<summary>${text}</summary>\n\n${contentText}\n\n</details>\n\n`);
        }
      }
    });
  }

  // Clean up elements that are not part of conversation text
  clone.querySelectorAll("script, style, button, .bg-gradient-to-t, .pointer-events-none, .absolute, .overflow-hidden.line-clamp-\\[6\\]").forEach((el) => el.remove());

  clone.querySelectorAll("br").forEach((br) => {
    br.replaceWith("\n");
  });

  // 1. Block code (pre)
  clone.querySelectorAll("pre").forEach((pre) => {
    const codeEl = pre.querySelector("code");
    const code = codeEl ? codeEl.textContent : pre.textContent || "";
    const language = codeEl?.className.match(/language-([\w-]+)/)?.[1] || "";
    const fenced = language
      ? `\n\`\`\`${language}\n${code}\n\`\`\`\n`
      : `\n\`\`\`\n${code}\n\`\`\`\n`;
    pre.replaceWith(fenced);
  });

  // 2. Inline code
  Array.from(clone.querySelectorAll("code")).reverse().forEach((code) => {
    const text = code.textContent || "";
    code.replaceWith(`\`${text}\``);
  });

  // 3. Bold
  Array.from(clone.querySelectorAll("strong, b")).reverse().forEach((bold) => {
    const text = bold.textContent || "";
    bold.replaceWith(`**${text}**`);
  });

  // 4. Italics
  Array.from(clone.querySelectorAll("em, i")).reverse().forEach((ital) => {
    const text = ital.textContent || "";
    ital.replaceWith(`*${text}*`);
  });

  // 5. Links
  Array.from(clone.querySelectorAll("a")).reverse().forEach((link) => {
    const text = link.textContent || "";
    const href = link.getAttribute("href") || "";
    if (href && href !== "#") {
      link.replaceWith(`[${text}](${href})`);
    } else {
      link.replaceWith(text);
    }
  });

  // 6. Headers
  Array.from(clone.querySelectorAll("h1, h2, h3, h4, h5, h6")).reverse().forEach((header) => {
    const level = parseInt(header.tagName.substring(1));
    const hashes = "#".repeat(level);
    const text = header.textContent?.trim() || "";
    header.replaceWith(`\n\n${hashes} ${text}\n\n`);
  });

  // 7. List items (ordered & unordered)
  Array.from(clone.querySelectorAll("li")).reverse().forEach((li) => {
    const isOrdered = li.parentElement && li.parentElement.tagName === "OL";
    let prefix = "- ";
    if (isOrdered) {
      const siblings = Array.from(li.parentElement.children);
      const index = siblings.indexOf(li) + 1;
      prefix = `${index}. `;
    }
    const text = li.textContent?.trim() || "";
    li.replaceWith(`${prefix}${text}\n`);
  });

  // 8. Paragraphs
  Array.from(clone.querySelectorAll("p")).reverse().forEach((p) => {
    const text = p.textContent || "";
    p.replaceWith(`${text}\n\n`);
  });

  const textContent = clone.textContent?.replace(/\u00a0/g, " ") || "";

  const formattedText = textContent
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return formattedText;
}

function parseMessageNode(node) {
  const role = resolveRole(node);
  const contentElement = findContentElement(node);
  const markdown = convertElementToMarkdown(contentElement || node);

  if (!markdown) return null;

  return {
    role,
    markdown,
    rawText: (contentElement || node).textContent?.trim() || "",
    timestamp: Date.now()
  };
}

function compileMessagesToMarkdown(messages) {
  return messages.map(msg => `### ${msg.role}:\n${msg.markdown || msg.rawText}`).join("\n\n");
}

function scrapeAndSplitChat(verbatimCount = 3) {
  const nodes = findMessageNodes();
  const messages = nodes.map(parseMessageNode).filter(Boolean);

  if (messages.length === 0) {
    return { earlyHistoryText: "", recentHistoryText: "", totalMessages: 0 };
  }

  const boundaryIndex = Math.max(0, messages.length - verbatimCount);
  
  const earlyMessages = messages.slice(0, boundaryIndex);
  const recentMessages = messages.slice(boundaryIndex);

  const earlyHistoryText = compileMessagesToMarkdown(earlyMessages);
  const recentHistoryText = compileMessagesToMarkdown(recentMessages);

  return {
    earlyHistoryText,
    recentHistoryText,
    totalMessages: messages.length,
    earlyCount: earlyMessages.length,
    recentCount: recentMessages.length
  };
}

/**
 * Reads the active conversation title from the page.
 * Claude sets document.title to "<Conversation Name> \ Claude" (or similar).
 * Returns null if we're on the home/new-chat page with no named conversation.
 */
/**
 * Expands all collapsed thinking accordion buttons in the live DOM,
 * waits for React to mount the content subtree (CSS transition = 300ms),
 * then returns a cleanup function that re-collapses exactly the buttons
 * that were opened.
 *
 * The brief visual "flash" of blocks opening and closing is unavoidable —
 * it is the only way to access content that React unmounts when collapsed.
 *
 * @returns {Promise<Function>} Async cleanup that re-collapses opened blocks.
 */
async function expandAllThinkingBlocks() {
  // Only select buttons that are currently COLLAPSED (aria-expanded="false")
  const collapsed = Array.from(
    document.querySelectorAll('button[class*="group/status"][aria-expanded="false"]')
  );

  if (collapsed.length === 0) {
    return () => {}; // nothing to expand — return a no-op cleanup
  }

  // Click every collapsed button to trigger expansion
  collapsed.forEach(btn => btn.click());

  // Wait for React to finish mounting the content subtree.
  // Claude's accordion uses the Tailwind "duration-300" class (300 ms transition),
  // so 400 ms gives a comfortable buffer for all mounts to complete.
  await new Promise(resolve => setTimeout(resolve, 400));

  // Return a cleanup function that re-collapses only the buttons we opened.
  // We re-check aria-expanded="true" in case the user toggled one during the wait.
  return () => {
    collapsed.forEach(btn => {
      if (btn.isConnected && btn.getAttribute('aria-expanded') === 'true') {
        btn.click();
      }
    });
  };
}

function getConversationTitle() {
  // ── Primary: document.title ────────────────────────────────────────────
  // Claude formats the tab title as "<Name> \ Claude", "<Name> - Claude", etc.
  const rawTitle = document.title?.trim();
  if (rawTitle && rawTitle !== 'Claude') {
    // Strip any trailing separator + "Claude" suffix
    const cleaned = rawTitle
      .replace(/\s*[\\|·\-\u2013\u2014]\s*Claude\s*$/i, '')
      .trim();
    if (cleaned && cleaned.toLowerCase() !== 'claude') return cleaned;
  }

  // ── Fallback: look for a visible title element in the top bar ──────────
  const titleEl =
    document.querySelector('[data-testid="conversation-title"]') ||
    document.querySelector('[data-testid*="title"]') ||
    document.querySelector('h1');

  if (titleEl) {
    const text = titleEl.textContent?.trim();
    // Ignore generic headings that are not conversation names
    if (text && text.toLowerCase() !== 'claude' && text.length < 120) return text;
  }

  return null; // unnamed / home page
}

function triggerManualExport() {
  // ── Step 1: Build the modal content ──────────────────────────────────────

  const contentDiv = document.createElement('div');
  contentDiv.style.display = 'flex';
  contentDiv.style.flexDirection = 'column';
  contentDiv.style.gap = '12px';

  // Subtitle explaining what the toggle does
  const desc = document.createElement('p');
  desc.className = 'text-text-200';
  desc.textContent = 'Scrape the current conversation and download it as a Markdown file.';
  contentDiv.appendChild(desc);

  // "Include thinking blocks" toggle — defaults to the current global setting
  // createClaudeToggle is provided by helpers/claude-styles.js
  const { container: toggleRow, input: thinkingToggleInput } = createClaudeToggle(
    'Include thinking blocks',
    includeThinking  // pre-fill with whatever the user last saved
  );
  contentDiv.appendChild(toggleRow);

  // ── Step 2: Show the modal ───────────────────────────────────────────────

  const modal = new ClaudeModal('Export Chat', contentDiv);

  modal.addCancel('Cancel');

  modal.addConfirm('Export', async () => {
    // Read the toggle at confirm-time (user may have flipped it)
    const exportWithThinking = thinkingToggleInput.checked;

    try {
      // When including thinking blocks, auto-expand all collapsed accordions
      // so React mounts their hidden content into the DOM before we scrape.
      // expandAllThinkingBlocks() returns a cleanup that re-collapses them.
      let collapseThinkingBlocks = () => {};
      if (exportWithThinking) {
        collapseThinkingBlocks = await expandAllThinkingBlocks();
      }

      // Temporarily override the global includeThinking so the scraper
      // filter applies correctly for this export run, then restore it.
      const previousThinking = includeThinking;
      includeThinking = exportWithThinking;

      const nodes    = findMessageNodes();
      const messages = nodes.map(parseMessageNode).filter(Boolean);

      // Restore global state and re-collapse whatever we expanded
      includeThinking = previousThinking;
      collapseThinkingBlocks();

      if (messages.length === 0) {
        showClaudeAlert('Export', 'No messages found to export.');
        return;
      }

      // ── Build the Markdown file ────────────────────────────────────────

      const lines = [];
      lines.push('# Claude Conversation Export');
      lines.push('');

      // Include the conversation title so the file is self-contained
      const exportTitle = getConversationTitle();
      if (exportTitle) lines.push(`Conversation: ${exportTitle}`);

      lines.push(`Exported: ${new Date().toLocaleString()}`);
      lines.push(`Messages: ${messages.length}`);
      // Record the setting used so the file is self-documenting
      lines.push(`Thinking blocks: ${exportWithThinking ? 'Included' : 'Excluded'}`);
      lines.push('');
      lines.push('---');
      lines.push('');

      messages.forEach((message, index) => {
        lines.push(`## ${message.role}`);
        lines.push('');
        lines.push(message.markdown || message.rawText);
        lines.push('');
        if (index < messages.length - 1) {
          lines.push('---');
          lines.push('');
        }
      });

      // ── Trigger the download ───────────────────────────────────────────

      const markdown = lines.join('\n');
      const blob     = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url      = URL.createObjectURL(blob);

      const timestamp  = new Date().toISOString().slice(0, 10);

      // Build a filesystem-safe slug from the conversation title
      const convoTitle = getConversationTitle();
      const safeName   = convoTitle
        ? convoTitle
            .replace(/[^\w\s-]/g, '')   // remove special chars
            .trim()
            .replace(/\s+/g, '-')        // spaces → hyphens
            .replace(/-{2,}/g, '-')      // collapse consecutive hyphens
            .slice(0, 50)                // cap length
        : 'chat';
      const filename   = `claude-${safeName}-${timestamp}.md`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();

      // Clean up the object URL after the browser has picked up the download
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);

    } catch (err) {
      console.error('[SessionMigrator] Manual export failed:', err);
      // Use native ClaudeAlert so the error stays visually consistent
      showClaudeAlert('Export Failed', err.message);
    }
  });

  modal.show();
}

function parseMarkdownToMessages(markdownText) {
  // Strip details tags (including thinking processes) from the raw text to save tokens
  let cleanMarkdown = markdownText.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, "");
  
  const lines = cleanMarkdown.split(/\r?\n/);
  const messages = [];
  let currentMessage = null;

  // Detect role turn headers like "## User", "### Claude:", "## Assistant", etc.
  const rolePattern = /^#+\s*(User|You|Claude|Assistant|System):?\s*$/i;

  for (let line of lines) {
    const match = line.match(rolePattern);
    if (match) {
      if (currentMessage) {
        let cleanText = currentMessage.markdown.trim();
        if (cleanText.startsWith("---")) cleanText = cleanText.substring(3).trim();
        if (cleanText.endsWith("---")) cleanText = cleanText.substring(0, cleanText.length - 3).trim();
        currentMessage.markdown = cleanText;
        if (currentMessage.markdown) {
          messages.push(currentMessage);
        }
      }
      const roleRaw = match[1].toLowerCase();
      const role = (roleRaw === "user" || roleRaw === "you") ? "User" : "Claude";
      currentMessage = {
        role,
        markdown: "",
        rawText: "",
        timestamp: Date.now()
      };
    } else {
      if (currentMessage) {
        currentMessage.markdown += line + "\n";
      }
    }
  }

  if (currentMessage) {
    let cleanText = currentMessage.markdown.trim();
    if (cleanText.startsWith("---")) cleanText = cleanText.substring(3).trim();
    if (cleanText.endsWith("---")) cleanText = cleanText.substring(0, cleanText.length - 3).trim();
    currentMessage.markdown = cleanText;
    if (currentMessage.markdown) {
      messages.push(currentMessage);
    }
  }

  return messages;
}

function triggerManualImport() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md";
  input.style.display = "none";
  document.body.appendChild(input);

  input.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) {
      document.body.removeChild(input);
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target.result;
        const messages = parseMarkdownToMessages(text);
        if (messages.length === 0) {
          showClaudeAlert("Import Failed", "No valid message turns found in the file. Check formatting (requires '## User' or '## Claude' headers).");
          return;
        }

        // Display Split configuration modal for imported turns
        const storage = await new Promise(res => chrome.storage.local.get({ 
          verbatimMessageCount: 3,
          verbatimAll: false
        }, res));
        const defaultCount = storage.verbatimMessageCount ?? 3;
        const defaultVerbatimAll = storage.verbatimAll ?? false;
        const totalCount = messages.length;
        const defaultVal = Math.min(defaultCount, Math.min(10, totalCount));

        const contentDiv = document.createElement('div');
        contentDiv.style.display = 'flex';
        contentDiv.style.flexDirection = 'column';
        contentDiv.style.gap = '12px';

        const desc = document.createElement('p');
        desc.className = 'text-text-200';
        desc.textContent = `Choose how to import the ${totalCount} conversation turns from "${file.name}".`;
        contentDiv.appendChild(desc);

        // Verbatim Section
        const verbatimSection = document.createElement('div');
        verbatimSection.style.display = 'flex';
        verbatimSection.style.flexDirection = 'column';
        verbatimSection.style.gap = '8px';
        verbatimSection.style.marginTop = '4px';

        const { container: summarizeToggleRow, input: summarizeToggleInput } = createClaudeToggle(
          'Summarize earlier history',
          !(defaultVerbatimAll ?? false)
        );
        verbatimSection.appendChild(summarizeToggleRow);

        const sliderContainer = document.createElement('div');
        sliderContainer.style.display = !(defaultVerbatimAll ?? false) ? 'block' : 'none';
        sliderContainer.style.marginTop = '8px';

        const sliderLabelRow = document.createElement('div');
        sliderLabelRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;';

        const sliderLabel = document.createElement('span');
        sliderLabel.className = CLAUDE_CLASSES.LABEL;
        sliderLabel.style.margin = '0';
        sliderLabel.style.display = 'inline-flex';
        sliderLabel.style.alignItems = 'center';
        sliderLabel.style.gap = '4px';
        sliderLabel.textContent = 'Verbatim messages:';

        const infoIcon = document.createElement('span');
        infoIcon.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: hsl(var(--text-300)); cursor: help; display: block;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        `;
        sliderLabel.appendChild(infoIcon);
        sliderLabelRow.appendChild(sliderLabel);

        if (typeof createClaudeTooltip === 'function') {
          createClaudeTooltip(infoIcon, 'Recent messages copied exactly word-for-word. Older turns are summarized to save context tokens.');
        }

        const previewSpan = document.createElement('span');
        previewSpan.style.cssText = 'font-size: 12px; color: hsl(var(--text-300)); font-weight: 500;';
        sliderLabelRow.appendChild(previewSpan);
        sliderContainer.appendChild(sliderLabelRow);

        const splitSlider = createClaudeSlider(null, defaultVal, {
          min: 0,
          max: Math.min(10, totalCount),
          step: 1,
          showLabels: false,
          suffix: ''
        });

        sliderContainer.appendChild(splitSlider.container);
        verbatimSection.appendChild(sliderContainer);
        contentDiv.appendChild(verbatimSection);

        const updatePreview = (sliderVal) => {
          const recentCount = sliderVal;
          const earlyCount = totalCount - recentCount;
          previewSpan.textContent = `${recentCount} of ${totalCount} (${earlyCount} summarized)`;
        };

        summarizeToggleInput.addEventListener('change', (e) => {
          const isSummarizing = e.target.checked;
          sliderContainer.style.display = isSummarizing ? 'block' : 'none';
          updatePreview(isSummarizing ? splitSlider.getValue() : totalCount);
        });

        splitSlider.input.addEventListener('change', () => {
          updatePreview(splitSlider.getValue());
        });
        updatePreview(summarizeToggleInput.checked ? splitSlider.getValue() : totalCount);

        const modal = new ClaudeModal('Import Chat History', contentDiv);
        modal.addCancel('Cancel');
        
        modal.addConfirm('Import into Active Tab', async (btn) => {
          const isSummarizing = summarizeToggleInput.checked;
          const isAll = !isSummarizing;
          const recentCount = isSummarizing ? splitSlider.getValue() : totalCount;
          const boundaryIndex = Math.max(0, totalCount - recentCount);

          // Save preference
          chrome.storage.local.set({ 
            verbatimAll: isAll,
            verbatimMessageCount: isSummarizing ? recentCount : defaultCount
          });
          
          const earlyMessages = messages.slice(0, boundaryIndex);
          const recentMessages = messages.slice(boundaryIndex);

          const earlyText = compileMessagesToMarkdown(earlyMessages);
          const recentText = compileMessagesToMarkdown(recentMessages);

          // Get active composer
          const composer = document.querySelector('[contenteditable="true"]');
          if (!composer) {
            showClaudeAlert("Import Error", "Could not locate the composer chatbox in the active tab.");
            return;
          }

          let finalPrompt = '';
          if (earlyText || recentText) {
            finalPrompt += `[System Context - Imported Conversation History]\n`;
            finalPrompt += `Below is the history of the conversation so far. Please review it carefully to maintain continuity.\n\n`;
            
            if (earlyText) {
              finalPrompt += `=== CONVERSATION HISTORY (SUMMARIZED) ===\n${earlyText}\n\n`;
            }
            if (recentText) {
              finalPrompt += `=== RECENT TURNS (VERBATIM) ===\n${recentText}\n\n`;
            }
            finalPrompt += `=========================================\n\n`;
          }
          finalPrompt += `Please review the context above. Confirm by stating: "Context loaded. Let's resume our conversation."`;

          composer.focus();
          document.execCommand('insertText', false, finalPrompt);

          composer.dispatchEvent(new Event('input', { bubbles: true }));
          composer.dispatchEvent(new Event('change', { bubbles: true }));

          console.log("[SessionMigrator] Imported context injected into active composer.");
        });

        modal.show();

      } catch (err) {
        console.error("[SessionMigrator] Import failed:", err);
        showClaudeAlert("Import Failed", err.message);
      } finally {
        document.body.removeChild(input);
      }
    };
    reader.readAsText(file);
  });

  input.click();
}


// ── Step 34: Usage Limit MutationObserver ─────────────────────────────────────
//
// Watches the main conversation container for Claude's "Usage limit reached"
// banner. When detected, calls onUsageLimitDetected() which Step 35 will
// expand into the full migration modal flow.

/** Prevent duplicate triggers within a single page load. */
let usageLimitTriggered = false;

/**
 * True while the send button has been replaced by the migrate trigger.
 * Prevents double-activation on repeated limit detections.
 */
let sendInterceptActive = false;

/** Cleanup function that restores the send button to its original state. */
let sendInterceptCleanup = null;

/**
 * Checks if the given node resides inside a message turn block in the chat history.
 */
function isInsideMessageBubble(node) {
  const selectors = [
    "[data-testid='user-message']",
    ".font-claude-response",
    "[data-testid*='message']",
    "[data-message-id]",
    "[class*='conversation-message']",
    "[class*='message_']",
    "article[class*='message']",
    "section[class*='message']",
    "[data-epitaxy-entry]"
  ];
  return selectors.some(selector => node.closest(selector));
}

/**
 * Returns true if the given DOM node (or its subtree) contains any of
 * Claude's known usage-limit warning phrases.
 * The length check (> 15 chars) avoids false positives on tiny text nodes.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function nodeContainsLimitText(node) {
  if (!(node instanceof HTMLElement)) return false;

  // Exclude inputs, textareas, contenteditable elements, and their descendants
  // to avoid false positives from user input or injected context.
  if (node.closest('[contenteditable="true"]') || node.closest('textarea') || node.closest('input')) {
    return false;
  }

  // Exclude message history bubbles to avoid re-triggering on context messages
  if (isInsideMessageBubble(node)) {
    return false;
  }

  const text = node.innerText || node.textContent || '';
  // Match phrases Claude uses for both 5-hour limit and inline/popup notifications
  return /usage limit|rate.?limit|limit.?reached|you'?ve reached your|message limit|out of.*messages|out of free messages/i
    .test(text) && text.trim().length > 15;
}

/**
 * Scans the active profile statistics inside local storage to determine
 * if a usage quota limit (100% or greater) is reached.
 */
function checkUsageLimitFromStorage() {
  chrome.storage.local.get({ activeProfile: null, profiles: [], lastProfileSwitchTime: 0 }, (data) => {
    if (chrome.runtime?.id) {
      const switchTime = data.lastProfileSwitchTime || 0;
      if (Date.now() - switchTime < 8000) {
        console.log('[SessionMigrator] Skipping limit check: profile switched recently.');
        // Clear active send intercept if it was active
        if (sendInterceptActive) {
          if (sendInterceptCleanup) {
            sendInterceptCleanup();
          } else {
            sendInterceptActive = false;
          }
        }
        activeProfileUsage = 0;
        return;
      }

      if (data.activeProfile) {
        const active = data.profiles.find(p => p.label === data.activeProfile);
        activeProfileUsage = active ? (active.lastKnownUsage ?? 0) : 0;
      } else {
        activeProfileUsage = 0;
      }

      if (activeProfileUsage >= 100) {
        console.log(`[SessionMigrator] Quota limit detected from storage usage (${activeProfileUsage}%).`);
        onUsageLimitDetected();
        
        // Also look for the dialog in the DOM to inject our Switch button in case it's there
        const dialogEl = findLimitDialog();
        if (dialogEl) {
          injectIntoLimitDialog(dialogEl);
        }
      } else {
        // Clear limit triggers and intercept if active profile is under quota
        usageLimitTriggered = false;
        if (sendInterceptActive) {
          console.log('[SessionMigrator] Clearing active send intercept (usage under 100%).');
          if (sendInterceptCleanup) {
            sendInterceptCleanup();
          } else {
            sendInterceptActive = false;
          }
        }
      }
    }
  });
}

/**
 * Traverses or queries the document to find Claude's native "Upgrade to keep chatting" limit popup.
 */
function findLimitDialog() {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const dialog of dialogs) {
    const h1 = dialog.querySelector('h1');
    if (h1 && (h1.textContent?.includes('Upgrade to keep chatting') || h1.textContent?.includes('message limit'))) {
      return dialog;
    }
    const text = dialog.textContent || '';
    if (text.includes('You hit your 5-hour message limit') || text.includes('Upgrade to keep chatting')) {
      return dialog;
    }
  }
  return null;
}

/**
 * Searches for the primary button row inside the native rate limit dialog.
 */
function findDialogButtonRow(dialogEl) {
  const buttons = Array.from(dialogEl.querySelectorAll('button'));
  const notNowBtn = buttons.find(b => b.textContent?.trim() === 'Not now');
  if (notNowBtn) {
    return notNowBtn.parentElement;
  }
  const explorePlansBtn = buttons.find(b => b.textContent?.trim() === 'Explore plans');
  if (explorePlansBtn) {
    return explorePlansBtn.parentElement;
  }
  return dialogEl.querySelector('.flex-col-reverse') || dialogEl.querySelector('div.gap-2');
}

/**
 * Injects the "Migrate Chat →" button directly into Claude's native popup,
 * customizing the title and description to direct the user to the migration tool.
 */
function injectIntoLimitDialog(dialogEl) {
  // Customize the dialog's header and paragraph text to match our tool context
  const h1 = dialogEl.querySelector('h1');
  if (h1 && !h1.dataset.csmCustomized) {
    h1.textContent = 'Usage Limit Reached';
    h1.dataset.csmCustomized = 'true';
  }
  
  const paragraphs = dialogEl.querySelectorAll('p');
  if (paragraphs.length > 0 && !paragraphs[0].dataset.csmCustomized) {
    paragraphs[0].textContent = 'You hit your 5-hour message limit. You can migrate your chat history to another account to continue your conversation.';
    paragraphs[0].dataset.csmCustomized = 'true';
  }

  // Hide the subsequent paragraphs (e.g., "Plus, get more ways to use Claude:")
  if (paragraphs.length > 1) {
    for (let i = 1; i < paragraphs.length; i++) {
      paragraphs[i].style.display = 'none';
    }
  }

  // Hide the grid showing feature links/images
  const relativeGrid = dialogEl.querySelector('a[href*="/product/"], a[href*="claude.com/product/"], a[href*="excel"], a[href*="chrome"]')?.closest('.relative') || dialogEl.querySelector('.relative');
  if (relativeGrid && !relativeGrid.dataset.csmCustomized) {
    relativeGrid.style.display = 'none';
    relativeGrid.dataset.csmCustomized = 'true';
  }

  const buttonRow = findDialogButtonRow(dialogEl);
  if (!buttonRow) {
    console.warn('[SessionMigrator] Could not find button row in native dialog.');
    return;
  }
  
  if (buttonRow.querySelector('#csm-native-dialog-switch-btn')) return;
  
  console.log('[SessionMigrator] Injecting "Migrate Chat" button into native dialog.');
  
  const switchBtn = document.createElement('button');
  switchBtn.type = 'button';
  switchBtn.id = 'csm-native-dialog-switch-btn';
  switchBtn.setAttribute('data-cds', 'Button');
  switchBtn.className = 'cds-reset group/btn relative isolate inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none cursor-[var(--cds-cursor-interactive)] aria-disabled:cursor-default data-[disabled]:cursor-default border-0 outline-none rounded h-control font-sans text-body font-medium transition-shadow duration-fast focus-visible:shadow-focus text-primary aria-pressed:text-accent px-md';
  
  const bgSpan = document.createElement('span');
  bgSpan.setAttribute('aria-hidden', 'true');
  bgSpan.className = 'absolute -z-[1] rounded-[inherit] transition-colors duration-fast group-focus-visible/btn:shadow-[inset_0_0_0_1px_var(--cds-page-bg)] bg-fill-secondary group-hover/btn:bg-fill-secondary-hover group-aria-expanded/btn:bg-fill-ghost-hover inset-0 group-aria-pressed/btn:bg-accent group-hover/btn:group-aria-pressed/btn:bg-accent cds-btn-squish shadow-field';
  
  const textSpan = document.createElement('span');
  textSpan.className = 'inline-flex items-center gap-1';
  textSpan.textContent = 'Migrate Chat \u2192'; // Migrate Chat →
  
  switchBtn.appendChild(bgSpan);
  switchBtn.appendChild(textSpan);
  
  switchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMigrationModal();
  });
  
  const notNowBtn = Array.from(buttonRow.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Not now');
  if (notNowBtn) {
    buttonRow.insertBefore(switchBtn, notNowBtn);
  } else {
    buttonRow.prepend(switchBtn);
  }
}

/**
 * Called once the usage limit dialog or status is confirmed.
 * Logs the event and sets a 60-second cooldown to prevent repeated triggers.
 */
function onUsageLimitDetected() {
  if (usageLimitTriggered) return;
  usageLimitTriggered = true;

  console.log('[SessionMigrator] ⚠ Usage limit detected.');

  // Cooldown: allow re-detection 60 s later (e.g. after a page reload)
  setTimeout(() => { usageLimitTriggered = false; }, 60_000);

  // Transform the send button into the migration trigger so the user
  // can finish reading, type their follow-up, then migrate on their own terms.
  activateSendButtonMigration();
}

/**
 * Returns Claude's send button, trying several selectors for resilience.
 */
function findSendButton() {
  const custom = document.querySelector('[data-csm-send-btn="true"]');
  if (custom) return custom;

  return document.querySelector('button[aria-label="Send Message"]')
      || document.querySelector('button[aria-label="Send message"]')
      || document.querySelector('[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Send"]')
      || document.querySelector('button[aria-label*="Migrate"]')
      || null;
}

/**
 * Returns the current text from Claude's contenteditable composer input.
 */
function getComposerText() {
  const editor = document.querySelector('[contenteditable="true"]');
  return editor?.innerText?.trim() || '';
}

/**
 * Persists the user's pending message to both a window global and chrome.storage.local
 * for cross-tab auto-send after account switch.
 */
async function savePendingMessage(text) {
  const payload = { text, savedAt: Date.now() };
  window.csmPendingMessage = payload;
  await new Promise(resolve =>
    chrome.storage.local.set({ pendingMessage: payload }, resolve)
  );
  console.log('[SessionMigrator] Pending message saved:', text.slice(0, 60));
}

/**
 * Top-level action that handles prompt saving and launches account switching.
 */
async function doMigrate() {
  const modalEl = document.getElementById('csm-migration-modal');
  if (modalEl && modalEl.style.display !== 'none') return;
  const text = getComposerText();
  if (text) await savePendingMessage(text);
  showMigrationModal();
}

/**
 * Shared event handler for mouse/touch events targeting the transformed send button.
 * Uses capture phase to intercept and completely block standard triggers from React.
 */
const blockSendEvents = (e) => {
  if (Date.now() - lastProfileSwitchTime < 8000) return;
  if (!sendInterceptActive || activeProfileUsage < 100) return;
  const sendBtn = findSendButton();
  if (sendBtn && (e.target === sendBtn || sendBtn.contains(e.target))) {
    e.stopPropagation();
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' || e.type === 'touchend') {
      doMigrate();
    }
  }
};

document.addEventListener('click', blockSendEvents, true);
document.addEventListener('mousedown', blockSendEvents, true);
document.addEventListener('mouseup', blockSendEvents, true);
document.addEventListener('touchstart', blockSendEvents, true);
document.addEventListener('touchend', blockSendEvents, true);

/**
 * Global capture phase keyboard interceptor to block Enter key execution
 * when the account has reached its limit, saving the text instead.
 */
document.addEventListener('keydown', (e) => {
  if (Date.now() - lastProfileSwitchTime < 8000) return;
  if (!sendInterceptActive || activeProfileUsage < 100) return;
  
  if (e.key === 'Enter' && !e.shiftKey) {
    const target = e.target;
    if (target && (target.getAttribute('contenteditable') === 'true' || target.closest('[contenteditable="true"]'))) {
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();
      doMigrate();
    }
  }
}, true);

let originalSendBtnHTML = '';
let originalSendBtnLabel = '';

/**
 * Periodically verifies and applies the Migrate icon to the native send button
 * if the user has hit their quota limit.
 */
function ensureSendButtonMigrateIcon() {
  if (!sendInterceptActive) return;
  const sendBtn = findSendButton();
  if (!sendBtn) return;
  
  if (!sendBtn.dataset.csmSendBtn) {
    sendBtn.setAttribute('data-csm-send-btn', 'true');
  }
  
  const label = sendBtn.getAttribute('aria-label') || '';
  if (!label.includes('Migrate Chat')) {
    originalSendBtnHTML = sendBtn.innerHTML;
    originalSendBtnLabel = label;
    sendBtn.setAttribute('aria-label', 'Migrate Chat — usage limit reached');
    sendBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"
           viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">
        <polyline points="17 1 21 5 17 9"/>
        <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
        <polyline points="7 23 3 19 7 15"/>
        <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
      </svg>
    `;
  }
}

/**
 * Activates the send button migration intercept mode.
 */
function activateSendButtonMigration() {
  if (sendInterceptActive) return;
  sendInterceptActive = true;
  ensureSendButtonMigrateIcon();

  sendInterceptCleanup = () => {
    sendInterceptActive = false;
    sendInterceptCleanup = null;
    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.removeAttribute('data-csm-send-btn');
      if (originalSendBtnHTML) {
        sendBtn.innerHTML = originalSendBtnHTML;
      }
      if (originalSendBtnLabel) {
        sendBtn.setAttribute('aria-label', originalSendBtnLabel);
      } else {
        sendBtn.removeAttribute('aria-label');
      }
    }
    originalSendBtnHTML = '';
    originalSendBtnLabel = '';
  };
}

function showLimitToast() {
  // Remove any stale toast from a previous trigger
  document.getElementById('csm-limit-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'csm-limit-toast';
  Object.assign(toast.style, {
    position  : 'fixed',
    bottom    : '90px',             // sits above the chat input box
    left      : '50%',
    transform : 'translateX(-50%)',
    zIndex    : '9999',
    background: 'hsl(var(--bg-100))',
    border    : '1px solid hsl(var(--border-300))',
    borderLeft: '3px solid #e57373',  // red accent to signal urgency
    borderRadius: '8px',
    padding   : '10px 14px',
    display   : 'flex',
    alignItems: 'center',
    gap       : '12px',
    boxShadow : '0 4px 16px rgba(0,0,0,0.18)',
    minWidth  : '300px',
    maxWidth  : '440px',
    color     : 'hsl(var(--text-200))'
  });
  toast.className = 'session-migrator-toast'; // uses fade-up animation from tracker-styles.css

  // Warning icon
  const icon = document.createElement('span');
  icon.textContent = '⚠️';
  icon.style.cssText = 'font-size:18px; flex-shrink:0;';

  // Message text
  const msg = document.createElement('div');
  msg.style.flex = '1';
  msg.innerHTML =
    '<strong style="color:hsl(var(--text-100)); font-size:13px;">Usage limit reached</strong><br>'
    + '<span style="color:hsl(var(--text-400)); font-size:12px;">'
    + 'Finish reading, then click <strong>Migrate</strong> in the toolbar — or switch now.'
    + '</span>';

  // 'Switch Now' shortcut button
  const switchBtn = document.createElement('button');
  switchBtn.textContent = 'Switch Now';
  switchBtn.className = CLAUDE_CLASSES.BTN_PRIMARY;
  switchBtn.style.cssText = 'font-size:12px; height:28px; padding:0 10px; flex-shrink:0;';
  switchBtn.addEventListener('click', () => {
    toast.remove();
    showMigrationModal();
  });

  // × dismiss button
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.style.cssText =
    'background:none; border:none; cursor:pointer; font-size:18px; '
    + 'color:hsl(var(--text-400)); padding:0; flex-shrink:0; line-height:1;';
  closeBtn.addEventListener('click', () => toast.remove());

  toast.append(icon, msg, switchBtn, closeBtn);
  document.body.appendChild(toast);

  // Auto-dismiss after 12 s; hover pauses the timer
  let timer = setTimeout(() => toast.remove(), 12_000);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => {
    timer = setTimeout(() => toast.remove(), 3_000);
  });
}


//
// Reads saved profiles from chrome.storage.local, then shows a native
// ClaudeModal with a searchable profile dropdown.
//
// Flow:
//   1. Load profiles + activeProfile from storage (async)
//   2. Filter out the current account — no point switching to the same one
//   3. Show dropdown with each profile's usage % so user can pick the best option
//   4. On "Switch Account": call background switchProfile action
//   5. Background swaps cookies and reloads all claude.ai tabs

/**
 * Displays the usage-limit migration modal.
 * Called automatically by onUsageLimitDetected(); can also be called manually.
 */
/**
 * Displays the usage-limit migration modal.
 * Called automatically by onUsageLimitDetected(); can also be called manually.
 */
async function showMigrationModal() {
  const existing = document.getElementById('csm-migration-modal');
  if (existing) {
    if (existing.style.display !== 'none') {
      console.log('[SessionMigrator] Migration modal is already visible, ignoring duplicate trigger.');
      return;
    }
    existing.remove();
  }

  // ── Load profiles and cached models from storage ───────────────────────────
  const storage = await new Promise(resolve =>
    chrome.storage.local.get({
      profiles: [],
      activeProfile: null,
      verbatimMessageCount: 3,
      verbatimAll: false,
      cachedModels: []
    }, resolve)
  );
  const { profiles, activeProfile, verbatimMessageCount, verbatimAll, cachedModels } = storage;

  // Profiles the user can switch TO (exclude the already-active one)
  const targets = profiles.filter(p => p.label !== activeProfile);

  // ── Build modal content ───────────────────────────────────────────────────
  const contentDiv = document.createElement('div');
  contentDiv.style.display = 'flex';
  contentDiv.style.flexDirection = 'column';
  contentDiv.style.gap = '12px';

  // ── No-profile fallback ───────────────────────────────────────────────────
  if (targets.length === 0) {
    const desc = document.createElement('p');
    desc.className = 'text-text-200';
    desc.textContent =
      'Your usage limit has been reached, but no other account profiles are saved yet. '
      + 'Open the extension popup to add another Claude account, then come back.';
    contentDiv.appendChild(desc);

    const modal = new ClaudeModal('\u26a0 Usage Limit Reached', contentDiv);
    modal.backdrop.id = 'csm-migration-modal';
    modal.addButton('OK', 'primary');
    modal.show();
    return;
  }

  // ── Normal flow: profile picker ───────────────────────────────────────────
  const profileRow = document.createElement('div');
  profileRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px;';

  const selectLabel = document.createElement('label');
  selectLabel.className = CLAUDE_CLASSES.LABEL;
  selectLabel.style.margin = '0';
  selectLabel.style.whiteSpace = 'nowrap';
  selectLabel.textContent = 'Switch to account:';
  profileRow.appendChild(selectLabel);

  // Each option shows the profile label + usage % so the user can pick the
  // account with the most remaining quota at a glance
  const profileOptions = targets.map(p => ({
    value: p.label,
    label: typeof p.lastKnownUsage === 'number'
      ? `(${p.lastKnownUsage}%) ${p.label}`
      : p.label
  }));

  // createClaudeSearchableSelect is provided by helpers/claude-styles.js
  const profileSelect = createClaudeSearchableSelect(
    profileOptions,
    profileOptions[0]?.value  // pre-select the first (likely lowest usage) option
  );
  profileSelect.style.width = '200px';
  profileSelect.style.flexShrink = '0';
  profileRow.appendChild(profileSelect);
  contentDiv.appendChild(profileRow);

  // ── Preferred Model & Effort Selector Row ──────────────────────────────────
  const selectRow = document.createElement('div');
  selectRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 4px;';

  const modelCol = document.createElement('div');
  modelCol.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
  const modelSelectLabel = document.createElement('label');
  modelSelectLabel.className = CLAUDE_CLASSES.LABEL;
  modelSelectLabel.textContent = 'Preferred model:';
  modelCol.appendChild(modelSelectLabel);

  const defaultModels = [
    { value: 'claude-fable-5', label: 'Fable 5' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    { value: 'claude-opus-3', label: 'Opus 3' }
  ];

  // Merge default models and cachedModels, preserving uniqueness and filtering out stale/fake models
  let modelOptions = [...defaultModels];
  if (cachedModels && cachedModels.length > 0) {
    for (const cached of cachedModels) {
      const lblLower = cached.label.toLowerCase();
      if (lblLower.includes("choice") || lblLower.includes("extended") || lblLower.includes("default")) {
        continue;
      }
      if (!modelOptions.some(opt => opt.value === cached.value)) {
        modelOptions.push(cached);
      }
    }
  }
  
  // Determine active model from page
  const activeModelName = getActiveModelName();
  let defaultModelValue = modelOptions[0]?.value || '';
  
  const matched = modelOptions.find(opt => {
    const text = opt.label.toLowerCase();
    const activeLower = activeModelName.toLowerCase();
    return text.includes(activeLower) || activeLower.includes(text);
  });
  if (matched) {
    defaultModelValue = matched.value;
  } else if (activeModelName) {
    // Dynamically prepend active model if not in the cached list
    const activeModelVal = 'claude-' + activeModelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const dynamicOpt = { value: activeModelVal, label: activeModelName };
    modelOptions.unshift(dynamicOpt);
    defaultModelValue = activeModelVal;
  }

  const modelSelect = createClaudeSelect(modelOptions, defaultModelValue);
  modelCol.appendChild(modelSelect);

  const effortCol = document.createElement('div');
  effortCol.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
  const effortSelectLabel = document.createElement('label');
  effortSelectLabel.className = CLAUDE_CLASSES.LABEL;
  effortSelectLabel.textContent = 'Preferred Effort level:';
  effortCol.appendChild(effortSelectLabel);

  const effortOptions = [
    { value: 'None', label: 'None (Disabled)' },
    { value: 'Low', label: 'Low' },
    { value: 'Medium', label: 'Medium' },
    { value: 'High', label: 'High' },
    { value: 'Max', label: 'Max' }
  ];

  const currentEffort = await getEffortLevel();
  const effortSelect = createClaudeSelect(effortOptions, currentEffort || 'None');
  effortCol.appendChild(effortSelect);

  selectRow.appendChild(modelCol);
  selectRow.appendChild(effortCol);
  contentDiv.appendChild(selectRow);

  // ── Toggle Controls (Thinking & Summarization side-by-side) ─────────────────
  const togglesRow = document.createElement('div');
  togglesRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px;';

  const currentThinking = await getThinkingState();
  const { container: thinkingToggleRow, input: thinkingToggleInput } = createClaudeToggle(
    'Enable thinking process',
    currentThinking
  );
  const thinkingLabel = thinkingToggleRow.querySelector('span');
  if (thinkingLabel) {
    thinkingLabel.style.fontSize = '13px';
  }
  togglesRow.appendChild(thinkingToggleRow);

  const { container: summarizeToggleRow, input: summarizeToggleInput } = createClaudeToggle(
    'Summarize earlier history',
    !(verbatimAll ?? false)
  );
  const summarizeLabel = summarizeToggleRow.querySelector('span');
  if (summarizeLabel) {
    summarizeLabel.style.fontSize = '13px';
  }
  togglesRow.appendChild(summarizeToggleRow);

  contentDiv.appendChild(togglesRow);

  // ── Verbatim Slider (shown below toggles if summarizing is enabled) ────────
  const sliderContainer = document.createElement('div');
  sliderContainer.style.display = !(verbatimAll ?? false) ? 'block' : 'none';
  sliderContainer.style.marginTop = '8px';

  const sliderLabelRow = document.createElement('div');
  sliderLabelRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;';

  const sliderLabel = document.createElement('span');
  sliderLabel.className = CLAUDE_CLASSES.LABEL;
  sliderLabel.style.margin = '0';
  sliderLabel.style.display = 'inline-flex';
  sliderLabel.style.alignItems = 'center';
  sliderLabel.style.gap = '4px';
  sliderLabel.textContent = 'Verbatim messages:';

  const infoIcon = document.createElement('span');
  infoIcon.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: hsl(var(--text-300)); cursor: help; display: block;">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
  `;
  sliderLabel.appendChild(infoIcon);
  sliderLabelRow.appendChild(sliderLabel);

  if (typeof createClaudeTooltip === 'function') {
    createClaudeTooltip(infoIcon, 'Recent messages copied exactly word-for-word. Older turns are summarized to save context tokens.');
  }

  const previewSpan = document.createElement('span');
  previewSpan.style.cssText = 'font-size: 12px; color: hsl(var(--text-300)); font-weight: 500;';
  sliderLabelRow.appendChild(previewSpan);
  sliderContainer.appendChild(sliderLabelRow);

  const nodes = findMessageNodes();
  const totalMessages = nodes.length;
  const defaultVal = Math.min(verbatimMessageCount ?? 3, Math.min(10, totalMessages));

  const splitSlider = createClaudeSlider(null, defaultVal, {
    min: 0,
    max: Math.min(10, totalMessages),
    step: 1,
    showLabels: false,
    suffix: ''
  });
  
  sliderContainer.appendChild(splitSlider.container);
  contentDiv.appendChild(sliderContainer);

  // ── Follow-up Message Preview & Editor ──────────────────────────────────────
  const msgLabel = document.createElement('label');
  msgLabel.className = CLAUDE_CLASSES.LABEL;
  msgLabel.textContent = 'Follow-up message (preview/edit):';
  msgLabel.style.marginTop = '8px';
  contentDiv.appendChild(msgLabel);

  const composerText = getComposerText();
  const msgTextarea = document.createElement('textarea');
  msgTextarea.className = CLAUDE_CLASSES.INPUT;
  msgTextarea.placeholder = 'Type your follow-up message to carry over...';
  msgTextarea.value = composerText;
  msgTextarea.style.cssText = `
    width: 100%;
    min-height: 48px;
    max-height: 200px;
    resize: vertical;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    padding: 6px 10px;
  `;
  contentDiv.appendChild(msgTextarea);

  const updatePreview = (sliderVal) => {
    const recentCount = sliderVal;
    const earlyCount = totalMessages - recentCount;
    previewSpan.textContent = `${recentCount} of ${totalMessages} (${earlyCount} summarized)`;
  };

  summarizeToggleInput.addEventListener('change', (e) => {
    const isSummarizing = e.target.checked;
    sliderContainer.style.display = isSummarizing ? 'block' : 'none';
    updatePreview(isSummarizing ? splitSlider.getValue() : totalMessages);
  });

  splitSlider.input.addEventListener('change', () => {
    updatePreview(splitSlider.getValue());
  });
  updatePreview(summarizeToggleInput.checked ? splitSlider.getValue() : totalMessages);

  // ── Modal buttons ─────────────────────────────────────────────────────────
  const modal = new ClaudeModal('Migrate Chat', contentDiv);
  modal.backdrop.id = 'csm-migration-modal';

  // Dismiss: close without doing anything
  modal.addCancel('Dismiss');

  // Switch: send switchProfile to background, which swaps cookies + reloads tabs
  modal.addConfirm('Switch Account', async (btn) => {
    const selectedLabel  = profileSelect.value;
    const selectedProfile = profiles.find(p => p.label === selectedLabel);
    const selectedModel = modelSelect.value;
    const isSummarizing = summarizeToggleInput.checked;
    const isAll = !isSummarizing;
    const sliderVal = isSummarizing ? splitSlider.getValue() : totalMessages;
    const finalMessageText = msgTextarea.value.trim();

    if (!selectedProfile) {
      showClaudeAlert('Error', 'Selected profile not found in storage. Try reloading the page.');
      return false; // keep modal open
    }

    // Save preferences back to storage
    chrome.storage.local.set({ 
      verbatimMessageCount: isSummarizing ? splitSlider.getValue() : verbatimMessageCount,
      verbatimAll: isAll
    });

    // Save final edited message to pendingMessage
    if (finalMessageText) {
      await savePendingMessage(finalMessageText);
    } else {
      await chrome.storage.local.set({ pendingMessage: null });
    }

    // Show a loading state while the background worker switches cookies
    btn.textContent = 'Migrating\u2026';
    btn.disabled = true;

    try {
      // Scrape and compile history based on the count value
      const splitData = scrapeAndSplitChat(sliderVal);
      
      const selectedEffort = effortSelect.value;
      const migrationPayload = {
        state: 'ready_to_inject',
        originalTabId: null,
        earlyHistoryText: splitData.earlyHistoryText,
        recentHistoryText: splitData.recentHistoryText,
        targetProfile: selectedLabel,
        targetModel: selectedModel,
        targetEffort: selectedEffort,
        thinkingEnabled: thinkingToggleInput.checked,
        timestamp: Date.now()
      };

      // Save migration payload for reload injection
      await new Promise(res => chrome.storage.local.set({ migration: migrationPayload }, res));

      // Switch profile via background
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action : 'switchProfile',
            label  : selectedProfile.label,
            cookies: selectedProfile.cookies
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response?.success) {
              reject(new Error(response?.error || 'Profile switch failed.'));
            } else {
              resolve();
            }
          }
        );
      });

      // Clear the send intercept and reset profile usage immediately before reload
      if (sendInterceptCleanup) {
        sendInterceptCleanup();
      } else {
        sendInterceptActive = false;
      }
      activeProfileUsage = 0;

      // The background worker reloads all claude.ai tabs after a successful switch,
      // so this page will navigate away automatically — no need to close the modal.

    } catch (err) {
      console.error('[SessionMigrator] Profile switch failed:', err);
      // Reset button so user can retry; keep modal open
      btn.textContent = 'Switch Account';
      btn.disabled = false;
      showClaudeAlert('Switch Failed', err.message);
      return false; // prevent ClaudeModal from auto-closing on error
    }
  });

  modal.show();
}

/**
 * Initialises a MutationObserver on the main conversation container.
 * Also performs a one-time scan of the existing DOM in case the banner
 * is already visible when the content script is injected.
 *
 * Uses childList + subtree to catch both direct and deeply nested additions.
 * Targets <main> rather than document.body for better performance on
 * Claude's heavy React tree.
 */
/**
 * Scans a given DOM element and its children to detect limit dialogs or banner warning phrases.
 */
function scanNodeForLimitElements(node) {
  if (Date.now() - lastProfileSwitchTime < 8000) return;
  if (!(node instanceof HTMLElement)) return;
  
  // 1. Check if the node is or contains the limit dialog popup
  const isDialog = node.getAttribute('role') === 'dialog' || node.querySelector('[role="dialog"]');
  if (isDialog) {
    const dialogEl = node.getAttribute('role') === 'dialog' ? node : node.querySelector('[role="dialog"]');
    if (dialogEl) {
      const h1 = dialogEl.querySelector('h1');
      const hasLimitText = (h1 && (h1.textContent?.includes('Upgrade to keep chatting') || h1.textContent?.includes('message limit')))
        || dialogEl.textContent?.includes('You hit your 5-hour message limit')
        || dialogEl.textContent?.includes('You are out of free messages');
      
      if (hasLimitText) {
        console.log('[SessionMigrator] Native limit dialog detected.');
        onUsageLimitDetected();
        injectIntoLimitDialog(dialogEl);
        return;
      }
    }
  }

  // 2. Check if the node is or contains an inline limit warning banner
  if (nodeContainsLimitText(node)) {
    console.log('[SessionMigrator] Inline limit text detected.');
    onUsageLimitDetected();
  }
}

/**
 * Scans a newly added node for model dropdown options to dynamically cache the model list.
 */
function scanNodeForModelDropdown(node) {
  if (!node || typeof node.querySelectorAll !== 'function') return;

  const items = Array.from(node.querySelectorAll('[role="menuitem"], [role="option"], button, a'));
  
  if (node.matches && (node.matches('[role="menuitem"], [role="option"]') || node.tagName === 'BUTTON' || node.tagName === 'A')) {
    items.push(node);
  }

  const candidates = items.filter(el => {
    const text = el.textContent?.trim() || '';
    const textLower = text.toLowerCase();
    return (
      textLower.includes('sonnet') ||
      textLower.includes('haiku') ||
      textLower.includes('opus') ||
      textLower.includes('claude') ||
      textLower.includes('3.5') ||
      textLower.includes('3.7') ||
      textLower.includes('4.5') ||
      textLower.includes('4.6') ||
      textLower.includes('4.7') ||
      textLower.includes('4.8') ||
      textLower.includes('5') ||
      textLower.includes('fable') ||
      textLower.includes('max')
    ) && text.length < 60;
  });

  if (candidates.length > 1) {
    const models = candidates.map(el => {
      const text = el.textContent?.trim() || '';
      let val = '';
      const textLower = text.toLowerCase();
      
      if (textLower.includes('3.7') && textLower.includes('sonnet')) {
        val = 'claude-3-7-sonnet-latest';
      } else if (textLower.includes('3.5') && textLower.includes('sonnet')) {
        val = 'claude-3-5-sonnet-latest';
      } else if (textLower.includes('haiku')) {
        val = 'claude-3-5-haiku-latest';
      } else if (textLower.includes('opus')) {
        val = 'claude-3-opus-latest';
      } else {
        val = 'claude-' + textLower.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      }
      
      return { value: val, label: text };
    });

    const uniqueModels = [];
    const seen = new Set();
    for (const m of models) {
      if (m.value && !seen.has(m.value)) {
        seen.add(m.value);
        uniqueModels.push(m);
      }
    }

    if (uniqueModels.length > 1) {
      chrome.storage.local.set({ cachedModels: uniqueModels }, () => {
        console.log('[SessionMigrator] Cached models dynamically updated:', uniqueModels);
      });
    }
  }
}

/**
 * Dynamically injects the profile switcher into Claude's native user menu dropdown list as a sub-menu.
 */
function injectProfileSwitcherIntoUserMenu(node) {
  if (!node || typeof node.querySelectorAll !== 'function') return;

  const menuContainer = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]');
  if (!menuContainer) return;

  // Synchronous guard to prevent async race condition duplicate injections
  if (menuContainer.dataset.csmSwitcherInjected === 'true') return;
  menuContainer.dataset.csmSwitcherInjected = 'true';

  let logoutItem = menuContainer.querySelector('a[href*="logout"], [data-testid*="logout"]');
  if (!logoutItem) {
    const menuItems = Array.from(menuContainer.querySelectorAll('[role="menuitem"], button, a'));
    for (const item of menuItems) {
      const text = item.textContent?.trim() || "";
      if (/log\s*out|logout/i.test(text)) {
        logoutItem = item;
        break;
      }
    }
  }

  if (!logoutItem) {
    // Reset flag if logoutItem not found (menu might not be fully loaded yet)
    menuContainer.removeAttribute('data-csm-switcher-injected');
    return;
  }

  chrome.storage.local.get({ profiles: [], activeProfile: null }, (data) => {
    if (chrome.runtime.lastError) return;
    const { profiles, activeProfile } = data;
    
    if (profiles.length === 0) return;

    const nativeSeparator = menuContainer.querySelector('[role="separator"], [class*="separator"], [data-orientation="horizontal"]');
    const parent = logoutItem.parentElement;
    if (!parent) return;

    const nativeClass = logoutItem.className;

    // Create the "Switch Account" sub-menu trigger item
    const triggerItem = document.createElement('div');
    triggerItem.setAttribute('role', 'menuitem');
    triggerItem.setAttribute('aria-haspopup', 'menu');
    triggerItem.setAttribute('aria-expanded', 'false');
    triggerItem.className = `${nativeClass} justify-between data-[popup-open]:bg-fill-ghost-hover csm-user-menu-item csm-profile-trigger-btn`;
    triggerItem.style.cursor = 'pointer';
    
    triggerItem.innerHTML = `
      <span class="flex size-icon shrink-0 items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px; opacity: 0.85;">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      </span>
      <span class="min-w-0 flex-1 truncate">Switch Account</span>
      <span data-cds="Icon" class="-mr-1 shrink-0 text-muted" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-feature-settings: &quot;liga&quot; 0; font-optical-sizing: auto; font-style: normal; font-variation-settings: normal; line-height: 1; width: 1em; height: 1em; display: flex; align-items: center; justify-content: center; flex-shrink: 0; user-select: none; font-size: 16px; font-weight: 533.3;"></span>
    `;

    let subMenuEl = null;
    let wrapperEl = null;
    let closeTimeout = null;

    const closeSubMenu = () => {
      if (subMenuEl) {
        wrapperEl.remove();
        subMenuEl = null;
        wrapperEl = null;
      }
      triggerItem.removeAttribute('data-popup-open');
      triggerItem.setAttribute('aria-expanded', 'false');
      
      document.removeEventListener('click', onDocClick);
      menuContainer.removeEventListener('scroll', onParentScroll);
      window.removeEventListener('resize', onParentScroll);
    };

    const startCloseTimer = () => {
      if (closeTimeout) return;
      closeTimeout = setTimeout(() => {
        closeSubMenu();
        closeTimeout = null;
      }, 250);
    };

    const onDocClick = (e) => {
      if (subMenuEl && !wrapperEl.contains(e.target) && !triggerItem.contains(e.target)) {
        closeSubMenu();
      }
    };

    const onParentScroll = () => {
      closeSubMenu();
    };

    const openSubMenu = () => {
      if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
      }
      if (subMenuEl) return;

      const rect = triggerItem.getBoundingClientRect();
      
      wrapperEl = document.createElement('div');
      wrapperEl.className = 'z-popover';
      wrapperEl.style.position = 'fixed';
      wrapperEl.style.zIndex = '99999';
      
      // Calculate coordinates: align to the right of the trigger menu item with 4px gap
      const leftPos = rect.right + 4;
      const topPos = rect.top - 6;
      
      wrapperEl.style.left = `${leftPos}px`;
      wrapperEl.style.top = `${topPos}px`;

      subMenuEl = document.createElement('div');
      subMenuEl.className = 'cds-reset draggable-none relative flex flex-col min-w-[150px] max-w-[320px] rounded-card bg-surface-3 shadow-panel text-body text-primary outline-none';
      
      const scrollContainer = document.createElement('div');
      scrollContainer.className = 'min-h-0 overflow-y-auto rounded-[inherit] border-b-[length:var(--cds-ring-inner)] border-transparent p-1 scroll-pb-7';
      
      const groupEl = document.createElement('div');
      groupEl.setAttribute('role', 'group');

      profiles.forEach(p => {
        const isActive = p.label === activeProfile;
        const profileItem = document.createElement('div');
        profileItem.setAttribute('role', 'menuitemradio');
        profileItem.setAttribute('aria-checked', isActive ? 'true' : 'false');
        profileItem.className = 'cds-reset flex w-full items-center gap-xs compact:px-2 comfortable:px-2.5 py-[calc((var(--cds-h-control)-var(--cds-leading-body))/2)] rounded text-body select-none outline-none data-[disabled]:opacity-50 data-[disabled]:pointer-events-none text-primary data-[highlighted]:bg-fill-ghost-hover';
        profileItem.style.cursor = 'pointer';
        
        profileItem.innerHTML = `
          <span class="min-w-0 flex-1 truncate">
            <span class="block font-medium">${p.label}</span>
            ${typeof p.lastKnownUsage === 'number' 
              ? `<span class="block text-xs text-text-500 font-normal" style="margin-top: 1px;">${p.lastKnownUsage}% used</span>` 
              : ''}
          </span>
          <span class="ml-md flex shrink-0 items-center gap-xs">
            <span class="flex size-icon shrink-0 items-center justify-center -mr-1" style="color: var(--cds-fill-accent);">
              ${isActive 
                ? `<span data-cds="Icon" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-feature-settings: &quot;liga&quot; 0; font-optical-sizing: auto; font-style: normal; font-variation-settings: normal; line-height: 1; width: 1em; height: 1em; display: flex; align-items: center; justify-content: center; flex-shrink: 0; user-select: none; font-size: 20px; font-weight: 566.7;"></span>` 
                : ''}
            </span>
          </span>
        `;

        profileItem.addEventListener('mouseenter', () => {
          profileItem.setAttribute('data-highlighted', '');
        });
        profileItem.addEventListener('mouseleave', () => {
          profileItem.removeAttribute('data-highlighted');
        });

        profileItem.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          if (isActive) return;

          profileItem.style.opacity = '0.5';
          profileItem.style.pointerEvents = 'none';

          try {
            await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(
                {
                  action : 'switchProfile',
                  label  : p.label,
                  cookies: p.cookies
                },
                (response) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                  } else if (!response?.success) {
                    reject(new Error(response?.error || 'Profile switch failed.'));
                  } else {
                    resolve();
                  }
                }
              );
            });
            console.log('[SessionMigrator] Profile switch successful via user menu to:', p.label);
            closeSubMenu();
            document.body.click();
          } catch (err) {
            console.error('[SessionMigrator] Profile switch failed via user menu:', err);
            profileItem.style.opacity = '1';
            profileItem.style.pointerEvents = 'auto';
            if (typeof showClaudeAlert === 'function') {
              showClaudeAlert('Switch Failed', err.message);
            } else {
              alert('Profile switch failed: ' + err.message);
            }
          }
        });

        groupEl.appendChild(profileItem);
      });

      scrollContainer.appendChild(groupEl);
      
      const spacerEl = document.createElement('div');
      spacerEl.setAttribute('aria-hidden', 'true');
      spacerEl.className = 'pointer-events-none -mt-px h-px';
      scrollContainer.appendChild(spacerEl);
      
      subMenuEl.appendChild(scrollContainer);
      
      const bottomOverlay = document.createElement('div');
      bottomOverlay.setAttribute('aria-hidden', 'true');
      bottomOverlay.className = 'pointer-events-none absolute inset-x-0 bottom-0 h-7 rounded-b-[inherit] border-[length:var(--cds-ring-inner)] border-t-0 border-transparent bg-clip-padding bg-[linear-gradient(to_top,var(--cds-surface-popover),color-mix(in_oklab,var(--cds-surface-popover)_40%,transparent)_10px,transparent)] opacity-0 transition-opacity duration-fast';
      subMenuEl.appendChild(bottomOverlay);
      
      wrapperEl.appendChild(subMenuEl);

      wrapperEl.addEventListener('mouseenter', () => {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
          closeTimeout = null;
        }
      });

      wrapperEl.addEventListener('mouseleave', () => {
        startCloseTimer();
      });

      const cdsRoot = menuContainer.closest('.cds-root') || document.body;
      cdsRoot.appendChild(wrapperEl);
      
      document.addEventListener('click', onDocClick);
      menuContainer.addEventListener('scroll', onParentScroll);
      window.addEventListener('resize', onParentScroll);
    };

    triggerItem.addEventListener('mouseenter', () => {
      triggerItem.setAttribute('data-highlighted', '');
      openSubMenu();
    });
    triggerItem.addEventListener('mouseleave', () => {
      triggerItem.removeAttribute('data-highlighted');
      startCloseTimer();
    });

    parent.insertBefore(triggerItem, logoutItem);

    // Separator between trigger and native Log out item
    if (nativeSeparator) {
      const sepClone = nativeSeparator.cloneNode(true);
      sepClone.classList.add('csm-user-menu-item');
      parent.insertBefore(sepClone, logoutItem);
    } else {
      const fallbackSep = document.createElement('div');
      fallbackSep.className = 'csm-user-menu-item compact:mx-2 comfortable:mx-2.5 my-1 h-px bg-border';
      parent.insertBefore(fallbackSep, logoutItem);
    }

    // Snappy submenu close on sibling hover
    const siblingItems = Array.from(menuContainer.querySelectorAll('[role="menuitem"], button, a, div'));
    siblingItems.forEach(item => {
      if (item !== triggerItem && (item.getAttribute('role') === 'menuitem' || item.tagName === 'A' || item.tagName === 'BUTTON')) {
        item.addEventListener('mouseenter', () => {
          closeSubMenu();
        });
      }
    });

    // Automatically clean up submenu if parent menu closes or unmounts
    const cleanUpTimer = setInterval(() => {
      if (subMenuEl && !triggerItem.isConnected) {
        closeSubMenu();
        clearInterval(cleanUpTimer);
      }
      if (!subMenuEl && !triggerItem.isConnected) {
        clearInterval(cleanUpTimer);
      }
    }, 100);
  });
}

/**
 * Initializes a MutationObserver on document.body to detect newly appended limit dialogs
 * or inline text warnings immediately, injecting the Switch button into native popups.
 */
function startUsageLimitObserver() {
  // One-time scan on setup
  scanNodeForLimitElements(document.body);
  scanNodeForModelDropdown(document.body);
  injectProfileSwitcherIntoUserMenu(document.body);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        scanNodeForLimitElements(node);
        scanNodeForModelDropdown(node);
        injectProfileSwitcherIntoUserMenu(node);
      }
    }
    
    // If the send button intercept mode is active, ensure the Migrate icon is active
    if (sendInterceptActive) {
      ensureSendButtonMigrateIcon();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('[SessionMigrator] Usage limit observer active on document.body');
}

// Start the observer immediately after the content script loads
startUsageLimitObserver();

/**
 * Resolves the currently active model label visible in the DOM.
 */
function getActiveModelName() {
  const selectors = [
    '[data-testid="model-selector-dropdown"]',
    '[data-testid="model-selector"]',
    'button[aria-label*="model" i]',
    'button[aria-label*="Claude" i]',
    'button[aria-label*="claude" i]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      // Try extracting from aria-label first if its format matches "Model: <Name>"
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && /^model:/i.test(ariaLabel)) {
        const cleaned = ariaLabel.replace(/^model:\s*/i, '').trim();
        if (cleaned) return cleaned;
      }
      const text = el.textContent?.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  
  const textContent = document.body.textContent || '';
  if (textContent.includes('Fable 5')) return 'Fable 5';
  if (textContent.includes('Opus 4.8')) return 'Opus 4.8';
  if (textContent.includes('Sonnet 4.6')) return 'Sonnet 4.6';
  if (textContent.includes('Haiku 4.5')) return 'Haiku 4.5';
  if (textContent.includes('Opus 4.7')) return 'Opus 4.7';
  if (textContent.includes('Opus 4.6')) return 'Opus 4.6';
  if (textContent.includes('Opus 3')) return 'Opus 3';
  
  return 'Sonnet 4.6';
}

/**
 * Performs a best-effort auto-selection of the target model inside Claude's new-chat page.
 */
async function autoSelectModel(targetModelValue) {
  if (!targetModelValue) return;
  console.log('[SessionMigrator] Attempting to auto-select model:', targetModelValue);
  
  const modelLabels = {
    'claude-fable-5': ['fable 5', 'fable'],
    'claude-opus-4-8': ['opus 4.8', '4.8'],
    'claude-sonnet-4-6': ['sonnet 4.6', '4.6'],
    'claude-haiku-4-5': ['haiku 4.5', '4.5'],
    'claude-opus-4-7': ['opus 4.7', '4.7'],
    'claude-opus-4-6': ['opus 4.6', '4.6'],
    'claude-opus-3': ['opus 3', 'opus']
  };
  
  let targets = modelLabels[targetModelValue] || [];
  if (targets.length === 0) {
    // Generate targets from custom/dynamic value: e.g. "claude-sonnet-4-6-medium" -> ["sonnet", "4.6", "medium"]
    targets = targetModelValue
      .toLowerCase()
      .split('-')
      .filter(word => word && word !== 'claude' && word !== 'latest');
  }
  if (targets.length === 0) return;
  
  const selectorBtn = document.querySelector('[data-testid="model-selector-dropdown"]')
                   || document.querySelector('[data-testid="model-selector"]') 
                   || document.querySelector('button[aria-label*="model" i]')
                   || document.querySelector('button[aria-label*="Claude" i]')
                   || document.querySelector('button[aria-label*="claude" i]');
  if (!selectorBtn) {
    console.log('[SessionMigrator] Model selector button not found.');
    return;
  }
  
  const currentText = selectorBtn.textContent?.toLowerCase() || '';
  const alreadySelected = targets.length > 0 && targets.every(t => currentText.includes(t));
  if (alreadySelected) {
    console.log('[SessionMigrator] Model already active:', currentText);
    return;
  }
  
  selectorBtn.click();
  await new Promise(res => setTimeout(res, 300));
  
  const options = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a'));
  
  // Find option matching all targets (e.g. .every)
  let foundOption = options.find(opt => {
    const text = opt.textContent?.toLowerCase() || '';
    return targets.every(t => text.includes(t));
  });
  
  // Fallback to option matching most targets
  if (!foundOption) {
    let maxMatchedCount = 0;
    for (const opt of options) {
      const text = opt.textContent?.toLowerCase() || '';
      let matchedCount = 0;
      for (const t of targets) {
        if (text.includes(t)) matchedCount++;
      }
      if (matchedCount > maxMatchedCount) {
        maxMatchedCount = matchedCount;
        foundOption = opt;
      }
    }
  }
  
  if (foundOption) {
    console.log('[SessionMigrator] Clicking option:', foundOption.textContent);
    const clickTarget = foundOption.closest('[role="menuitemradio"], [role="menuitem"], button, [role="option"]') || foundOption;
    clickTarget.click();
  } else {
    console.log('[SessionMigrator] Option not found in menu.');
    selectorBtn.click();
  }
}

/**
 * Monitors and injects the context and pending message into the composer area.
 */
async function checkAndProcessMigrationInjection() {
  const data = await new Promise(res => 
    chrome.storage.local.get({ migration: null, pendingMessage: null }, res)
  );
  
  if (!data.migration || data.migration.state !== 'ready_to_inject') return;
  
  console.log('[SessionMigrator] Migration payload detected, awaiting composer...');
  
  let attempts = 0;
  const maxAttempts = 30; // 15 seconds
  const seekComposer = setInterval(async () => {
    attempts++;
    const composer = document.querySelector('[contenteditable="true"]');
    
    if (composer) {
      clearInterval(seekComposer);
      console.log('[SessionMigrator] Composer found. Injecting migration payload...');
      
      // Auto-select the chosen model first
      if (data.migration.targetModel) {
        await autoSelectModel(data.migration.targetModel);
        await new Promise(res => setTimeout(res, 500));
      }

      // Auto-configure effort level if configured
      if (data.migration.targetEffort && data.migration.targetEffort !== 'None') {
        await setEffortLevel(data.migration.targetEffort);
        await new Promise(res => setTimeout(res, 300));
      }

      // Auto-configure thinking state
      if (typeof data.migration.thinkingEnabled === 'boolean') {
        await setThinkingState(data.migration.thinkingEnabled);
        await new Promise(res => setTimeout(res, 300));
      }
      
      // Clear migration state in storage to avoid duplicate injections
      await chrome.storage.local.set({ migration: { state: 'idle' } });
      
      // Build final prompt
      const early = data.migration.earlyHistoryText || '';
      const recent = data.migration.recentHistoryText || '';
      const pending = data.pendingMessage?.text || '';
      
      let finalPrompt = '';
      if (early || recent) {
        finalPrompt += `[System Context - Conversation History]\n`;
        finalPrompt += `Below is the history of the conversation so far. Please review it carefully to maintain continuity.\n\n`;
        
        if (early) {
          finalPrompt += `=== CONVERSATION HISTORY (SUMMARIZED) ===\n${early}\n\n`;
        }
        if (recent) {
          finalPrompt += `=== RECENT TURNS (VERBATIM) ===\n${recent}\n\n`;
        }
        finalPrompt += `=========================================\n\n`;
      }
      
      if (pending) {
        finalPrompt += `Now, let's resume our conversation. Here is my next message:\n${pending}`;
      } else {
        finalPrompt += `Please review the context above. Confirm by stating: "Context loaded. Let's resume our conversation."`;
      }
      
      // Inject prompt into the composer
      composer.focus();
      document.execCommand('insertText', false, finalPrompt);
      
      // Dispatch React standard input event signals
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      
      // Clear pending message storage
      await chrome.storage.local.set({ pendingMessage: null });
      
      // Auto-send if pending message exists
      if (pending) {
        setTimeout(() => {
          const sendBtn = findSendButton();
          if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
            console.log('[SessionMigrator] Auto-send triggered.');
          }
        }, 500);
      }
    } else if (attempts >= maxAttempts) {
      clearInterval(seekComposer);
      console.warn('[SessionMigrator] Timed out waiting for composer element.');
    }
  }, 500);
}

// Run prompt injection verification on startup
checkAndProcessMigrationInjection();

/**
 * Dynamically scrapes available models from Claude's model selector dropdown.
 */
async function fetchModelsFromUI() {
  const selectorBtn = document.querySelector('[data-testid="model-selector-dropdown"]') 
                   || document.querySelector('[data-testid="model-selector"]') 
                   || document.querySelector('button[aria-label*="model"]')
                   || document.querySelector('button[aria-label*="Claude"]')
                   || document.querySelector('button[aria-label*="claude"]');
  if (!selectorBtn) return [];

  // Click selector to open the menu
  selectorBtn.click();
  
  // Wait 150ms for React to mount the menu dropdown
  await new Promise(res => setTimeout(res, 150));
  
  // Scrape dropdown elements
  const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a'))
    .filter(el => {
      const text = el.textContent?.trim() || '';
      return (text.includes('Sonnet') || text.includes('Haiku') || text.includes('Opus') || text.includes('Claude') || text.includes('3.5') || text.includes('3.7') || text.includes('Fable')) && text.length < 50;
    });

  const models = candidates.map(el => {
    const text = el.textContent?.trim() || '';
    let val = '';
    const textLower = text.toLowerCase();
    
    if (textLower.includes('3.7') && textLower.includes('sonnet')) {
      val = 'claude-3-7-sonnet-latest';
    } else if (textLower.includes('3.5') && textLower.includes('sonnet')) {
      val = 'claude-3-5-sonnet-latest';
    } else if (textLower.includes('haiku')) {
      val = 'claude-3-5-haiku-latest';
    } else if (textLower.includes('opus')) {
      val = 'claude-3-opus-latest';
    } else {
      val = 'claude-' + textLower.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    
    return { value: val, label: text };
  });

  // Deduplicate
  const uniqueModels = [];
  const seen = new Set();
  for (const m of models) {
    if (m.value && !seen.has(m.value)) {
      seen.add(m.value);
      uniqueModels.push(m);
    }
  }

  // Click again to close dropdown
  selectorBtn.click();
  
  return uniqueModels;
}

/**
 * Helper to find the thinking/reasoning toggle switch in the UI.
 */
function findThinkingToggle() {
  // Locate the open menu/popover container if it exists
  const containers = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [class*="menu"], [class*="dropdown"], [class*="popover"]'));
  
  // Find the first container that is NOT the model selector button itself
  let container = null;
  for (const c of containers) {
    if (c.getAttribute('data-testid') === 'model-selector-dropdown' || 
        c.getAttribute('aria-haspopup') === 'menu') {
      continue;
    }
    container = c;
    break;
  }
  
  // Fall back to document.body if no active menu container found (React unmounts it anyway when closed)
  if (!container) {
    container = document.body;
  }

  // Try standard attribute selectors first (case-insensitive)
  const selectors = [
    'button[aria-label*="thinking" i]',
    'button[aria-label*="reasoning" i]',
    'button[aria-label*="extended" i]',
    '[role="switch"][aria-label*="thinking" i]',
    '[role="switch"][aria-label*="reasoning" i]',
    '[role="switch"][aria-label*="extended" i]',
    'input[type="checkbox"][aria-label*="thinking" i]',
    'input[type="checkbox"][aria-label*="reasoning" i]',
    'input[type="checkbox"][aria-label*="extended" i]'
  ];
  for (const sel of selectors) {
    const el = container.querySelector(sel);
    if (el) {
      // Exclude model selector dropdown button itself
      const ariaLabel = el.getAttribute('aria-label') || "";
      if (el.getAttribute('data-testid') === 'model-selector-dropdown' || 
          el.getAttribute('aria-haspopup') === 'menu' ||
          ariaLabel.toLowerCase().includes('model:')) {
        continue;
      }
      return el;
    }
  }

  // Fallback to scanning interactive elements by content/labels
  const candidates = Array.from(container.querySelectorAll('button, input, [role="switch"], [role="checkbox"], span, div'));
  for (const el of candidates) {
    const text = el.textContent?.trim() || "";
    const ariaLabel = el.getAttribute('aria-label') || "";
    const testId = el.getAttribute('data-testid') || "";
    const name = el.getAttribute('name') || "";
    
    const isThinkingRelated = 
      /thinking|reasoning|extended/i.test(text) ||
      /thinking|reasoning|extended/i.test(ariaLabel) ||
      /thinking|reasoning|extended/i.test(testId) ||
      /thinking|reasoning|extended/i.test(name);
      
    // Exclude model selector dropdown button
    const isModelSelector = 
      el.getAttribute('data-testid') === 'model-selector-dropdown' || 
      el.getAttribute('aria-haspopup') === 'menu' ||
      ariaLabel.toLowerCase().includes('model:');

    if (isThinkingRelated && !isModelSelector) {
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.getAttribute('role') === 'switch' || el.getAttribute('role') === 'checkbox') {
        return el;
      }
      
      // Look for the closest menu item/wrapper container
      const menuItem = el.closest('[role="menuitem"], [role="menuitemradio"], [role="option"], button, a, [class*="menuitem"]');
      if (menuItem) {
        const switchBtn = menuItem.querySelector('button, input, [role="switch"], [role="checkbox"]');
        if (switchBtn) return switchBtn;
      }
      
      const parent = el.parentElement;
      if (parent) {
        const switchBtn = parent.querySelector('button, input, [role="switch"], [role="checkbox"]');
        if (switchBtn) return switchBtn;
      }
    }
  }
  return null;
}

/**
 * Extracts the boolean checked/pressed state from a toggle element.
 */
function getThinkingStateOfElement(switchEl) {
  if (!switchEl) return false;

  const pressed = switchEl.getAttribute('aria-pressed');
  if (pressed !== null) return pressed === 'true';

  const checked = switchEl.getAttribute('aria-checked');
  if (checked !== null) return checked === 'true';

  const dataState = switchEl.getAttribute('data-state');
  if (dataState !== null) return dataState === 'checked' || dataState === 'on' || dataState === 'true';

  if (switchEl.tagName === 'INPUT' && switchEl.type === 'checkbox') {
    return switchEl.checked;
  }
  
  // Fallback check based on classes containing 'checked' or 'active'
  const classStr = switchEl.className?.toLowerCase() || '';
  if (classStr.includes('checked') || classStr.includes('active')) return true;

  return false;
}

/**
 * Helper to find a menu item in Claude's dropdowns containing specific text.
 */
function findMenuItemByText(searchText) {
  const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a, [class*="menuitem"]'));
  for (const el of candidates) {
    const text = el.textContent?.trim() || "";
    if (text.toLowerCase().includes(searchText.toLowerCase())) {
      return el;
    }
  }
  
  // Fallback: search all divs or spans containing the text and locate interactive parent/child
  const allElements = Array.from(document.querySelectorAll('div, span'));
  for (const el of allElements) {
    const text = el.textContent?.trim() || "";
    if (text.toLowerCase() === searchText.toLowerCase() || (text.toLowerCase().includes(searchText.toLowerCase()) && text.length < 30)) {
      const interactive = el.closest('button, [role="menuitem"], [role="option"], [class*="item"]');
      if (interactive) return interactive;
      return el;
    }
  }
  return null;
}

/**
 * Gets the current thinking toggle state (enabled/disabled) from the UI.
 * Opens the model selector menu, checks the main menu first, and if not present,
 * checks the Effort sub-menu, then reads the state and closes it.
 */
async function getThinkingState() {
  // Check if toggle is already visible (e.g. menu is already open)
  const menuOpen = document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]');
  if (menuOpen) {
    let toggle = findThinkingToggle();
    if (toggle) {
      return getThinkingStateOfElement(toggle);
    }
  }

  // Find model button to open the menu
  const selectorBtn = document.querySelector('[data-testid="model-selector-dropdown"]')
                   || document.querySelector('[data-testid="model-selector"]') 
                   || document.querySelector('button[aria-label*="model" i]')
                   || document.querySelector('button[aria-label*="Claude" i]')
                   || document.querySelector('button[aria-label*="claude" i]');
  if (!selectorBtn) return false;

  // Open the main menu
  selectorBtn.click();
  await new Promise(res => setTimeout(res, 150));

  // 1. Try to find the toggle on the main menu first (e.g. Haiku 4.5)
  let toggle = findThinkingToggle();
  let state = false;
  
  if (toggle) {
    state = getThinkingStateOfElement(toggle);
    console.log('[SessionMigrator] Found thinking toggle on main menu, state:', state);
  } else {
    // 2. If not on main menu, look for Effort menu item to open Effort sub-menu (e.g. Sonnet 4.6)
    const effortItem = findMenuItemByText("Effort");
    if (effortItem) {
      effortItem.click();
      await new Promise(res => setTimeout(res, 150));
      
      toggle = findThinkingToggle();
      state = toggle ? getThinkingStateOfElement(toggle) : false;
      console.log('[SessionMigrator] Found thinking toggle in Effort sub-menu, state:', state);
    }
  }

  // Close the menu
  selectorBtn.click();
  
  return state;
}

/**
 * Enforces a specific thinking toggle state programmatically in the UI.
 * Opens the model selector menu, checks the main menu first, and if not present,
 * opens the Effort sub-menu, then toggles the switch and closes it.
 */
async function setThinkingState(enabled) {
  const menuOpen = document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]');
  if (menuOpen) {
    let toggle = findThinkingToggle();
    if (toggle) {
      const currentState = getThinkingStateOfElement(toggle);
      if (currentState !== enabled) {
        console.log(`[SessionMigrator] Clicking thinking toggle (menu open) to set to: ${enabled}`);
        let clickTarget = toggle;
        if (toggle.tagName !== 'INPUT') {
          const input = toggle.parentElement?.querySelector('input[type="checkbox"]') || toggle.closest('[role="menuitem"], [role="menuitemradio"]')?.querySelector('input[type="checkbox"]');
          if (input) clickTarget = input;
        }
        clickTarget.click();
        await new Promise(res => setTimeout(res, 200));
      }
      return;
    }
  }

  const selectorBtn = document.querySelector('[data-testid="model-selector-dropdown"]')
                   || document.querySelector('[data-testid="model-selector"]') 
                   || document.querySelector('button[aria-label*="model" i]')
                   || document.querySelector('button[aria-label*="Claude" i]')
                   || document.querySelector('button[aria-label*="claude" i]');
  if (!selectorBtn) {
    console.log('[SessionMigrator] Model selector button not found for thinking toggle.');
    return;
  }

  // Open the main menu
  selectorBtn.click();
  await new Promise(res => setTimeout(res, 150));

  // 1. Try to find the toggle on the main menu first (e.g. Haiku 4.5)
  let toggle = findThinkingToggle();
  if (toggle) {
    const currentState = getThinkingStateOfElement(toggle);
    if (currentState !== enabled) {
      console.log(`[SessionMigrator] Clicking thinking toggle (main menu) to set to: ${enabled}`);
      let clickTarget = toggle;
      if (toggle.tagName !== 'INPUT') {
        const input = toggle.parentElement?.querySelector('input[type="checkbox"]') || toggle.closest('[role="menuitem"], [role="menuitemradio"]')?.querySelector('input[type="checkbox"]');
        if (input) clickTarget = input;
      }
      clickTarget.click();
      await new Promise(res => setTimeout(res, 200));
    }
  } else {
    // 2. If not on main menu, look for Effort menu item to open Effort sub-menu (e.g. Sonnet 4.6)
    const effortItem = findMenuItemByText("Effort");
    if (effortItem) {
      effortItem.click();
      await new Promise(res => setTimeout(res, 150));

      toggle = findThinkingToggle();
      if (toggle) {
        const currentState = getThinkingStateOfElement(toggle);
        if (currentState !== enabled) {
          console.log(`[SessionMigrator] Clicking thinking toggle (Effort sub-menu) to set to: ${enabled}`);
          let clickTarget = toggle;
          if (toggle.tagName !== 'INPUT') {
            const input = toggle.parentElement?.querySelector('input[type="checkbox"]') || toggle.closest('[role="menuitem"], [role="menuitemradio"]')?.querySelector('input[type="checkbox"]');
            if (input) clickTarget = input;
          }
          clickTarget.click();
          await new Promise(res => setTimeout(res, 200));
        }
      }
    }
  }

  // Close the menu
  selectorBtn.click();
}

/**
 * Helper to find the currently active effort level checking in the dropdown menu items.
 */
function findActiveEffortOfElement() {
  const options = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="option"], button, div, span'));
  const effortLevels = ['Low', 'Medium', 'High', 'Max'];
  
  for (const opt of options) {
    const text = opt.textContent?.trim() || "";
    if (effortLevels.includes(text)) {
      if (opt.getAttribute('aria-checked') === 'true' || opt.querySelector('svg') || opt.textContent.includes('✓') || opt.classList.contains('checked') || opt.getAttribute('data-state') === 'checked') {
        return text;
      }
    }
  }
  return null;
}

/**
 * Gets the current effort level (Low, Medium, High, Max, or None) from the UI.
 * Scrapes from the main menu item text if possible, or opens the Effort sub-menu to inspect.
 */
async function getEffortLevel() {
  const selectorBtn = document.querySelector('[data-testid="model-selector-dropdown"]')
                   || document.querySelector('[data-testid="model-selector"]') 
                   || document.querySelector('button[aria-label*="model" i]')
                   || document.querySelector('button[aria-label*="Claude" i]')
                   || document.querySelector('button[aria-label*="claude" i]');
  if (!selectorBtn) return 'None';

  // Open the main menu
  selectorBtn.click();
  await new Promise(res => setTimeout(res, 150));

  // Find Effort menu item in main menu
  const effortItem = findMenuItemByText("Effort");
  if (!effortItem) {
    selectorBtn.click();
    return 'None'; // Model doesn't support effort setting
  }

  const text = effortItem.textContent || "";
  let level = 'None';
  if (/low/i.test(text)) level = 'Low';
  else if (/medium/i.test(text)) level = 'Medium';
  else if (/high/i.test(text)) level = 'High';
  else if (/max/i.test(text)) level = 'Max';
  else {
    // Fallback: click to open sub-menu and check checkmark
    effortItem.click();
    await new Promise(res => setTimeout(res, 150));
    level = findActiveEffortOfElement() || 'None';
  }

  // Close menu
  selectorBtn.click();
  return level;
}

/**
 * Enforces a specific effort level programmatically in the UI.
 */
async function setEffortLevel(level) {
  if (!level || level === 'None') return;
  
  const selectorBtn = document.querySelector('[data-testid="model-selector-dropdown"]')
                   || document.querySelector('[data-testid="model-selector"]') 
                   || document.querySelector('button[aria-label*="model" i]')
                   || document.querySelector('button[aria-label*="Claude" i]')
                   || document.querySelector('button[aria-label*="claude" i]');
  if (!selectorBtn) return;

  // Open the main menu
  selectorBtn.click();
  await new Promise(res => setTimeout(res, 150));

  // Find Effort menu item
  const effortItem = findMenuItemByText("Effort");
  if (effortItem) {
    effortItem.click();
    await new Promise(res => setTimeout(res, 150));

    // Find and click the target effort option
    const effortOption = findMenuItemByText(level);
    if (effortOption) {
      const clickTarget = effortOption.closest('[role="menuitemradio"], [role="menuitem"], button, [role="option"]') || effortOption;
      clickTarget.click();
      await new Promise(res => setTimeout(res, 150));
    }
  }

  // Close menu
  selectorBtn.click();
}




