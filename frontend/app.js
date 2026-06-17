const API = "";

// ── State ───────────────────────────────────────

let categories = [];
let feeds = [];
let currentEntries = [];
let currentEntry = null;
let currentFilter = {}; // { feed_id, category_id }
let totalEntries = 0;
let loadingEntries = false;
const app = document.getElementById("app");
const loginScreen = document.getElementById("login-screen");

function setView(view) {
  app.dataset.view = view;
}

// ── Auth ────────────────────────────────────────

async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  return res;
}

function showLogin() {
  loginScreen.classList.remove("hidden");
  app.classList.add("hidden");
}

function showApp() {
  loginScreen.classList.add("hidden");
  app.classList.remove("hidden");
}

// ── Init ────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  // Check if already authenticated
  try {
    const res = await fetch(`${API}/api/me`);
    if (res.ok) {
      await startApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }

  // Login form
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";

    try {
      const res = await fetch(`${API}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        errorEl.textContent = "Invalid username or password";
        return;
      }
      document.getElementById("login-form").reset();
      await startApp();
    } catch {
      errorEl.textContent = "Connection failed";
    }
  });

  // Logout
  document.getElementById("btn-logout").addEventListener("click", async () => {
    await fetch(`${API}/api/logout`, { method: "POST" });
    showLogin();
  });

  document.getElementById("btn-all-entries").addEventListener("click", () => {
    location.hash = "/";
  });

  // Sidebar collapse toggle
  document.querySelector(".sidebar-header h1").addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    const h1 = sidebar.querySelector("h1");
    sidebar.classList.toggle("collapsed");
    h1.textContent = sidebar.classList.contains("collapsed") ? "S" : "Stack";
  });

  document.getElementById("btn-back-feeds").addEventListener("click", () => setView("sidebar"));
  document.getElementById("btn-back-entries").addEventListener("click", () => setView("list"));

  window.addEventListener("hashchange", () => handleRoute());

  document.getElementById("btn-toggle-read").addEventListener("click", toggleReadStatus);
  document.getElementById("btn-toggle-star").addEventListener("click", toggleStarred);

  // Settings panel
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettings);
  document.getElementById("btn-add-feed").addEventListener("click", addFeed);
  document.getElementById("btn-add-category").addEventListener("click", addCategory);

  // Text size preference
  const selectTextSize = document.getElementById("select-text-size");
  const entryContent = document.getElementById("entry-content");
  
  // Handle backwards compatibility for old setting
  if (!localStorage.getItem("stack-text-size") && localStorage.getItem("stack-large-text") === "1") {
    localStorage.setItem("stack-text-size", "large");
  }
  
  const savedTextSize = localStorage.getItem("stack-text-size") || "normal";
  selectTextSize.value = savedTextSize;
  applyTextSize(savedTextSize);

  selectTextSize.addEventListener("change", () => {
    applyTextSize(selectTextSize.value);
    localStorage.setItem("stack-text-size", selectTextSize.value);
  });

  document.addEventListener("keydown", (e) => {
    // Don't hijack key events when focus is in an input
    if (e.target.matches("input, textarea, select, [contenteditable]")) return;

    if (e.key === "Escape") {
      if (!document.getElementById("settings-panel").classList.contains("hidden")) {
        closeSettings();
      } else if (app.classList.contains("fullscreen-reader")) {
        toggleFullscreenReader();
      }
      return;
    }
    if (e.key === "f") {
      toggleFullscreenReader();
      return;
    }
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      selectEntryByOffset(e.key === "j" ? 1 : -1);
    }
  });
});

// ── Sidebar ─────────────────────────────────────

async function startApp() {
  showApp();
  await loadSidebar();
  handleRoute();
}

async function handleRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [type, id] = hash.split("/");

  // Close settings if open
  closeSettings();

  if (type === "feed" && id) {
    const feedID = Number(id);
    const feed = feeds.find((f) => f.id === feedID);
    currentFilter = { feed_id: feedID };
    document.getElementById("entry-list-title").textContent = feed?.title || "Feed";
    clearActiveFeed();
    const el = document.querySelector(`.feed-item[data-feed-id="${feedID}"]`);
    if (el) el.classList.add("active");
    await loadEntries({ feed_id: feedID });
    setView("list");
  } else if (type === "category" && id) {
    const catID = Number(id);
    const cat = categories.find((c) => c.id === catID);
    currentFilter = { category_id: catID };
    document.getElementById("entry-list-title").textContent = cat?.title || "Category";
    clearActiveFeed();
    await loadEntries({ category_id: catID });
    setView("list");
  } else if (type === "entry" && id) {
    const entryID = Number(id);
    await showEntry(entryID);
    // Highlight the entry in the list if it's already there
    document.querySelectorAll(".entry-item.active").forEach((el) => el.classList.remove("active"));
    const existingEl = document.querySelector(`.entry-item[data-entry-id="${entryID}"]`);
    if (existingEl) {
      existingEl.classList.add("active");
    } else if (currentEntry && currentEntry.feed_id) {
      // Entry not in list (e.g. page refresh) — load its feed's entries
      const feedID = currentEntry.feed_id;
      const feed = feeds.find((f) => f.id === feedID);
      currentFilter = { feed_id: feedID };
      document.getElementById("entry-list-title").textContent = feed?.title || "Feed";
      clearActiveFeed();
      const feedEl = document.querySelector(`.feed-item[data-feed-id="${feedID}"]`);
      if (feedEl) feedEl.classList.add("active");
      await loadEntries({ feed_id: feedID });
      const entryEl = document.querySelector(`.entry-item[data-entry-id="${entryID}"]`);
      if (entryEl) {
        document.querySelectorAll(".entry-item.active").forEach((el) => el.classList.remove("active"));
        entryEl.classList.add("active");
      }
    }
    setView("content");
  } else {
    currentFilter = {};
    document.getElementById("entry-list-title").textContent = "All Entries";
    clearActiveFeed();
    loadEntries({});
    setView("list");
  }
}

async function loadSidebar() {
  const [catRes, feedRes] = await Promise.all([
    apiFetch(`${API}/api/categories`).then((r) => r.json()),
    apiFetch(`${API}/api/feeds`).then((r) => r.json()),
  ]);

  categories = catRes;
  feeds = feedRes;

  renderSidebar();
}

function renderSidebar() {
  const tree = document.getElementById("feed-tree");
  tree.innerHTML = "";

  // Group feeds by category
  const feedsByCategory = {};
  for (const f of feeds) {
    const catID = f.category?.id || 0;
    if (!feedsByCategory[catID]) feedsByCategory[catID] = [];
    feedsByCategory[catID].push(f);
  }

  for (const cat of categories) {
    const section = document.createElement("div");
    section.className = "category-section";

    const unread = cat.total_unread || 0;

    // Category label
    const label = document.createElement("div");
    label.className = "category-label";
    label.innerHTML = `
      <span>${esc(cat.title)}</span>
      <span class="category-count ${unread === 0 ? "zero" : ""}">${unread}</span>
    `;
    label.addEventListener("click", () => {
      location.hash = `/category/${cat.id}`;
    });
    section.appendChild(label);

    // Feeds under this category
    const catFeeds = feedsByCategory[cat.id] || [];
    for (const f of catFeeds) {
      const item = document.createElement("div");
      item.className = "feed-item";
      item.dataset.feedId = f.id;
      const count = f.unread_count || 0;
      item.innerHTML = `
        <span class="feed-item-title">${esc(f.title)}</span>
        ${count > 0 ? `<span class="feed-count">${count}</span>` : ""}
      `;
      item.addEventListener("click", () => {
        location.hash = `/feed/${f.id}`;
      });
      section.appendChild(item);
    }

    tree.appendChild(section);
  }
}

function clearActiveFeed() {
  document.querySelectorAll(".feed-item.active").forEach((el) => el.classList.remove("active"));
}

// ── Entry List ──────────────────────────────────

async function loadEntries(params, append = false) {
  if (loadingEntries) return;
  loadingEntries = true;

  if (!append) {
    currentEntries = [];
    totalEntries = 0;
    document.getElementById("entries").innerHTML = "";
  }

  const qs = new URLSearchParams({ ...params, offset: currentEntries.length });
  try {
    const res = await apiFetch(`${API}/api/entries?${qs}`);
    const data = await res.json();
    const newEntries = data.entries || [];
    totalEntries = data.total || 0;
    currentEntries = currentEntries.concat(newEntries);
    renderEntryItems(newEntries);
  } finally {
    loadingEntries = false;
  }
}

function renderEntryItems(entries) {
  const container = document.getElementById("entries");

  if (currentEntries.length === 0) {
    container.innerHTML = `<div style="padding:24px;color:#999;text-align:center">No entries</div>`;
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = `entry-item${entry.status === "read" ? " read" : ""}`;
    item.dataset.entryId = entry.id;

    const date = new Date(entry.published_at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const feedName = entry.feed?.title || "";

    item.innerHTML = `
      <div class="entry-item-title">
        ${entry.starred ? '<span class="entry-item-star">★ </span>' : ""}
        ${esc(entry.title)}
      </div>
      <div class="entry-item-meta">
        <span>${esc(feedName)}</span>
        <span>${date}</span>
      </div>
    `;

    item.addEventListener("click", () => {
      location.hash = `/entry/${entry.id}`;
    });

    container.appendChild(item);
  }
}

// Infinite scroll
document.getElementById("entries").addEventListener("scroll", (e) => {
  const el = e.target;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
    if (currentEntries.length < totalEntries && !loadingEntries) {
      loadEntries(currentFilter, true);
    }
  }
});

// ── Entry Content ───────────────────────────────

async function showEntry(entryID) {
  try {
    const res = await apiFetch(`${API}/api/entries/${entryID}`);
    currentEntry = await res.json();
  } catch (e) {
    document.getElementById("entry-title").textContent = "Failed to load";
    document.getElementById("entry-body").innerHTML = `<p style="color:var(--text-dim)">Could not load entry. Check your connection and try again.</p>`;
    return;
  }

  document.getElementById("entry-empty").style.display = "none";
  const view = document.getElementById("entry-view");
  view.classList.remove("hidden");
  document.getElementById("entry-content").scrollTop = 0;

  document.getElementById("entry-title").textContent = currentEntry.title;
  document.getElementById("entry-feed-name").textContent = currentEntry.feed?.title || "";
  document.getElementById("entry-date").textContent = new Date(
    currentEntry.published_at
  ).toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  document.getElementById("entry-body").innerHTML = currentEntry.content;
  document.getElementById("btn-open-original").href = currentEntry.url;

  updateEntryButtons();

  // Auto-mark as read
  if (currentEntry.status === "unread") {
    try {
      await apiFetch(`${API}/api/entries/${currentEntry.id}/toggle-status`, { method: "PUT" });
      currentEntry.status = "read";
      updateEntryButtons();
      const listItem = document.querySelector(`.entry-item[data-entry-id="${currentEntry.id}"]`);
      if (listItem) listItem.classList.add("read");
    } catch { /* non-critical, ignore */ }
  }
}

function updateEntryButtons() {
  if (!currentEntry) return;
  document.getElementById("btn-toggle-read").textContent =
    currentEntry.status === "read" ? "Mark as unread" : "Mark as read";
  document.getElementById("btn-toggle-star").textContent = currentEntry.starred
    ? "★ Starred"
    : "☆ Star";
}

async function toggleReadStatus() {
  if (!currentEntry) return;
  await apiFetch(`${API}/api/entries/${currentEntry.id}/toggle-status`, { method: "PUT" });
  currentEntry.status = currentEntry.status === "read" ? "unread" : "read";
  updateEntryButtons();

  const listItem = document.querySelector(`.entry-item[data-entry-id="${currentEntry.id}"]`);
  if (listItem) listItem.classList.toggle("read");
}

async function toggleStarred() {
  if (!currentEntry) return;
  await apiFetch(`${API}/api/entries/${currentEntry.id}/toggle-starred`, { method: "PUT" });
  currentEntry.starred = !currentEntry.starred;
  updateEntryButtons();
}

// ── Keyboard navigation ─────────────────────────

function selectEntryByOffset(offset) {
  if (currentEntries.length === 0) return;

  const activeEl = document.querySelector(".entry-item.active");
  const activeId = activeEl ? Number(activeEl.dataset.entryId) : null;
  const currentIndex = currentEntries.findIndex((e) => e.id === activeId);

  const nextIndex = currentIndex === -1
    ? (offset > 0 ? 0 : currentEntries.length - 1)
    : Math.max(0, Math.min(currentEntries.length - 1, currentIndex + offset));

  const nextEntry = currentEntries[nextIndex];
  if (!nextEntry) return;

  const nextEl = document.querySelector(`.entry-item[data-entry-id="${nextEntry.id}"]`);
  if (nextEl) {
    nextEl.click();
    nextEl.scrollIntoView({ block: "nearest" });
  }
}

// ── Utilities ───────────────────────────────────

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function applyTextSize(size) {
  const el = document.getElementById("entry-content");
  el.classList.remove("large-text", "extra-large-text");
  if (size === "large") el.classList.add("large-text");
  else if (size === "extra-large") el.classList.add("extra-large-text");
}

function toggleFullscreenReader() {
  app.classList.toggle("fullscreen-reader");
}

// ── Settings Panel ───────────────────────────────

let previousView = null;

function openSettings() {
  previousView = app.dataset.view || null;
  document.getElementById("entry-content").classList.add("hidden");
  document.getElementById("settings-panel").classList.remove("hidden");
  setView("settings");
  loadSettingsData();
}

function closeSettings() {
  document.getElementById("settings-panel").classList.add("hidden");
  document.getElementById("entry-content").classList.remove("hidden");
  if (previousView) {
    setView(previousView);
    previousView = null;
  }
}

async function loadSettingsData() {
  try {
    const [cats, feedList] = await Promise.all([
      apiFetch(`${API}/api/categories`).then((r) => r.json()),
      apiFetch(`${API}/api/feeds`).then((r) => r.json()),
    ]);

    // Populate category dropdown for add-feed
    const select = document.getElementById("add-feed-category");
    select.innerHTML = "";
    for (const cat of cats) {
      const opt = document.createElement("option");
      opt.value = cat.id;
      opt.textContent = cat.title;
      select.appendChild(opt);
    }

    // Render feed list
    const feedContainer = document.getElementById("settings-feed-list");
    feedContainer.innerHTML = "";
    for (const f of feedList) {
      const row = document.createElement("div");
      row.className = "settings-item";
      row.innerHTML = `
        <span class="settings-item-name">${esc(f.title)}</span>
        <span class="settings-item-meta">${esc(f.category?.title || "")}</span>
        <button data-feed-id="${f.id}" title="Remove">✕</button>
      `;
      row.querySelector("button").addEventListener("click", () => deleteFeed(f.id, f.title));
      feedContainer.appendChild(row);
    }

    // Render category list
    const catContainer = document.getElementById("settings-category-list");
    catContainer.innerHTML = "";
    for (const cat of cats) {
      const row = document.createElement("div");
      row.className = "settings-item";
      row.innerHTML = `
        <span class="settings-item-name">${esc(cat.title)}</span>
        <button data-cat-id="${cat.id}" title="Remove">✕</button>
      `;
      row.querySelector("button").addEventListener("click", () => deleteCategory(cat.id, cat.title));
      catContainer.appendChild(row);
    }
  } catch (e) {
    console.error("Failed to load settings data", e);
  }
}

async function addFeed() {
  const urlInput = document.getElementById("add-feed-url");
  const catSelect = document.getElementById("add-feed-category");
  const statusEl = document.getElementById("add-feed-status");
  const rawURL = urlInput.value.trim();
  if (!rawURL) return;

  statusEl.textContent = "Discovering feed...";
  let feedURL = rawURL;

  try {
    // Try to discover a feed URL from the given website
    const discoverRes = await apiFetch(`${API}/api/feeds/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: rawURL }),
    });
    if (discoverRes.ok) {
      const subs = await discoverRes.json();
      if (subs && subs.length > 0) {
        feedURL = subs[0].url;
        statusEl.textContent = `Found: ${feedURL}`;
      }
    }
  } catch { /* ignore discovery errors, try direct URL */ }

  statusEl.textContent = "Adding...";
  try {
    const res = await apiFetch(`${API}/api/feeds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feed_url: feedURL, category_id: Number(catSelect.value) }),
    });
    if (!res.ok) {
      const err = await res.json();
      statusEl.textContent = err.error || "Failed to add feed";
      return;
    }
    statusEl.textContent = "Added!";
    urlInput.value = "";
    await loadSettingsData();
    await loadSidebar();
  } catch {
    statusEl.textContent = "Failed to add feed";
  }
}

async function deleteFeed(feedID, title) {
  if (!confirm(`Remove feed "${title}"?`)) return;
  try {
    await apiFetch(`${API}/api/feeds/${feedID}`, { method: "DELETE" });
    await loadSettingsData();
    await loadSidebar();
  } catch (e) {
    console.error("Failed to delete feed", e);
  }
}

async function addCategory() {
  const input = document.getElementById("add-category-title");
  const title = input.value.trim();
  if (!title) return;

  try {
    const res = await apiFetch(`${API}/api/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || "Failed to create category");
      return;
    }
    input.value = "";
    await loadSettingsData();
    await loadSidebar();
  } catch {
    alert("Failed to create category");
  }
}

async function deleteCategory(catID, title) {
  if (!confirm(`Delete category "${title}"? Feeds will be moved to the default category.`)) return;
  try {
    await apiFetch(`${API}/api/categories/${catID}`, { method: "DELETE" });
    await loadSettingsData();
    await loadSidebar();
  } catch (e) {
    console.error("Failed to delete category", e);
  }
}
