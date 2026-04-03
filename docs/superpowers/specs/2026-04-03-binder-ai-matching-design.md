# Binder AI Matching System - Design Spec

**Date**: 2026-04-03
**Status**: Awaiting approval

---

## Overview

Transform Binder from a swipe-based mutual-help platform into an AI-powered matchmaking system. Three interconnected features:

1. **Claude AI Chat** - Conversational interface replacing the swipe model
2. **Deep Personality Profiling** - Apple Music-style bubble visualization of interests/traits
3. **Smart Matching Flow** - Request → Search → Approve → Select pipeline

## Architecture

```
User ←→ discover.html ←→ Supabase Edge Function ←→ Claude API
                              ↕
                        Supabase DB (pgvector)
```

- **Frontend**: Static HTML with inline JS (existing pattern)
- **Backend**: Supabase Edge Functions (Deno) as Claude API proxy
- **DB**: Existing Supabase Postgres + new pgvector extension
- **Models**: Haiku 4.5 for chat ($0.001/turn), Sonnet 4 for analysis ($0.005/call)

---

## Feature 1: Claude AI Chat Integration

### What Changes

The main interface becomes a **chat with an AI matchmaker** (like Claude's interface). Instead of swiping cards, users describe what they need in natural language:

> "אני מחפש מישהו שיעזור לי ללמוד Node.js, רצוי מישהו עם ניסיון של לפחות שנתיים"

Claude understands the request, asks clarifying questions if needed, and triggers the matching pipeline.

### Edge Function: `claude-chat`

```
POST /functions/v1/claude-chat
Headers: Authorization: Bearer <supabase_jwt>
Body: { match_id: string, message: string, history: Message[] }
Response: SSE stream of Claude's response
```

**System prompt** (Hebrew, cached):
- Role: Binder's AI matchmaker assistant
- Context: Mutual-help platform, connecting people with complementary skills
- Capabilities: Understand requests, ask clarifying questions, trigger searches
- Personality: Warm, direct, helpful (matches Binder's tone)
- Language: Hebrew with natural informal register

**Conversation modes**:
1. **Onboarding chat** - First conversation with a new user. Claude learns about them through natural dialogue (replaces boring form). Generates personality profile.
2. **Search chat** - User describes who they want to meet. Claude refines the request and triggers the matching pipeline.
3. **Match chat** - After match is established, Claude sends an icebreaker message to both users based on their shared interests, then the conversation becomes direct human-to-human (no more AI messages in that thread).

### Message Storage

Extend existing `binder_messages` table:
- Add `role` column: `'user' | 'assistant' | 'system'`
- Add `message_type` column: `'chat' | 'search_request' | 'match_notification' | 'system'`
- `sender_id` = user's ID for user messages, NULL for assistant messages

### Streaming

Use Server-Sent Events (SSE) from Edge Function:
```
data: {"type":"text_delta","text":"אני"}
data: {"type":"text_delta","text":" מחפש"}
data: {"type":"text_delta","text":" לך"}
data: {"type":"done","full_response":"..."}
```

Frontend uses `EventSource` or `fetch` with `ReadableStream` to render tokens as they arrive.

### Cost Control

- **Haiku 4.5** for all conversational turns (~$0.001/turn)
- **Sonnet 4** only for profile generation and compatibility analysis (~$0.005/call)
- **Prompt caching**: System prompt cached (90% cost reduction on cache hits)
- **Context window management**: Keep last 20 messages, summarize older ones
- **Rate limiting**: Max 30 messages/hour per user via Edge Function

---

## Feature 2: Deep Personality Profiling

### The Model

Inspired by Apple Music's bubble UI. Each user has a **personality map** — a collection of weighted traits across multiple dimensions:

**Dimensions**:
1. **Skills** (what you can offer): Programming, Design, Marketing, Music, Cooking, etc.
2. **Interests** (what excites you): Technology, Art, Sports, Philosophy, Travel, etc.
3. **Values** (what matters to you): Community, Growth, Creativity, Independence, etc.
4. **Communication style**: Direct, Supportive, Analytical, Creative
5. **Availability**: Mentor, Learner, Collaborator, Advisor

Each trait has:
- `name` (Hebrew string)
- `weight` (0.0-1.0, how strongly this applies)
- `category` (which dimension it belongs to)

### How Profiles Are Built

**Conversational profiling** (not forms):
1. During onboarding chat, Claude asks natural questions:
   - "מה אתה עושה? מה אתה אוהב לעשות?"
   - "מה הדבר שהכי חשוב לך כשאתה עוזר למישהו?"
   - "ספר לי על משהו שלמדת לאחרונה ואהבת"
2. After ~5-8 exchanges, Claude generates a structured profile using Sonnet 4
3. Profile is stored as a JSON blob + vector embedding

**Claude profile generation prompt** (Sonnet 4, structured output):
```json
{
  "traits": [
    { "name": "תכנות", "weight": 0.9, "category": "skills" },
    { "name": "עיצוב", "weight": 0.3, "category": "skills" },
    { "name": "טכנולוגיה", "weight": 0.85, "category": "interests" },
    { "name": "קהילה", "weight": 0.7, "category": "values" }
  ],
  "summary": "מפתח תוכנה עם עניין בעיצוב, מחפש לעזור ולהיעזר בקהילה",
  "embedding_text": "software developer, design interest, technology, community..."
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
  embedding vector(512),   -- pgvector (Voyage voyage-3-lite, or skip initially)
  raw_conversation_id UUID, -- match_id of the onboarding AI conversation
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

**Vector embedding**: Generated from the `embedding_text` field. For MVP, skip embeddings entirely and use Claude-only matching (fast enough with <50 users). Add pgvector when user count grows beyond ~100. When added, use Voyage `voyage-3-lite` (512 dims, $0.02/1M tokens).

### Bubble Visualization (Apple Music Style)

**Tech**: D3.js force simulation on an HTML5 Canvas or SVG.

**Layout**:
- Each trait is a circle
- Circle **size** = trait weight (bigger = stronger)
- Circle **color** = category (skills=coral, interests=blue, values=green, etc.)
- Circles **cluster by category** using D3 `forceCluster`
- Interactive: tap a bubble to see details, drag to rearrange
- Animation: bubbles float and gently bounce off each other

**Where it appears**:
- Profile page: Your own personality map
- Match view: Side-by-side comparison of your map vs. potential match
- Compatibility overlay: Shared traits glow/pulse, unique traits fade

### Progressive Refinement

Profile isn't static. It evolves:
- Every search request updates traits (if Claude detects new patterns)
- Every match interaction provides feedback (did the match work?)
- `version` field tracks profile iterations

---

## Feature 3: Smart Matching Flow

### The New Flow (replaces swipe model)

```
Step 1: REQUEST
  User describes who they want to meet via Claude chat
  Claude extracts: required_skills, preferred_traits, purpose

Step 2: SEARCH
  System queries DB:
    a) pgvector similarity search (fast, top 20 candidates)
    b) Claude compatibility analysis (deep, top 5 candidates)

Step 3: APPROVE
  System sends notification to each candidate:
    "מישהו מחפש [purpose]. מתאים לך?"
  Candidate can: approve / reject / ask for more info

Step 4: SELECT
  Requesting user sees all approved candidates:
    - Personality map comparison
    - Compatibility score + explanation
    - Brief profile summary
  User selects the best match

Step 5: CONNECT
  Match is created, chat opens between the two users
  Claude facilitates the initial introduction
```

### New Tables

**`binder_match_requests`**
```sql
CREATE TABLE binder_match_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,  -- what the user asked for
  extracted_criteria JSONB,   -- Claude's parsed requirements
  status TEXT DEFAULT 'searching',  -- searching | pending_approval | ready | completed | expired
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
  status TEXT DEFAULT 'pending',  -- pending | approved | rejected | expired
  notified_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Edge Function: `match-search`

Called by the chat Edge Function when Claude determines the user wants to find someone.

```
1. Extract criteria from conversation (Sonnet 4, structured output)
2. Create binder_match_request row
3. pgvector similarity search → top 20 candidates
4. For each candidate: Claude compatibility analysis (Sonnet 4)
5. Rank by compatibility_score
6. Create binder_match_candidates rows for top 5
7. Send notifications to candidates (in-app + optional email)
8. Return status to requesting user
```

### Notification System

For now, notifications are **in-app only**:
- Realtime subscription on `binder_match_candidates` table
- When a candidate logs in, they see pending requests
- UI shows: who's looking, what they need, approve/reject buttons
- Future: email notifications via Supabase Auth hooks

### Compatibility Scoring

Two-pass system:

**Pass 1 - Vector similarity** (fast, cheap):
```sql
SELECT p.user_id, p.traits, p.summary,
       1 - (p.embedding <=> query_embedding) as similarity
FROM binder_personality_profiles p
WHERE p.user_id != requester_id
ORDER BY p.embedding <=> query_embedding
LIMIT 20;
```

**Pass 2 - Claude analysis** (deep, per candidate):
Sonnet 4 receives:
- Requester's profile + what they're looking for
- Candidate's profile
- Returns: score (0-100) + Hebrew explanation

---

## UI Changes to discover.html

### Welcome View (New)

Replace the current welcome message with a **Claude-like chat interface**:
- Large centered input: "מה אתה מחפש היום?"
- Suggestion chips: "מצא לי מנטור", "אני רוצה ללמד", "אני צריך עזרה ב..."
- Below: personality bubble visualization (your map)

### Sidebar Updates

- **New section**: "בקשות פעילות" (Active Requests) showing pending match requests
- **Notification badges** on requests awaiting action
- Matches section shows both established matches AND pending approvals

### New Views

1. **Chat View** (already exists, enhanced):
   - Claude AI responses render with typing animation
   - When Claude triggers a search, show a progress indicator
   - Streaming text display

2. **Match Request View** (new):
   - Shows pending approval request with requester's need
   - Your personality map vs. what they're looking for
   - Approve / Reject / Ask More buttons

3. **Candidate Selection View** (new):
   - Cards showing approved candidates
   - Each card: avatar, name, compatibility score, bubble comparison
   - "בחר" (Select) button to finalize match

4. **Profile Bubbles View** (new):
   - Full-screen D3.js bubble visualization
   - Accessible from profile page and match comparisons

---

## Implementation Order

### Phase 1: Foundation (Edge Functions + DB)
1. Enable pgvector extension in Supabase
2. Create `binder_personality_profiles` table
3. Create `binder_match_requests` + `binder_match_candidates` tables
4. Deploy `claude-chat` Edge Function (basic, non-streaming first)
5. Deploy `match-search` Edge Function

### Phase 2: Chat Integration
1. Connect discover.html welcome view to Claude chat
2. Implement SSE streaming in Edge Function + frontend
3. Onboarding flow: Claude conversation → personality profile generation
4. Chat history persistence

### Phase 3: Matching Pipeline
1. Implement vector similarity search
2. Claude compatibility analysis
3. Notification system (in-app realtime)
4. Candidate approval flow (UI)
5. Candidate selection view (UI)

### Phase 4: Personality Visualization
1. D3.js bubble component
2. Profile page integration
3. Match comparison view
4. Progressive profile updates

---

## Environment & Secrets

**Required Supabase secrets** (for Edge Functions):
- `ANTHROPIC_API_KEY` - Claude API key
- Already have: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

**Models used**:
- `claude-haiku-4-5-20251001` - Chat turns
- `claude-sonnet-4-20250514` - Profile generation, compatibility analysis

---

## Cost Estimate

Per active user per month (assuming 50 messages/day, 2 searches/week):
- Chat: 50 × 30 × $0.001 = **$1.50/month** (Haiku)
- Search: 8 × $0.005 × 6 candidates = **$0.24/month** (Sonnet)
- Profile generation: 1 × $0.005 = **$0.005** (one-time)
- **Total: ~$1.75/user/month**

With prompt caching (90% of chats hit cache): **~$0.35/user/month**

---

## Decisions Made

1. **Embedding model**: Skip for MVP. Use Claude-only matching. Add Voyage `voyage-3-lite` (512 dims) when user count exceeds ~100.
2. **Email notifications**: Defer. In-app only for now.
3. **Existing swipe data**: Keep as-is. Old matches remain accessible. New matching flow runs in parallel.
4. **Concurrent match requests per user**: Max 3 active requests at a time.
5. **ANTHROPIC_API_KEY**: User must provide this as a Supabase Edge Function secret before deployment.
