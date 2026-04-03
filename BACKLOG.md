# Alchemy Saunas — Product Development Backlog

**Project:** AI-powered workspace for a sauna/ice bath venue business
**Stack:** Single-file HTML SPA (vanilla JS) + PowerShell watcher + Anthropic API
**Last updated:** 2026-04-03 (updated x2)

---

## P0 — Critical

### 1. Secure API Key Storage
**Description:** The Anthropic API key is stored in plaintext in `localStorage` and transmitted with `anthropic-dangerous-direct-browser-access`. Any browser extension, injected script, or XSS can trivially exfiltrate it. At minimum, warn users about this risk on the settings screen; better, add guidance to use a restricted-scope API key or proxy. The current field is `type="password"` only — that hides it from shoulder surfers, not from code.
**Priority:** P0

---

## P1 — High Impact

### 2. Data Backup & Export
**Description:** All workspace state (messages, agent configs, channel history) lives in `localStorage`, which can be wiped by clearing browser data, switching browsers, or storage eviction. There is no export or restore flow. A "Export workspace" button that downloads `alchemy_state` as JSON, and an "Import workspace" flow to restore it, would prevent catastrophic data loss.
**Priority:** P1

### 3. Error Handling for API Failures
**Description:** When the Claude API call fails (network error, rate limit, invalid key, quota exceeded), the streaming reader throws but the chat UI has no visible recovery path — the spinner or partial message may be left in a broken state. Add user-visible error messages, a retry button, and gracefully remove or mark failed messages.
**Priority:** P1

### 4. README / Setup Documentation
**Description:** There is no README in the project. A new team member has no idea how to: open the app, enter their API key, connect the Cowork folder, start the watcher script, or understand what each agent does. Write a `README.md` covering prerequisites, step-by-step setup (including the PowerShell execution policy requirement), and a quick-start guide for each workflow.
**Priority:** P1

### 5. Cowork Watcher Reliability & Status Feedback
**Description:** The watcher (`Alchemy-Watcher.ps1`) has several reliability gaps: (a) if Claude CLI hangs, the task is never completed and the spinner runs forever; (b) there is no visible timeout or max-retry in the polling loop; (c) the workspace app shows no persistent indicator of whether the watcher is actually running. Add a task timeout (e.g., 5 minutes), surface watcher connection status in the UI, and give users a way to cancel a stuck delegation.
**Priority:** P1

### 6. Browser Compatibility Warning
**Description:** The Cowork delegation system depends on the File System Access API (`showDirectoryPicker`), which is only available in Chromium-based browsers (Chrome, Edge). Firefox and Safari users get a silent failure with no explanation. Add a browser detection check and display a clear warning when the File System API is unavailable, falling back gracefully to Local API mode only.
**Priority:** P1

### 7. Searchable Second Brain / Memory
**Description:** The team needs a way to capture and retrieve institutional knowledge across all sources — Claude conversations, meeting notes, Slack threads, emails, and documents — using natural language queries like "what did we discuss about pricing last month?" or "find everything about the new membership structure". This could be built into the app itself (indexing message history with embeddings and semantic search via the Anthropic API) or integrate with an external tool like Notion as a knowledge base. Key requirements: ingestion from multiple sources, natural language retrieval, and surfacing results in context within the workspace. This is a key new feature request from the team.
**Priority:** P1

### 8. Deploy to GitHub Pages
**Description:** Set up a GitHub repository for `alchemy-saunas` and deploy `Alchemy-Workspace.html` to GitHub Pages so the team can access it via a stable public URL without needing to open a local file. Requires GitHub CLI (`gh`) to be authenticated on the machine first. Steps: initialise a git repo, create a remote via `gh repo create`, push the files, and enable GitHub Pages from the repo settings (or via `gh`). Note: sensitive data (API keys) remains in the user's `localStorage` — the hosted file itself contains no credentials.
**Priority:** P1

---

## P2 — Medium Priority

### 9. Deploy Backlog to Notion
**Description:** Once Notion integration access is granted, migrate all items from this `BACKLOG.md` into a proper Notion product backlog database under the Clawd Almighty page. The database should have a Kanban view grouped by priority (P0–P3), with fields for title, description, priority, and status. Keeps the backlog living in Notion alongside other team docs rather than a static markdown file.
**Priority:** P2

### 10. Custom Agent Creation
**Description:** The five agents (Blaze, Ember, Ledger, Harmony, Sage) are hardcoded in the initial state. Users can edit their names and system prompts, but cannot create new agents from scratch or delete existing ones. Adding a "New Agent" flow (name, role, emoji, system prompt, channel assignments) would let the workspace grow with the business without requiring code changes.
**Priority:** P2

### 11. Message Search
**Description:** As conversation history grows across six channels and five DM threads, there is no way to find a specific message, decision, or document reference. Implement a basic in-app search (keyboard shortcut `Ctrl+F` or `/`) that filters messages across all channels by keyword, highlighting matches inline.
**Priority:** P2

### 12. Keyboard Shortcuts & Input UX
**Description:** There are no keyboard shortcuts. Common expectations like `Enter` to send (or `Shift+Enter` for newline), `Escape` to close modals, and `↑` to edit the last message are missing. The send button is the only interaction path. Implement standard chat shortcuts and document them in a `?` tooltip.
**Priority:** P2

### 13. Message Pagination / localStorage Size Management
**Description:** All messages for all channels are stored in a single `localStorage` object with no pagination or pruning. `localStorage` has a ~5 MB browser-imposed limit. Long-running use will hit this limit, causing silent save failures and potential data corruption. Add per-channel message pagination (e.g., keep last 200 messages in state, archive older ones) and a storage usage indicator in settings.
**Priority:** P2

### 14. Add / Manage Human Team Members
**Description:** The four human users (James, Ebony, Mikaila, Mands) are hardcoded in the initial state. There is no way to add a new team member, change a display name, or update an avatar color without editing the source HTML. Add a "Manage Team" screen where human profiles can be created, edited, and removed.
**Priority:** P2

### 15. Complexity Scoring Transparency
**Description:** The Cowork routing decision (local API vs. Claude Desktop delegation) is based on a scoring algorithm that users cannot observe. Messages are silently routed without explanation. Show the computed complexity score alongside the delegation indicator, and let users manually override the routing decision per-message (a toggle icon next to the send button).
**Priority:** P2

---

## P3 — Low Priority / Nice-to-Have

### 16. Mobile Responsiveness
**Description:** The layout uses fixed-width sidebars and multi-column panels that break on screens narrower than ~900px. The app is currently desktop-only. A responsive layout with a collapsible sidebar would make it usable on tablets and mobile devices, which is relevant for on-the-go venue management.
**Priority:** P3

### 17. Codebase Refactoring (Split Monolith)
**Description:** All 46KB of HTML, CSS, and JavaScript lives in a single file (`Alchemy-Workspace.html`). This makes the code hard to navigate, diff, and maintain. Splitting into separate `.css`, `.js` (or ES modules), and `.html` files — and adding a minimal build step — would significantly improve maintainability as the project grows.
**Priority:** P3

### 18. Automated Testing
**Description:** There are no tests of any kind. The complexity scoring logic, markdown renderer, state management functions, and cowork routing are all untested. Adding a lightweight test harness (e.g., Vitest or plain Jest) with unit tests for the pure logic functions would catch regressions when refactoring and give confidence during changes.
**Priority:** P3

---

## Priority Summary

| # | Title | Priority |
|---|-------|----------|
| 1 | Secure API Key Storage | P0 |
| 2 | Data Backup & Export | P1 |
| 3 | Error Handling for API Failures | P1 |
| 4 | README / Setup Documentation | P1 |
| 5 | Cowork Watcher Reliability & Status Feedback | P1 |
| 6 | Browser Compatibility Warning | P1 |
| 7 | Searchable Second Brain / Memory | P1 |
| 8 | Deploy to GitHub Pages | P1 |
| 9 | Deploy Backlog to Notion | P2 |
| 10 | Custom Agent Creation | P2 |
| 11 | Message Search | P2 |
| 12 | Keyboard Shortcuts & Input UX | P2 |
| 13 | Message Pagination / localStorage Size Management | P2 |
| 14 | Add / Manage Human Team Members | P2 |
| 15 | Complexity Scoring Transparency | P2 |
| 16 | Mobile Responsiveness | P3 |
| 17 | Codebase Refactoring (Split Monolith) | P3 |
| 18 | Automated Testing | P3 |
