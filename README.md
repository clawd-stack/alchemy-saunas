# Alchemy Saunas — AI Workspace

A single-file web app that gives the Alchemy Saunas team a shared workspace powered by Claude AI agents. Each agent specialises in a business function (strategy, marketing, operations, finance, people, admin, dev), and team members chat with them across dedicated channels.

## What's in the repo

- **`Alchemy-Supabase.html`** — The app. Open it in Chrome/Edge, connect your Supabase project, and go.
- **`supabase-setup.sql`** — Database schema + seed data (agents, channels, humans, workspace knowledge). Run this once in your Supabase project.
- **`NEXUS-SOUL.MD` / `NEXUS-AGENT.MD`** — Personality and role definitions for Nexus (Strategic Director). These are baked into the app's seed data but kept here as reference.
- **`Nexus-MD-Prompt.md`** — Prompt template for generating SOUL/AGENT docs for new agents.
- **`BACKLOG.md`** — Product backlog with prioritised features and known issues.

## Setup (5 minutes)

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project, and grab your:
- **Project URL** (e.g. `https://xxxx.supabase.co`)
- **Anon public key** (found in Settings → API)

### 2. Run the database setup

In your Supabase dashboard, go to **SQL Editor**, paste the contents of `supabase-setup.sql`, and click **Run**. This creates all tables and populates them with agents, channels, team members, and workspace knowledge.

### 3. Open the app

Open `Alchemy-Supabase.html` in Chrome or Edge. On first launch, the onboarding wizard will ask for:
- Your **Supabase URL** and **Anon Key** (from step 1)
- Your **Anthropic API key** (each agent needs one — you can use a shared key or per-agent keys)
- Select your **human profile** and set a PIN

That's it — you're in.

## Working with Claude Cowork

To continue building this project with Claude Cowork:

1. Clone this repo to a folder on your machine
2. Open Claude Desktop → Cowork mode
3. Select the cloned folder as your workspace
4. Claude will see all the project files, backlog, and agent definitions

The `.claude/` folder contains workspace settings that carry over.

## Agents

| Agent | Role | Focus |
|-------|------|-------|
| Nexus | Strategic Director | Cross-functional coordination, strategy |
| Blaze | Marketing Lead | Campaigns, brand, growth |
| Ember | Operations Manager | Venue ops, logistics, processes |
| Ledger | Finance Controller | Budgets, forecasting, financial models |
| Harmony | People & Culture | Team, hiring, culture, HR |
| Sage | Admin & Systems | Tools, compliance, admin processes |
| Dev | Technical Lead | Product development, integrations |

## Architecture

The app is a single HTML file that talks directly to Supabase (for shared state) and the Anthropic API (for agent responses). No server required.

- **Supabase** handles auth (PIN-based), data storage, and real-time sync across browsers
- **Anthropic API** is called client-side for agent chat (streaming responses)
- **localStorage** only stores the Supabase connection details and UI preferences

## Team

The seed data includes four human profiles: James, Dean, Jake, and Dom. Each has a PIN for login. You can add more humans and agents from within the app.
