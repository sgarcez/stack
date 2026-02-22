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
    currentFilter = {};
    document.getElementById("entry-list-title").textContent = "All Entries";
    clearActiveFeed();
    loadEntries({});
    setView("list");
  });

  document.getElementById("btn-back-feeds").addEventListener("click", () => setView("sidebar"));
  document.getElementById("btn-back-entries").addEventListener("click", () => setView("list"));

  document.getElementById("btn-toggle-read").addEventListener("click", toggleReadStatus);
  document.getElementById("btn-toggle-star").addEventListener("click", toggleStarred);

  // Settings panel
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettings);
  document.getElementById("btn-add-feed").addEventListener("click", addFeed);
  document.getElementById("btn-add-category").addEventListener("click", addCategory);

  document.addEventListener("keydown", (e) => {
    // Don't hijack key events when focus is in an input
    if (e.target.matches("input, textarea, [contenteditable]")) return;
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
  loadEntries({});
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
      currentFilter = { category_id: cat.id };
      document.getElementById("entry-list-title").textContent = cat.title;
      clearActiveFeed();
      loadEntries({ category_id: cat.id });
      setView("list");
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
        currentFilter = { feed_id: f.id };
        document.getElementById("entry-list-title").textContent = f.title;
        clearActiveFeed();
        item.classList.add("active");
        loadEntries({ feed_id: f.id });
        setView("list");
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
      document.querySelectorAll(".entry-item.active").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      showEntry(entry.id);
      setView("content");
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
  const res = await apiFetch(`${API}/api/entries/${entryID}`);
  currentEntry = await res.json();

  document.getElementById("entry-empty").style.display = "none";
  const view = document.getElementById("entry-view");
  view.classList.remove("hidden");

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
    await apiFetch(`${API}/api/entries/${currentEntry.id}/toggle-status`, { method: "PUT" });
    currentEntry.status = "read";
    updateEntryButtons();
    // Update the list item
    const listItem = document.querySelector(`.entry-item[data-entry-id="${currentEntry.id}"]`);
    if (listItem) listItem.classList.add("read");
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

// ── Settings Panel ───────────────────────────────

function openSettings() {
  document.getElementById("entry-content").classList.add("hidden");
  document.getElementById("settings-panel").classList.remove("hidden");
  loadSettingsData();
}

function closeSettings() {
  document.getElementById("settings-panel").classList.add("hidden");
  document.getElementById("entry-content").classList.remove("hidden");
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
