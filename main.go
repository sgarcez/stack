package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	miniflux "miniflux.app/v2/client"
)

//go:embed frontend
var frontendFS embed.FS

var client *miniflux.Client

func main() {
	minifluxURL := os.Getenv("MINIFLUX_URL")
	if minifluxURL == "" {
		log.Fatal("MINIFLUX_URL environment variable is required")
	}
	minifluxAPIKey := os.Getenv("MINIFLUX_API_KEY")
	if minifluxAPIKey == "" {
		log.Fatal("MINIFLUX_API_KEY environment variable is required")
	}

	client = miniflux.NewClient(minifluxURL, minifluxAPIKey)

	frontendContent, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/categories", handleCategories)
	mux.HandleFunc("/api/feeds", handleFeeds)
	mux.HandleFunc("/api/entries", handleEntries)
	mux.HandleFunc("/api/entries/", handleEntry)
	mux.Handle("/", http.FileServer(http.FS(frontendContent)))

	log.Println("Listening on :8080")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatal(err)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// GET /api/categories
func handleCategories(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	categories, err := client.CategoriesWithCounters()
	if err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}

	writeJSON(w, categories)
}

// GET /api/feeds
func handleFeeds(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	feeds, err := client.Feeds()
	if err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}

	// Also fetch counters for unread counts per feed
	counters, err := client.FetchCounters()
	if err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}

	type feedWithCount struct {
		*miniflux.Feed
		UnreadCount int `json:"unread_count"`
	}

	result := make([]feedWithCount, len(feeds))
	for i, f := range feeds {
		result[i] = feedWithCount{
			Feed:        f,
			UnreadCount: counters.UnreadCounters[f.ID],
		}
	}

	writeJSON(w, result)
}

// GET /api/entries?feed_id=X&category_id=X&status=unread&limit=50&offset=0
func handleEntries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query()
	filter := &miniflux.Filter{}

	if v := q.Get("status"); v != "" {
		filter.Status = v
	}
	if v := q.Get("limit"); v != "" {
		n, _ := strconv.Atoi(v)
		filter.Limit = n
	} else {
		filter.Limit = 50
	}
	if v := q.Get("offset"); v != "" {
		n, _ := strconv.Atoi(v)
		filter.Offset = n
	}
	if v := q.Get("order"); v != "" {
		filter.Order = v
	} else {
		filter.Order = "published_at"
	}
	if v := q.Get("direction"); v != "" {
		filter.Direction = v
	} else {
		filter.Direction = "desc"
	}

	if v := q.Get("feed_id"); v != "" {
		feedID, _ := strconv.ParseInt(v, 10, 64)
		result, err := client.FeedEntries(feedID, filter)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, result)
		return
	}

	if v := q.Get("category_id"); v != "" {
		catID, _ := strconv.ParseInt(v, 10, 64)
		result, err := client.CategoryEntries(catID, filter)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, result)
		return
	}

	result, err := client.Entries(filter)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, result)
}

// Routes under /api/entries/{id}...
//
//	GET  /api/entries/{id}                — single entry
//	PUT  /api/entries/{id}/toggle-status  — toggle read/unread
//	PUT  /api/entries/{id}/toggle-starred — toggle starred
func handleEntry(w http.ResponseWriter, r *http.Request) {
	// Parse: /api/entries/{id}[/action]
	path := strings.TrimPrefix(r.URL.Path, "/api/entries/")
	parts := strings.SplitN(path, "/", 2)

	entryID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeError(w, "invalid entry id", http.StatusBadRequest)
		return
	}

	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	switch {
	case action == "" && r.Method == http.MethodGet:
		entry, err := client.Entry(entryID)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, entry)

	case action == "toggle-status" && r.Method == http.MethodPut:
		// First get the entry to check current status
		entry, err := client.Entry(entryID)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		newStatus := "read"
		if entry.Status == "read" {
			newStatus = "unread"
		}
		err = client.UpdateEntries([]int64{entryID}, newStatus)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]string{"status": newStatus})

	case action == "toggle-starred" && r.Method == http.MethodPut:
		err := client.ToggleStarred(entryID)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]string{"ok": "true"})

	default:
		writeError(w, "not found", http.StatusNotFound)
	}
}
