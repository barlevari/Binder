# Binder AI Matching System - Design Spec

**Date**: 2026-04-03
**Status**: Approved
**Approach**: Progressive Enhancement (Claude-only matching now, pgvector-ready for scale)
**Profiling**: Combination — conversational AI + interactive bubble UI

---

## Overview

Transform Binder from a swipe-based mutual-help platform into an AI-powered matchmaking system. Three interconnected features:

1. **Claude AI Chat** — Conversational interface replacing the swipe model
2. **Deep Personality Profiling** — Chat-driven + Apple Music-style bubble visualization
3. **Smart Matching Flow** — REQUEST → SEARCH → APPROVE → SELECT → CONNECT pipeline

---

## Architecture

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────┐
│  Frontend    │────>│  Supabase Edge Fns   │────>│  Claude API │
│ discover.html│<────│  (Deno runtime)      │<────│  Haiku/Sonnet│
│  + D3.js     │     └──────────┬───────────┘     └─────────────┘
│              │                │
│              │                v
│              │       ┌────────────────┐
│              └──────>│  Supabase DB   │
│   (Realtime sub)     │  + Auth        │
│                      └────────────────┘
└──────────────┘
```

- **Frontend**: Static HTML with inline JS (existing pattern) + D3.js v7 for bubble visualization
- **Backend**: Supabase Edge Functions (Deno) as Claude API proxy
- **DB**: Existing Supabase Postgres with 3 new tables
- **AI Models**: Haiku 4.5 for chat, Sonnet 4 for profile generation and compatibility analysis
- **Realtime**: Supabase Realtime subscriptions for notifications

### Edge Functions

| Function | Purpose | Model | Cost/call |
|----------|---------|-------|-----------|
| `claude-chat` | Chat, profiling, intent detection | Haiku 4.5 (chat), Sonnet 4 (profile) | ~$0.001 / ~$0.005 |
| `match-search` | Find candidates, rank, create match candidates | Sonnet 4 | ~$0.005 x candidate count |

### Progressive Enhancement Strategy

**Now (MVP, <100 users):** Enable pgvector extension (free on Supabase) to support the `vector(512)` column type, but don't use it for search yet. Claude reads all profiles and ranks directly. With ~50 profiles at ~200 tokens each, this fits comfortably in Sonnet's 200K context window.

**Future (>100 users):** Generate Voyage `voyage-3-lite` embeddings (512 dims), use two-pass matching (vector similarity -> Claude deep analysis). The `embedding_text` field is stored from day one to make this migration trivial. Switch when Claude context (~200 profiles x 200 tokens = 40K tokens) starts impacting latency or cost.

---

## Feature 1: Claude AI Chat

### Conversation Modes

**1. Onboarding Chat** — first conversation with a new user
- Claude asks natural questions in informal Hebrew
- Goal: learn about the user and generate a personality profile
- After ~5-8 exchanges, Claude generates a structured profile (Sonnet 4)
- User sees their bubble visualization and can adjust weights manually

**2. Search Chat** — user describes who they want to meet
- Claude detects search intent from conversation
- Asks clarifying questions if needed ("מנטור או שותף ללמידה?")
- When request is clear, triggers `match-search` Edge Function
- Shows progress to user ("מחפש לך... נמצאו 3 אנשים מתאימים")

**3. Match Chat** — after a match is established
- Claude sends an icebreaker message based on both profiles
- From this point, conversation is direct human-to-human
- Claude exits; only returns if explicitly addressed

### Edge Function: `claude-chat`

```
POST /functions/v1/claude-chat
Headers: Authorization: Bearer <supabase_jwt>
Body: { match_id: string, message: string }
Response: SSE stream
```

The Edge Function fetches conversation history from `binder_messages` using the `match_id` (not sent from frontend — prevents tampering). Uses service role key for DB access.

### System Prompt (Hebrew, cached)

- Role: Binder's matchmaker assistant
- Context: Mutual-help platform connecting people with complementary skills
- Capabilities: Understand requests, ask clarifying questions, trigger searches
- Personality: Warm, direct, helpful — matches Binder's tone
- Language: Hebrew, natural informal register
- Instruction: Never mention being AI; speak like a helpful friend

### SSE Streaming

Edge Function returns Server-Sent Events:
```
data: {"type":"text_delta","text":"אני"}
data: {"type":"text_delta","text":" מחפש"}
data: {"type":"search_started","request_id":"..."}
data: {"type":"done","full_response":"..."}
```

Frontend uses `fetch` + `ReadableStream` (not EventSource — needs custom headers).

### Message Storage

Extend existing `binder_messages` table:
- Add `role` column: `'user' | 'assistant' | 'system'`
- Add `message_type` column: `'chat' | 'search_request' | 'match_notification' | 'system'`
- `sender_id` = user's ID for user messages, NULL for assistant messages

### Context Window Management

- Keep last 20 messages in context
- Older messages: Claude summarizes and stores as a system message
- System prompt + user profile + context = ~2K tokens (high cache hit rate)

### Rate Limiting

- 30 messages/hour per user (enforced in Edge Function)
- Max 3 active search requests per user
- Tracked via DB query, not in-memory state

---

## Feature 2: Deep Personality Profiling

### The Combination Approach: Chat + Bubbles

Profiles are built in two stages:

**Stage 1 — Conversational profiling (automatic)**
1. During onboarding chat, Claude asks natural questions:
   - "מה אתה עושה? מה אתה אוהב לעשות?"
   - "מה הדבר שהכי חשוב לך כשאתה עוזר למישהו?"
   - "ספר לי על משהו שלמדת לאחרונה ואהבת"
2. After ~5-8 exchanges, Claude generates a structured profile (Sonnet 4)
3. Profile stored as JSON blob + `embedding_text` (for future pgvector)

**Stage 2 — Bubble UI calibration (manual)**
1. User sees their profile as Apple Music-style bubbles
2. Can tap a bubble to adjust its weight (slider)
3. Can long-press to remove a trait
4. Changes save to DB and increment `version`

### Five Personality Dimensions

| Dimension | Hebrew | Examples | Color |
|-----------|--------|----------|-------|
| **Skills** (what you can offer) | מיומנויות | Programming, Design, Marketing, Music | Coral #E8654A |
| **Interests** (what excites you) | תחומי עניין | Technology, Art, Sports, Philosophy | Blue #4A90D9 |
| **Values** (what matters to you) | ערכים | Community, Growth, Creativity, Independence | Sage #4A8C6F |
| **Communication** (your style) | סגנון תקשורת | Direct, Supportive, Analytical, Creative | Gold #F0A030 |
| **Availability** (what you seek) | זמינות | Mentor, Learner, Collaborator, Advisor | Lavender #7B6CB0 |

Each trait:
```json
{ "name": "תכנות", "weight": 0.9, "category": "skills" }
```

### Profile Generation (Sonnet 4, structured output)

```json
{
  "traits": [
    { "name": "תכנות", "weight": 0.9, "category": "skills" },
    { "name": "עיצוב", "weight": 0.3, "category": "skills" },
    { "name": "טכנולוגיה", "weight": 0.85, "category": "interests" },
    { "name": "קהילה", "weight": 0.7, "category": "values" }
  ],
  "summary": "מפתח תוכנה עם עניין בעיצוב, מחפש לעזור ולהיעזר בקהילה",
  "embedding_text": "software developer, design interest, technology, community oriented..."
}
```

### Storage

**New table: `binder_personality_profiles`**
```sql
CREATE TABLE binder_personality_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  traits JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  embedding_text TEXT,             -- stored from day one, for future pgvector
  embedding vector(512),           -- NULL for MVP, populated when pgvector enabled
  raw_conversation_id UUID,        -- match_id of the onboarding AI conversation
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Bubble Visualization (D3.js Force Simulation)

**Technology**: D3.js v7 — force simulation on SVG

**Physics**:
- Each trait = a circle element
- Circle **size** = trait weight (0.0-1.0 maps to diameter 20px-80px)
- Circle **color** = category (5 colors as defined above)
- Circles **cluster by category** using `d3.forceCluster`
- Collision detection prevents overlap (`d3.forceCollide`)
- Animation: bubbles float and gently bounce off each other

**Interaction**:
- **Tap/click** a bubble: shows detail panel with slider to adjust weight
- **Drag**: repositions bubble (cosmetic only, not persisted)
- **Pinch/scroll**: zoom in/out
- **Long press**: delete a trait

**Where it appears**:
1. **Profile page**: Your own personality map
2. **Match results**: Side-by-side comparison (your map vs. candidate)
3. **Compatibility overlay**: Shared traits glow/pulse, unique traits fade, complementary traits (your skills = their needs) highlighted in gold

### Progressive Refinement

Profile evolves over time:
- Every search request: Claude checks for new trait patterns, updates if found
- Every match: user can rate the match quality (feedback loop)
- `version` field increments on each update
- Only current version is stored (no history)

---

## Feature 3: Smart Matching Flow

### The Five-Step Pipeline

```
REQUEST -> SEARCH -> APPROVE -> SELECT -> CONNECT
```

### Step 1: REQUEST

User describes who they want to meet via Claude chat:
> "אני מחפש מישהו שיעזור לי ללמוד Node.js"

Claude extracts structured criteria:
```json
{
  "required_skills": ["Node.js", "Backend"],
  "preferred_traits": ["סבלני", "מנטור"],
  "purpose": "learning",
  "urgency": "normal"
}
```

Saved to `binder_match_requests` with status `searching`.

### Step 2: SEARCH

**MVP (Claude-only, <100 users):**
1. Fetch all profiles from DB (excluding requester)
2. Claude Sonnet receives: criteria + all profiles
3. Ranks each: score (0-100) + Hebrew explanation
4. Top 5 saved to `binder_match_candidates`

**Future (pgvector, >100 users):**
1. Vector similarity search on `embedding` column -> Top 20
2. Claude deep analysis on Top 20 -> Top 5

Request status changes to `pending_approval`.

### Step 3: APPROVE

**Notification to candidates** (in-app, via Supabase Realtime):
> "מישהו מחפש עזרה ב-Node.js. זה נשמע כמו משהו שאתה יכול לעזור בו?"

**Candidate options:**
- **Approve**: "אני פתוח לזה"
- **Reject**: "לא עכשיו" (no explanation required, no judgment)
- **Ask more**: "ספר לי עוד" -> Claude provides details without revealing requester identity

**Privacy**: Candidates do NOT see who is asking. They only see: what is being searched for + why they match.

**Timeout**: No response within 48 hours -> status set to `expired`.

### Step 4: SELECT

When at least one candidate approves, request status changes to `ready`.

**Requester sees:**
- Cards for each approved candidate
- Per card: name, avatar, compatibility score (0-100), Claude's explanation, bubble comparison

**Bubble comparison (side-by-side):**
- Requester's bubbles on the left, candidate's on the right
- Shared traits connected by lines + pulsing animation
- Complementary traits (requester's needs = candidate's skills) highlighted in gold

Requester clicks "בחר" (Select) to finalize.

**If only one candidate approved:** Skip SELECT, go directly to CONNECT.

### Step 5: CONNECT

1. Match record created in existing `binder_matches` table
2. Chat opens between the two users
3. Claude sends icebreaker message based on both profiles:
   > "היי! [name] מחפש עזרה ב-Node.js ו[name] יכול לעזור. שניכם מתעניינים בטכנולוגיה ואוהבים ללמד — נראה כמו fit מצוין!"
4. From here: direct human-to-human conversation (Claude exits)

### Edge Function: `match-search`

```
POST /functions/v1/match-search
Headers: Authorization: Bearer <supabase_jwt>
Body: { request_id: string, criteria: object }
```

Steps:
1. Validate request (check user has <3 active requests)
2. Fetch all personality profiles (excluding requester)
3. Call Sonnet 4 with criteria + all profiles
4. Parse rankings, create `binder_match_candidates` rows for top 5
5. Trigger Realtime notifications to candidates
6. Return request status to calling function

### New Tables

**`binder_match_requests`**
```sql
CREATE TABLE binder_match_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  extracted_criteria JSONB,
  status TEXT DEFAULT 'searching'
    CHECK (status IN ('searching', 'pending_approval', 'ready', 'completed', 'expired')),
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT now() + interval '7 days'
);
```

**`binder_match_candidates`**
```sql
CREATE TABLE binder_match_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID REFERENCES binder_match_requests(id) ON DELETE CASCADE,
  candidate_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  compatibility_score FLOAT,
  compatibility_explanation TEXT,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  notified_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Notification System

In-app only (email deferred):
- Supabase Realtime subscription on `binder_match_candidates` table
- When candidate logs in, pending requests appear in sidebar
- UI shows: what is being searched for + approve/reject buttons
- Future: email notifications via Supabase Auth hooks

### Edge Cases

| Case | Handling |
|------|----------|
| No candidates approve | After 48h: notify requester "No match found, try different criteria" |
| Only 1 candidate approves | Skip SELECT step, go directly to CONNECT |
| Requester doesn't select | After 72h: request expires |
| Candidate already in another match | Can still approve (no limit on active matches) |
| Max 3 active requests | New request rejected with message |

---

## UI Changes to discover.html

### Welcome View (replaces swipe model)

```
+----------------------------+
|  Nav bar (existing)        |
+----------------------------+
|                            |
|  Personality Bubbles       |
|  (D3.js, central, large)  |
|                            |
+----------------------------+
|  Suggestion chips:         |
|  "מצא לי מנטור"           |
|  "אני רוצה ללמד"          |
|  "אני צריך עזרה ב..."     |
+----------------------------+
|  Chat input:               |
|  "מה אתה מחפש היום?"      |
+----------------------------+
```

### New Views

| View | When shown | Content |
|------|-----------|---------|
| **Chat View** (enhanced) | During Claude conversation | Messages with typing animation + SSE streaming |
| **Match Request View** (new) | Candidate receives approval request | Request description + bubbles + approve/reject/ask buttons |
| **Candidate Selection View** (new) | Requester sees approved candidates | Cards with score + bubble comparison + "בחר" button |
| **Profile Bubbles View** (new) | Profile page | Full-screen D3.js bubble map with calibration controls |

### Sidebar Updates

- **New section**: "בקשות פעילות" (Active Requests) — shows pending match requests
- **Notification badges** on requests awaiting action
- Matches section shows both established matches AND pending approvals

### What Stays

- **Swipe model**: Hidden in code, not deleted. Existing users unaffected.
- **Direct chat**: Continues working between already-matched users
- **Sidebar structure**: Same layout, updated with new data

---

## Security

- All Edge Functions validate JWT via Supabase Auth header
- Edge Functions use **service role key** internally for DB operations (inserts, updates across users)
- `ANTHROPIC_API_KEY` stored as Supabase Edge Function secret (never exposed to frontend)
- RLS policies on all new tables (for direct client-side access):
  - `binder_personality_profiles`: Users can read/write only their own profile
  - `binder_match_requests`: Users can read their own requests; Edge Function inserts via service role
  - `binder_match_candidates`: Candidates can read/update their own candidacy status; Edge Function inserts via service role
- Rate limiting: 30 messages/hour per user (enforced in Edge Function, tracked via DB query)
- Input sanitization: All user messages sanitized before sending to Claude
- Conversation history fetched server-side (not sent from frontend) to prevent tampering

---

## Environment & Secrets

**Required Supabase secrets** (for Edge Functions):
- `ANTHROPIC_API_KEY` — Claude API key (user must provide before deployment)
- Already have: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

**Models used**:
- `claude-haiku-4-5-20251001` — Chat turns
- `claude-sonnet-4-20250514` — Profile generation, compatibility analysis

---

## Cost Estimate

Per active user per month (assuming 50 messages/day, 2 searches/week):

| Item | Calculation | Monthly Cost |
|------|-------------|-------------|
| Chat (Haiku) | 50 msgs x 30 days x $0.001 | $1.50 |
| Search (Sonnet) | 8 searches x $0.005 x 6 candidates | $0.24 |
| Profile generation (Sonnet) | 1x $0.005 | $0.005 (one-time) |
| **Total (no caching)** | | **~$1.75/user/month** |
| **Total (with 90% cache)** | | **~$0.35/user/month** |

---

## Implementation Order

### Phase 1: Foundation (Edge Functions + DB)
1. Enable pgvector extension in Supabase (free, needed for `vector` column type)
2. Create `binder_personality_profiles` table with RLS
3. Create `binder_match_requests` + `binder_match_candidates` tables with RLS
4. Add `role` and `message_type` columns to `binder_messages`
5. Deploy `claude-chat` Edge Function (basic, non-streaming first)
6. Deploy `match-search` Edge Function

### Phase 2: Chat Integration
1. Build welcome view with chat input + suggestion chips in discover.html
2. Implement SSE streaming in Edge Function + frontend
3. Onboarding flow: Claude conversation -> personality profile generation
4. Chat history persistence with context window management

### Phase 3: Personality Visualization
1. D3.js bubble component (force simulation, 5 categories, interaction)
2. Integrate into profile page (view + calibration)
3. Build match comparison view (side-by-side bubbles)

### Phase 4: Matching Pipeline
1. Implement Claude-only candidate search (all profiles)
2. Build candidate approval flow (notification + UI)
3. Build candidate selection view (cards + bubble comparison)
4. Connect flow: match creation + icebreaker message
5. Edge case handling (timeouts, expiry, single candidate)

---

## Decisions Made

1. **Architecture**: Progressive Enhancement — Claude-only matching for MVP, pgvector-ready data model for future scale.
2. **Profiling**: Combination approach — Claude builds profile through conversation, user refines via interactive bubble UI.
3. **Embedding model**: Skip for MVP. Store `embedding_text` from day one. Add Voyage `voyage-3-lite` (512 dims) when user count exceeds ~100.
4. **Email notifications**: Deferred. In-app only for now via Supabase Realtime.
5. **Existing swipe data**: Keep as-is. Old matches remain accessible. New flow runs in parallel.
6. **Concurrent match requests**: Max 3 active per user.
7. **Candidate privacy**: Candidates don't see requester identity during APPROVE step.
8. **Candidate timeout**: 48 hours to respond, then expired.
9. **Single candidate shortcut**: If only 1 candidate approves, skip SELECT and go to CONNECT.
10. **`ANTHROPIC_API_KEY`**: User must provide as Supabase Edge Function secret before deployment.
