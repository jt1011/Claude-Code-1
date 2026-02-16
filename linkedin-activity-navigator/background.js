/**
 * LinkedIn Activity Navigator - Background Service Worker
 *
 * Handles extension lifecycle events and badge updates.
 * No network requests, no data collection.
 */

// Update badge when scrolling state changes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "scrollStateChanged") {
    const { state } = message;

    if (state === "scrolling") {
      chrome.action.setBadgeText({ text: "...", tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({
        color: "#0a66c2",
        tabId: sender.tab.id,
      });
    } else if (state === "stopped") {
      chrome.action.setBadgeText({ text: "", tabId: sender.tab.id });
    } else if (state === "done") {
      chrome.action.setBadgeText({ text: "OK", tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({
        color: "#16a34a",
        tabId: sender.tab.id,
      });
      // Clear after 5 seconds
      setTimeout(() => {
        chrome.action.setBadgeText({ text: "", tabId: sender.tab.id });
      }, 5000);
    }
  }

  sendResponse({ ok: true });
  return false;
});

// Clear badge when tab is updated (navigated away)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ text: "", tabId });
  }
});
