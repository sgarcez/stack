const API = "";

// ── State ───────────────────────────────────────

let categories = [];
let feeds = [];
let currentEntries = [];
let currentEntry = null;
let currentFilter = {}; // { feed_id, category_id }
const app = document.getElementById("app");

function setView(view) {
  app.dataset.view = view;
}

// ── Init ────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await loadSidebar();
  loadEntries({}); // load all entries initially

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

async function loadSidebar() {
  const [catRes, feedRes] = await Promise.all([
    fetch(`${API}/api/categories`).then((r) => r.json()),
    fetch(`${API}/api/feeds`).then((r) => r.json()),
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

async function loadEntries(params) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${API}/api/entries?${qs}`);
  const data = await res.json();

  currentEntries = data.entries || [];
  renderEntryList();
}

function renderEntryList() {
  const container = document.getElementById("entries");
  container.innerHTML = "";

  if (currentEntries.length === 0) {
    container.innerHTML = `<div style="padding:24px;color:#999;text-align:center">No entries</div>`;
    return;
  }

  for (const entry of currentEntries) {
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

// ── Entry Content ───────────────────────────────

async function showEntry(entryID) {
  const res = await fetch(`${API}/api/entries/${entryID}`);
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
    await fetch(`${API}/api/entries/${currentEntry.id}/toggle-status`, { method: "PUT" });
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
  await fetch(`${API}/api/entries/${currentEntry.id}/toggle-status`, { method: "PUT" });
  currentEntry.status = currentEntry.status === "read" ? "unread" : "read";
  updateEntryButtons();

  const listItem = document.querySelector(`.entry-item[data-entry-id="${currentEntry.id}"]`);
  if (listItem) listItem.classList.toggle("read");
}

async function toggleStarred() {
  if (!currentEntry) return;
  await fetch(`${API}/api/entries/${currentEntry.id}/toggle-starred`, { method: "PUT" });
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
