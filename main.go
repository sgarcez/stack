package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

//go:embed themes
var themesFS embed.FS

var (
	minifluxURL string
	theme       []byte
	aesGCM      cipher.AEAD
)

const sessionCookie = "stack_session"

func main() {
	minifluxURL = os.Getenv("MINIFLUX_URL")
	if minifluxURL == "" {
		log.Fatal("MINIFLUX_URL environment variable is required")
	}

	// Encryption key for session cookies (32 bytes hex = 16-byte AES-128 key).
	secret := os.Getenv("STACK_SECRET")
	if secret == "" {
		// Auto-generate a key (sessions won't survive restarts without a fixed key).
		b := make([]byte, 16)
		rand.Read(b)
		secret = hex.EncodeToString(b)
		log.Println("No STACK_SECRET set — generated ephemeral key (sessions lost on restart)")
	}
	key, err := hex.DecodeString(secret)
	if err != nil || len(key) != 16 {
		log.Fatal("STACK_SECRET must be 32 hex characters (16 bytes)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		log.Fatal(err)
	}
	aesGCM, err = cipher.NewGCM(block)
	if err != nil {
		log.Fatal(err)
	}

	themeName := os.Getenv("STACK_THEME")
	if themeName == "" {
		themeName = "default"
	}
	theme, err = themesFS.ReadFile("themes/" + themeName + ".css")
	if err != nil {
		log.Fatalf("unknown theme %q: %v", themeName, err)
	}
	log.Printf("Using theme: %s", themeName)

	frontendContent, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatal(err)
	}

	// Generate a version hash for cache-busting asset URLs in index.html.
	indexHTML, _ := frontendFS.ReadFile("frontend/index.html")
	version := fmt.Sprintf("%x", sha256.Sum256(indexHTML))[:8]
	indexWithVersion := strings.ReplaceAll(string(indexHTML), "__VERSION__", version)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			w.Write([]byte(indexWithVersion))
			return
		}
		noCache(http.FileServer(http.FS(frontendContent))).ServeHTTP(w, r)
	})
	mux.HandleFunc("/theme.css", handleTheme)
	mux.HandleFunc("/api/login", handleLogin)
	mux.HandleFunc("/api/logout", handleLogout)
	mux.HandleFunc("/api/me", requireAuth(handleMe))
	mux.HandleFunc("/api/categories", requireAuth(handleCategories))
	mux.HandleFunc("/api/categories/", requireAuth(handleCategoryByID))
	mux.HandleFunc("/api/feeds", requireAuth(handleFeeds))
	mux.HandleFunc("/api/feeds/discover", requireAuth(handleDiscover))
	mux.HandleFunc("/api/feeds/", requireAuth(handleFeedByID))
	mux.HandleFunc("/api/entries", requireAuth(handleEntries))
	mux.HandleFunc("/api/entries/", requireAuth(handleEntry))

	fontsContent, err := fs.Sub(themesFS, "themes/fonts")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/fonts/", noCache(http.StripPrefix("/fonts/", http.FileServer(http.FS(fontsContent)))))

	port := os.Getenv("STACK_PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// ── Cookie encryption ───────────────────────────

func encrypt(plaintext string) string {
	nonce := make([]byte, aesGCM.NonceSize())
	rand.Read(nonce)
	ciphertext := aesGCM.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(ciphertext)
}

func decrypt(encoded string) (string, error) {
	data, err := hex.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	nonceSize := aesGCM.NonceSize()
	if len(data) < nonceSize {
		return "", err
	}
	plaintext, err := aesGCM.Open(nil, data[:nonceSize], data[nonceSize:], nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// getClient decrypts credentials from the session cookie and returns a miniflux client.
func getClient(r *http.Request) *miniflux.Client {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil
	}
	creds, err := decrypt(cookie.Value)
	if err != nil {
		return nil
	}
	parts := strings.SplitN(creds, "\x00", 2)
	if len(parts) != 2 {
		return nil
	}
	return miniflux.NewClient(minifluxURL, parts[0], parts[1])
}

// ── Middleware ───────────────────────────────────

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if getClient(r) == nil {
			writeError(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		h.ServeHTTP(w, r)
	})
}

// ── Auth handlers ───────────────────────────────

// POST /api/login  { "username": "...", "password": "..." }
func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var creds struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&creds); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Validate credentials against Miniflux.
	client := miniflux.NewClient(minifluxURL, creds.Username, creds.Password)
	user, err := client.Me()
	if err != nil {
		writeError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	// Encrypt username + password into the cookie value.
	token := encrypt(creds.Username + "\x00" + creds.Password)

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, map[string]string{"username": user.Username})
}

// POST /api/logout
func handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})

	writeJSON(w, map[string]string{"ok": "true"})
}

// GET /api/me — returns current user info (also used to check auth status)
func handleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	client := getClient(r)
	user, err := client.Me()
	if err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]string{"username": user.Username})
}

// ── Utility ─────────────────────────────────────

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

// GET /theme.css
func handleTheme(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Write(theme)
}

// ── API handlers ────────────────────────────────

// GET /api/categories — list; POST /api/categories — create
func handleCategories(w http.ResponseWriter, r *http.Request) {
	client := getClient(r)

	switch r.Method {
	case http.MethodGet:
		categories, err := client.CategoriesWithCounters()
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, categories)

	case http.MethodPost:
		var body struct {
			Title string `json:"title"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Title == "" {
			writeError(w, "title required", http.StatusBadRequest)
			return
		}
		cat, err := client.CreateCategory(body.Title)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, cat)

	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// PUT /api/categories/{id} — rename; DELETE /api/categories/{id}
func handleCategoryByID(w http.ResponseWriter, r *http.Request) {
	client := getClient(r)
	idStr := strings.TrimPrefix(r.URL.Path, "/api/categories/")
	catID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, "invalid category id", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodPut:
		var body struct {
			Title string `json:"title"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Title == "" {
			writeError(w, "title required", http.StatusBadRequest)
			return
		}
		cat, err := client.UpdateCategory(catID, body.Title)
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, cat)

	case http.MethodDelete:
		if err := client.DeleteCategory(catID); err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]string{"ok": "true"})

	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// GET /api/feeds — list; POST /api/feeds — subscribe
func handleFeeds(w http.ResponseWriter, r *http.Request) {
	client := getClient(r)

	switch r.Method {
	case http.MethodGet:
		feeds, err := client.Feeds()
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
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

	case http.MethodPost:
		var body struct {
			FeedURL    string `json:"feed_url"`
			CategoryID int64  `json:"category_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.FeedURL == "" {
			writeError(w, "feed_url required", http.StatusBadRequest)
			return
		}
		if body.CategoryID == 0 {
			body.CategoryID = 1 // default category
		}
		feedID, err := client.CreateFeed(&miniflux.FeedCreationRequest{
			FeedURL:    body.FeedURL,
			CategoryID: body.CategoryID,
		})
		if err != nil {
			writeError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]int64{"feed_id": feedID})

	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// DELETE /api/feeds/{id}
func handleFeedByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	client := getClient(r)
	idStr := strings.TrimPrefix(r.URL.Path, "/api/feeds/")
	feedID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, "invalid feed id", http.StatusBadRequest)
		return
	}
	if err := client.DeleteFeed(feedID); err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]string{"ok": "true"})
}

// POST /api/feeds/discover  { "url": "..." }
func handleDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	client := getClient(r)
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		writeError(w, "url required", http.StatusBadRequest)
		return
	}
	subs, err := client.Discover(body.URL)
	if err != nil {
		writeError(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, subs)
}

// GET /api/entries?feed_id=X&category_id=X&status=unread&limit=50&offset=0
func handleEntries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	client := getClient(r)

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
	client := getClient(r)
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
