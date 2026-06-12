// options.js - Settings page handler for SessionMigrator

document.addEventListener("DOMContentLoaded", () => {
  const verbatimCountRange = document.getElementById("verbatimCountRange");
  const verbatimCountVal = document.getElementById("verbatimCountVal");
  const thinkingToggle = document.getElementById("thinkingToggle");
  const saveBtn = document.getElementById("saveBtn");
  const saveToast = document.getElementById("saveToast");

  const summarizeToggle = document.getElementById("summarizeToggle");

  // Load existing settings
  chrome.storage.local.get({ verbatimMessageCount: 3, verbatimAll: false, includeThinking: false }, (settings) => {
    verbatimCountRange.value = settings.verbatimMessageCount;
    verbatimCountVal.textContent = `${settings.verbatimMessageCount} message${settings.verbatimMessageCount === 1 ? '' : 's'}`;
    summarizeToggle.checked = !settings.verbatimAll;
    thinkingToggle.checked = settings.includeThinking;

    // Adjust slider availability based on setting
    verbatimCountRange.disabled = !summarizeToggle.checked;
    verbatimCountVal.style.opacity = summarizeToggle.checked ? "1" : "0.4";
  });

  // Track range changes in real-time
  verbatimCountRange.addEventListener("input", (e) => {
    const val = e.target.value;
    verbatimCountVal.textContent = `${val} message${val === "1" ? "" : "s"}`;
  });

  // Track summarizeToggle changes in real-time to toggle slider availability
  summarizeToggle.addEventListener("change", (e) => {
    const isSummarizing = e.target.checked;
    verbatimCountRange.disabled = !isSummarizing;
    verbatimCountVal.style.opacity = isSummarizing ? "1" : "0.4";
  });

  // Save configurations to local storage
  saveBtn.addEventListener("click", () => {
    const verbatimMessageCount = parseInt(verbatimCountRange.value, 10);
    const verbatimAll = !summarizeToggle.checked;
    const includeThinking = thinkingToggle.checked;

    chrome.storage.local.set({ verbatimMessageCount, verbatimAll, includeThinking }, () => {
      // Show success toast
      saveToast.classList.add("show");
      saveBtn.disabled = true;

      setTimeout(() => {
        saveToast.classList.remove("show");
        saveBtn.disabled = false;
      }, 2000);
    });
  });
});
