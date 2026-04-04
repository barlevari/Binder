# Binder AI Matching — Implementation Plan

**Goal**: Transform Binder from swipe-based matching into an AI-powered matchmaking system with Claude chat, personality profiling (D3.js bubbles), and a 5-step matching pipeline.

**Spec**: `docs/superpowers/specs/2026-04-03-binder-ai-matching-design.md`

**Architecture**: Supabase Edge Functions (Deno) → Claude API → SSE streaming to static HTML frontend

**Tech Stack**:
- Backend: Supabase Edge Functions (Deno runtime), Anthropic TypeScript SDK (`npm:@anthropic-ai/sdk`)
- AI Models: `claude-haiku-4-5` (chat), `claude-sonnet-4-0` (profile generation, compatibility)
- Frontend: Static HTML + Vanilla JS (existing pattern), D3.js v7 (force simulation)
- DB: Supabase Postgres + pgvector extension
- Realtime: Supabase Realtime subscriptions

**Deployment**:
- Edge Functions: `deploy_edge_function` MCP tool (project_id: `tiizdtmjygneptxeplnm`)
- DB migrations: `apply_migration` MCP tool (same project_id)
- Frontend: Vercel auto-deploy from git (project: `prj_lZnqJeGGlvzrloaclZDhN3dJvQxa`, team: `team_t57sUWn48oLOUnDmY1mXMusK`)
- Local Edge Function code: `supabase/functions/<name>/index.ts` (version control only; deploy via MCP)

---

## File Structure

**New files**:
```
supabase/functions/claude-chat/index.ts    — Claude chat Edge Function (SSE streaming, tool use)
supabase/functions/match-search/index.ts   — Match search Edge Function (Claude ranking)
Binder/public/js/ai-chat.js               — Frontend AI chat module (SSE, typing animation)
Binder/public/js/personality-viz.js        — D3.js bubble visualization module
Binder/public/js/matching.js              — Matching pipeline UI module
```

**Modified files**:
```
Binder/public/discover.html               — Add AI chat view, personality viz, matching views, new imports
Binder/public/css/styles.css              — Add styles for AI chat, bubbles, matching UI
Binder/public/js/utils.js                 — Add new utilities (streaming helpers)
```

**Minor changes**:
```
Binder/public/js/config.js               — Export SUPABASE_URL (add `export` keyword to existing const)
```

**No changes needed**:
```
Binder/vercel.json                         — CSP already allows cdn.jsdelivr.net + *.supabase.co
```

---

## Phase 1: Database Foundation

### Task 1.1 — Enable pgvector Extension

**Deploy via**: `apply_migration` MCP tool

```sql
-- Migration: enable_pgvector
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
```

**Verify**: Run `SELECT * FROM pg_extension WHERE extname = 'vector'` via `execute_sql`.

---

### Task 1.2 — Create `binder_ai_conversations` Table

This table groups AI chat messages into conversations (onboarding, search, etc.).

**Deploy via**: `apply_migration` MCP tool

```sql
-- Migration: create_binder_ai_conversations
CREATE TABLE binder_ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_type TEXT NOT NULL DEFAULT 'onboarding'
    CHECK (conversation_type IN ('onboarding', 'search', 'match_icebreaker')),
  related_match_id UUID REFERENCES binder_matches(id) ON DELETE SET NULL,
  related_request_id UUID,  -- FK added after binder_match_requests exists
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for quick lookup of active conversations per user
CREATE INDEX idx_ai_conversations_user_active ON binder_ai_conversations(user_id, is_active);

-- RLS
ALTER TABLE binder_ai_conversations ENABLE ROW LEVEL SECURITY;

-- Users can read their own conversations
CREATE POLICY "Users read own conversations"
  ON binder_ai_conversations FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own conversations
CREATE POLICY "Users insert own conversations"
  ON binder_ai_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own conversations
CREATE POLICY "Users update own conversations"
  ON binder_ai_conversations FOR UPDATE
  USING (auth.uid() = user_id);
```

**Verify**: Run `SELECT * FROM binder_ai_conversations LIMIT 1` via `execute_sql`.

---

### Task 1.3 — Alter `binder_messages` Table

Add columns for AI messages and conversation grouping. Make `match_id` and `sender_id` nullable.

**Deploy via**: `apply_migration` MCP tool

```sql
-- Migration: alter_binder_messages_for_ai

-- Make match_id nullable (AI conversations don't have a match_id initially)
ALTER TABLE binder_messages ALTER COLUMN match_id DROP NOT NULL;

-- Make sender_id nullable (assistant messages have no sender)
ALTER TABLE binder_messages ALTER COLUMN sender_id DROP NOT NULL;

-- Add role column
ALTER TABLE binder_messages ADD COLUMN role TEXT DEFAULT 'user'
  CHECK (role IN ('user', 'assistant', 'system'));

-- Add message_type column
ALTER TABLE binder_messages ADD COLUMN message_type TEXT DEFAULT 'chat'
  CHECK (message_type IN ('chat', 'search_request', 'match_notification', 'system'));

-- Add conversation_id for AI chat grouping
ALTER TABLE binder_messages ADD COLUMN conversation_id UUID
  REFERENCES binder_ai_conversations(id) ON DELETE SET NULL;

-- Index for conversation message lookup
CREATE INDEX idx_messages_conversation ON binder_messages(conversation_id, created_at);

-- Update existing RLS policies are fine — existing messages all have match_id + sender_id set.
-- Add new policy for AI conversation messages (read own messages in own conversations)
CREATE POLICY "Users read own AI conversation messages"
  ON binder_messages FOR SELECT
  USING (
    conversation_id IS NOT NULL
    AND conversation_id IN (
      SELECT id FROM binder_ai_conversations WHERE user_id = auth.uid()
    )
  );
```

**Verify**: Run `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'binder_messages' AND column_name IN ('match_id', 'sender_id', 'role', 'message_type', 'conversation_id')` via `execute_sql`.

---

### Task 1.4 — Create `binder_personality_profiles` Table

**Deploy via**: `apply_migration` MCP tool

```sql
-- Migration: create_binder_personality_profiles
CREATE TABLE binder_personality_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  traits JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  embedding_text TEXT,
  embedding vector(512),
  raw_conversation_id UUID REFERENCES binder_ai_conversations(id) ON DELETE SET NULL,
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE binder_personality_profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile (matching display uses service role key in Edge Functions)
CREATE POLICY "Users read own profile"
  ON binder_personality_profiles FOR SELECT
  USING (auth.uid() = user_id);

-- Candidates can read profiles of users they're matched with via binder_match_candidates
CREATE POLICY "Candidates read matched profiles"
  ON binder_personality_profiles FOR SELECT
  USING (
    user_id IN (
      SELECT mc.candidate_id FROM binder_match_candidates mc
      JOIN binder_match_requests mr ON mc.request_id = mr.id
      WHERE mr.requester_id = auth.uid() AND mc.status = 'approved'
    )
  );

-- Users can insert their own profile
CREATE POLICY "Users insert own profile"
  ON binder_personality_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own profile
CREATE POLICY "Users update own profile"
  ON binder_personality_profiles FOR UPDATE
  USING (auth.uid() = user_id);
```

**Verify**: Run `SELECT * FROM binder_personality_profiles LIMIT 1` via `execute_sql`.

---

### Task 1.5 — Create `binder_match_requests` and `binder_match_candidates` Tables

**Deploy via**: `apply_migration` MCP tool

```sql
-- Migration: create_matching_tables

-- Match requests
CREATE TABLE binder_match_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES binder_ai_conversations(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  extracted_criteria JSONB,
  status TEXT DEFAULT 'searching'
    CHECK (status IN ('searching', 'pending_approval', 'ready', 'completed', 'expired')),
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT now() + interval '7 days'
);

-- Index for active requests per user (rate limiting: max 3)
CREATE INDEX idx_match_requests_active ON binder_match_requests(requester_id, status)
  WHERE status IN ('searching', 'pending_approval', 'ready');

-- RLS
ALTER TABLE binder_match_requests ENABLE ROW LEVEL SECURITY;

-- Users can read their own requests
CREATE POLICY "Users read own requests"
  ON binder_match_requests FOR SELECT
  USING (auth.uid() = requester_id);

-- Users can insert own requests
CREATE POLICY "Users insert own requests"
  ON binder_match_requests FOR INSERT
  WITH CHECK (auth.uid() = requester_id);

-- Users can update their own requests (status changes)
CREATE POLICY "Users update own requests"
  ON binder_match_requests FOR UPDATE
  USING (auth.uid() = requester_id);

-- Match candidates
CREATE TABLE binder_match_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES binder_match_requests(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  compatibility_score FLOAT,
  compatibility_explanation TEXT,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  notified_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for candidate lookup
CREATE INDEX idx_match_candidates_candidate ON binder_match_candidates(candidate_id, status);

-- RLS
ALTER TABLE binder_match_candidates ENABLE ROW LEVEL SECURITY;

-- Candidates can read their own candidacies
CREATE POLICY "Candidates read own candidacies"
  ON binder_match_candidates FOR SELECT
  USING (auth.uid() = candidate_id);

-- Candidates can update their own candidacy status (approve/reject)
CREATE POLICY "Candidates update own candidacy"
  ON binder_match_candidates FOR UPDATE
  USING (auth.uid() = candidate_id);

-- Requesters can read candidates for their own requests
CREATE POLICY "Requesters read own request candidates"
  ON binder_match_candidates FOR SELECT
  USING (
    request_id IN (
      SELECT id FROM binder_match_requests WHERE requester_id = auth.uid()
    )
  );

-- Add FK from binder_ai_conversations.related_request_id to binder_match_requests
ALTER TABLE binder_ai_conversations
  ADD CONSTRAINT fk_ai_conv_match_request
  FOREIGN KEY (related_request_id)
  REFERENCES binder_match_requests(id)
  ON DELETE SET NULL;

-- Enable realtime for match_candidates and match_requests (for notifications)
ALTER PUBLICATION supabase_realtime ADD TABLE binder_match_candidates;
ALTER PUBLICATION supabase_realtime ADD TABLE binder_match_requests;
```

**Verify**: Run `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'binder_match%'` via `execute_sql`.

---

### Task 1.6 — Check Security Advisors

After all migrations, run `get_advisors` (type: `security`) to catch any missing RLS policies or other issues.

---

## Phase 2: Claude Chat Edge Function

### Task 2.1 — Deploy Basic `claude-chat` Edge Function (Non-Streaming)

Start with a minimal working version that handles a single chat turn, stores messages, and returns a JSON response. This validates the full pipeline before adding SSE.

**Save locally**: `supabase/functions/claude-chat/index.ts`
**Deploy via**: `deploy_edge_function` MCP tool

```typescript
// supabase/functions/claude-chat/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `אתה השדכן של בינדר — פלטפורמת עזרה הדדית שמחברת בין אנשים עם כישורים משלימים.

התפקיד שלך:
- להכיר את המשתמש דרך שיחה טבעית ונעימה
- להבין מה הוא יודע לעשות, מה מעניין אותו, ומה חשוב לו
- לעזור לו למצוא אנשים מתאימים כשהוא מחפש עזרה
- לשמור על טון חם, ישיר, וידידותי

חוקים:
- דבר בעברית טבעית ולא פורמלית
- אל תציין שאתה AI או בוט
- שאל שאלה אחת בכל פעם, אל תציף
- התעניין באמת במה שהמשתמש אומר
- כשמשתמש חדש מגיע, התחל עם "היי! 👋 ספר לי קצת על עצמך — מה אתה אוהב לעשות?"`;

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Validate auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // User client (for auth validation)
    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    // Service client (for cross-user DB operations)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Get authenticated user
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request body
    const { conversation_id, message } = await req.json();
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sanitize message
    const sanitizedMessage = message.trim().slice(0, 2000);

    // Rate limiting: 30 messages/hour
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count: recentCount } = await supabaseAdmin
      .from("binder_messages")
      .select("id", { count: "exact", head: true })
      .eq("sender_id", user.id)
      .eq("role", "user")
      .gte("created_at", oneHourAgo);

    if ((recentCount ?? 0) >= 30) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get or create conversation
    let convId = conversation_id;
    if (!convId) {
      // Check for active onboarding conversation
      const { data: existingConv } = await supabaseAdmin
        .from("binder_ai_conversations")
        .select("id")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .eq("conversation_type", "onboarding")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingConv) {
        convId = existingConv.id;
      } else {
        // Create new conversation
        const { data: newConv, error: convError } = await supabaseAdmin
          .from("binder_ai_conversations")
          .insert({ user_id: user.id, conversation_type: "onboarding" })
          .select("id")
          .single();

        if (convError) throw convError;
        convId = newConv.id;
      }
    }

    // Store user message
    await supabaseAdmin.from("binder_messages").insert({
      conversation_id: convId,
      sender_id: user.id,
      role: "user",
      message_type: "chat",
      content: sanitizedMessage,
    });

    // Fetch conversation history (last 20 messages)
    const { data: history } = await supabaseAdmin
      .from("binder_messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(20);

    // Build messages array for Claude
    const claudeMessages = (history || []).map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }));

    // Fetch user profile for context
    const { data: userProfile } = await supabaseAdmin
      .from("binder_profiles")
      .select("full_name, age, location, bio")
      .eq("id", user.id)
      .single();

    const profileContext = userProfile
      ? `\n\nמידע על המשתמש: ${userProfile.full_name || ""}${userProfile.age ? `, גיל ${userProfile.age}` : ""}${userProfile.location ? `, מ${userProfile.location}` : ""}${userProfile.bio ? `. ביו: ${userProfile.bio}` : ""}`
      : "";

    // Call Claude
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT + profileContext,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: claudeMessages,
    });

    // Extract text response
    const assistantText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Store assistant message
    await supabaseAdmin.from("binder_messages").insert({
      conversation_id: convId,
      role: "assistant",
      message_type: "chat",
      content: assistantText,
    });

    return new Response(
      JSON.stringify({
        conversation_id: convId,
        message: assistantText,
        usage: response.usage,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("claude-chat error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
```

**Verify**:
1. Deploy via `deploy_edge_function`
2. Test with curl:
```bash
curl -X POST "https://tiizdtmjygneptxeplnm.supabase.co/functions/v1/claude-chat" \
  -H "Authorization: Bearer <user_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"message": "היי, מה קורה?"}'
```

**Important**: User must first set `ANTHROPIC_API_KEY` as a Supabase Edge Function secret. Check with user before deploying.

---

### Task 2.2 — Add SSE Streaming to `claude-chat`

Upgrade the Edge Function to return Server-Sent Events using `client.messages.stream()`.

**Modify**: `supabase/functions/claude-chat/index.ts`

Replace the Claude API call section (from `// Call Claude` to the end of the response) with SSE streaming:

```typescript
    // ... (keep everything above the Claude API call the same)

    // Call Claude with streaming
    const anthropic = new Anthropic();

    // Set up SSE response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const messageStream = anthropic.messages.stream({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: [
              {
                type: "text",
                text: SYSTEM_PROMPT + profileContext,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: claudeMessages,
          });

          let fullText = "";

          messageStream.on("text", (text) => {
            fullText += text;
            const event = `data: ${JSON.stringify({ type: "text_delta", text })}\n\n`;
            controller.enqueue(encoder.encode(event));
          });

          // Wait for completion
          const finalMessage = await messageStream.finalMessage();

          // Store assistant message
          await supabaseAdmin.from("binder_messages").insert({
            conversation_id: convId,
            role: "assistant",
            message_type: "chat",
            content: fullText,
          });

          // Send done event
          const doneEvent = `data: ${JSON.stringify({
            type: "done",
            conversation_id: convId,
            full_response: fullText,
            usage: finalMessage.usage,
          })}\n\n`;
          controller.enqueue(encoder.encode(doneEvent));
          controller.close();
        } catch (err) {
          const errorEvent = `data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`;
          controller.enqueue(encoder.encode(errorEvent));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
```

**Verify**: Test with curl and observe SSE events streaming in:
```bash
curl -N -X POST "https://tiizdtmjygneptxeplnm.supabase.co/functions/v1/claude-chat" \
  -H "Authorization: Bearer <user_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"message": "מה שלומך?"}'
```

---

### Task 2.3 — Add Tool Use for Intent Detection

Add Claude tools for `trigger_search` and `generate_profile` to detect user intent during chat.

**Modify**: `supabase/functions/claude-chat/index.ts`

Add tool definitions before the Claude API call:

```typescript
    // Tool definitions for intent detection
    const tools: Anthropic.Messages.Tool[] = [
      {
        name: "generate_profile",
        description: "Generate a personality profile after learning enough about the user through conversation. Call this after 5-8 meaningful exchanges when you have a good understanding of their skills, interests, values, and communication style.",
        input_schema: {
          type: "object" as const,
          properties: {
            traits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Trait name in Hebrew" },
                  weight: { type: "number", description: "0.0-1.0 importance weight" },
                  category: {
                    type: "string",
                    enum: ["skills", "interests", "values", "communication", "availability"],
                  },
                },
                required: ["name", "weight", "category"],
              },
              description: "Array of personality traits extracted from conversation",
            },
            summary: { type: "string", description: "Brief Hebrew summary of the person" },
            embedding_text: {
              type: "string",
              description: "English keywords for future embedding (comma-separated)",
            },
          },
          required: ["traits", "summary", "embedding_text"],
        },
      },
      {
        name: "trigger_search",
        description: "Trigger a match search when the user clearly describes who they want to find. Call this when the user's request is specific enough to search for candidates.",
        input_schema: {
          type: "object" as const,
          properties: {
            description: { type: "string", description: "Hebrew description of what user is looking for" },
            required_skills: {
              type: "array",
              items: { type: "string" },
              description: "Required skills for the match",
            },
            preferred_traits: {
              type: "array",
              items: { type: "string" },
              description: "Preferred personality traits",
            },
            purpose: {
              type: "string",
              enum: ["learning", "mentoring", "collaboration", "advice", "other"],
            },
          },
          required: ["description"],
        },
      },
    ];
```

Then update the streaming call to include tools, and handle tool_use events in the stream:

```typescript
    // In the ReadableStream start function, update the stream call:
    const messageStream = anthropic.messages.stream({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT + profileContext,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: claudeMessages,
      tools,
    });

    let fullText = "";

    messageStream.on("text", (text) => {
      fullText += text;
      const event = `data: ${JSON.stringify({ type: "text_delta", text })}\n\n`;
      controller.enqueue(encoder.encode(event));
    });

    const finalMessage = await messageStream.finalMessage();

    // Check for tool use in the response
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        if (block.name === "generate_profile") {
          // Use Sonnet for actual profile generation
          const profileAnthropic = new Anthropic();
          const profileResponse = await profileAnthropic.messages.create({
            model: "claude-sonnet-4-0",
            max_tokens: 2048,
            system: "You are a personality profiler. Given a conversation, extract a structured personality profile. Return valid JSON only.",
            messages: [
              {
                role: "user",
                content: `Based on this conversation data, generate a detailed personality profile:\n\n${JSON.stringify(block.input)}\n\nReturn the exact same JSON structure but with refined weights and additional traits you can infer.`,
              },
            ],
          });

          const profileText = profileResponse.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");

          let profileData;
          try {
            profileData = JSON.parse(profileText);
          } catch {
            profileData = block.input;
          }

          // Upsert personality profile
          await supabaseAdmin
            .from("binder_personality_profiles")
            .upsert({
              user_id: user.id,
              traits: profileData.traits || block.input.traits,
              summary: profileData.summary || block.input.summary,
              embedding_text: profileData.embedding_text || block.input.embedding_text,
              raw_conversation_id: convId,
            }, { onConflict: "user_id" });

          // Send profile_generated event
          const profileEvent = `data: ${JSON.stringify({
            type: "profile_generated",
            traits: profileData.traits || block.input.traits,
            summary: profileData.summary || block.input.summary,
          })}\n\n`;
          controller.enqueue(encoder.encode(profileEvent));

        } else if (block.name === "trigger_search") {
          // Check rate limit: max 3 active requests
          const { count: activeRequests } = await supabaseAdmin
            .from("binder_match_requests")
            .select("id", { count: "exact", head: true })
            .eq("requester_id", user.id)
            .in("status", ["searching", "pending_approval", "ready"]);

          if ((activeRequests ?? 0) >= 3) {
            const limitEvent = `data: ${JSON.stringify({
              type: "search_limit",
              message: "יש לך כבר 3 חיפושים פעילים. חכה שהם יסתיימו.",
            })}\n\n`;
            controller.enqueue(encoder.encode(limitEvent));
          } else {
            // Create match request
            const { data: matchRequest, error: reqError } = await supabaseAdmin
              .from("binder_match_requests")
              .insert({
                requester_id: user.id,
                conversation_id: convId,
                description: block.input.description,
                extracted_criteria: {
                  required_skills: block.input.required_skills || [],
                  preferred_traits: block.input.preferred_traits || [],
                  purpose: block.input.purpose || "other",
                },
              })
              .select("id")
              .single();

            if (!reqError && matchRequest) {
              const searchEvent = `data: ${JSON.stringify({
                type: "search_started",
                request_id: matchRequest.id,
                description: block.input.description,
              })}\n\n`;
              controller.enqueue(encoder.encode(searchEvent));

              // Trigger match-search Edge Function asynchronously
              // (don't await — let it run in background)
              fetch(`${supabaseUrl}/functions/v1/match-search`, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${supabaseServiceKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  request_id: matchRequest.id,
                  criteria: block.input,
                  requester_id: user.id,
                }),
              }).catch((e) => console.error("match-search trigger error:", e));
            }
          }
        }
      }
    }
```

**Verify**: Send a message like "אני מחפש מישהו שילמד אותי Python" and check for `search_started` SSE event. Send 5-8 conversational messages and check for `profile_generated` event.

---

## Phase 3: Frontend AI Chat Integration

### Task 3.1 — Create `ai-chat.js` Module

This module handles SSE streaming from the `claude-chat` Edge Function, typing animation, and message rendering.

**Create**: `Binder/public/js/ai-chat.js`

```javascript
// Binder/public/js/ai-chat.js
// AI Chat module — SSE streaming, typing animation, conversation management

import { supabase, SUPABASE_URL } from '/js/config.js';
import { esc, toast, formatFullTime, formatDate } from '/js/utils.js';

/**
 * Stream a message to the Claude chat Edge Function
 * @param {string} message - User message
 * @param {string|null} conversationId - Existing conversation ID or null
 * @param {object} callbacks - { onText, onDone, onProfileGenerated, onSearchStarted, onError }
 * @returns {Promise<void>}
 */
export async function streamChatMessage(message, conversationId, callbacks) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    callbacks.onError?.('Not authenticated');
    return;
  }

  const body = { message };
  if (conversationId) body.conversation_id = conversationId;

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/claude-chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 429) {
        callbacks.onError?.('הגעת למגבלת ההודעות. נסה שוב בעוד כמה דקות.');
      } else {
        callbacks.onError?.(err.error || 'Server error');
      }
      return;
    }

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);

          switch (event.type) {
            case 'text_delta':
              callbacks.onText?.(event.text);
              break;
            case 'done':
              callbacks.onDone?.(event);
              break;
            case 'profile_generated':
              callbacks.onProfileGenerated?.(event);
              break;
            case 'search_started':
              callbacks.onSearchStarted?.(event);
              break;
            case 'search_limit':
              callbacks.onError?.(event.message);
              break;
            case 'error':
              callbacks.onError?.(event.message);
              break;
          }
        } catch {
          // Ignore malformed JSON lines
        }
      }
    }
  } catch (err) {
    console.error('streamChatMessage error:', err);
    callbacks.onError?.('שגיאת חיבור. נסה שוב.');
  }
}

/**
 * Load AI conversation history from DB
 * @param {string} conversationId
 * @returns {Promise<Array>}
 */
export async function loadConversationHistory(conversationId) {
  const { data, error } = await supabase
    .from('binder_messages')
    .select('id, role, content, created_at, message_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('loadConversationHistory error:', error);
    return [];
  }
  return data || [];
}

/**
 * Get or create the user's active AI conversation
 * @returns {Promise<string|null>} conversation_id
 */
export async function getActiveConversation() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data } = await supabase
    .from('binder_ai_conversations')
    .select('id')
    .eq('user_id', session.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.id || null;
}

/**
 * Check if user has a personality profile
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getUserProfile(userId) {
  const { data } = await supabase
    .from('binder_personality_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  return data;
}

/**
 * Create a typing indicator element
 * @returns {HTMLElement}
 */
export function createTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'cv-msg in ai-typing';
  div.innerHTML = `
    <div class="cv-bub ai-bub">
      <span class="typing-dots">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </span>
    </div>
  `;
  return div;
}

/**
 * Create a streaming message element that text appends to
 * @returns {{ element: HTMLElement, appendText: (text: string) => void, finalize: (timestamp: string) => void }}
 */
export function createStreamingMessage() {
  const div = document.createElement('div');
  div.className = 'cv-msg in';
  div.innerHTML = `
    <div class="cv-bub ai-bub"></div>
    <div class="cv-time"></div>
  `;

  const bubble = div.querySelector('.cv-bub');
  const timeEl = div.querySelector('.cv-time');
  let rawText = '';

  return {
    element: div,
    appendText(text) {
      rawText += text;
      bubble.innerHTML = esc(rawText).replace(/\n/g, '<br>');
    },
    finalize(timestamp) {
      timeEl.textContent = formatFullTime(timestamp || new Date().toISOString());
    },
  };
}
```

**Verify**: File created, no syntax errors (check by importing in browser console).

---

### Task 3.2 — Add AI Chat View to `discover.html`

Add the AI chat view HTML to `discover.html`, alongside the existing views. Also add suggestion chips for the welcome screen.

**Modify**: `Binder/public/discover.html`

Add after the existing `chatView` div and before `</div><!-- mainBody -->`:

```html
      <!-- AI Chat View -->
      <div class="chatview hidden" id="aiChatView">
        <div class="cv-head">
          <button class="cv-back" id="aiChatBackBtn" title="חזרה">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </button>
          <div class="cv-av ai-av">
            <div class="ai-avatar-icon">✦</div>
          </div>
          <span class="cv-name">בינדר AI</span>
        </div>
        <div class="cv-msgs" id="aiChatMsgs"></div>
        <div class="cv-foot">
          <!-- Suggestion chips (shown when chat is empty) -->
          <div class="ai-chips" id="aiChips">
            <button class="ai-chip" data-msg="מצא לי מנטור לתכנות">🎯 מצא לי מנטור</button>
            <button class="ai-chip" data-msg="אני רוצה ללמד מישהו">🤝 אני רוצה ללמד</button>
            <button class="ai-chip" data-msg="אני צריך עזרה ב...">💡 אני צריך עזרה</button>
          </div>
          <form class="cv-form" id="aiChatForm">
            <textarea class="cv-ta" id="aiChatInput" placeholder="מה אתה מחפש היום?" rows="1" maxlength="2000"></textarea>
            <button type="submit" class="cv-send" id="aiChatSendBtn" disabled>
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
            </button>
          </form>
        </div>
      </div>
```

Update the welcome view to include an "AI Chat" card:

```html
      <!-- In welcome-grid, replace the discover card with AI chat card -->
      <div class="welcome-card" id="welcomeAiChatBtn">
        <div class="welcome-card-icon">✦</div>
        <div class="welcome-card-label">שוחח עם בינדר</div>
        <div class="welcome-card-desc">מצא התאמות עם AI</div>
      </div>
```

Add the AI chat module import and integration logic in the `<script type="module">` section:

```javascript
import { streamChatMessage, loadConversationHistory, getActiveConversation, createTypingIndicator, createStreamingMessage } from '/js/ai-chat.js';
```

Add AI chat state variables:

```javascript
  let aiConversationId = null;
  let aiIsStreaming = false;
  let lastAiDateSep = null;
```

Add AI chat DOM refs:

```javascript
  const aiChatViewEl  = $('aiChatView');
  const aiChatMsgs    = $('aiChatMsgs');
  const aiChatInput   = $('aiChatInput');
  const aiChatSendBtn = $('aiChatSendBtn');
```

Update `showView()` to handle `'ai-chat'` state:

```javascript
  // Add to showView:
  aiChatViewEl.classList.add('hidden');
  // ...
  if (view === 'ai-chat') {
    aiChatViewEl.classList.remove('hidden');
    topTitle.textContent = 'בינדר AI';
    document.title = 'בינדר AI';
  }
```

Add AI chat functions:

```javascript
  // ── AI Chat ───────────────────────────────────────────────
  async function openAiChat() {
    showView('ai-chat');
    aiConversationId = await getActiveConversation();

    aiChatMsgs.innerHTML = '';
    lastAiDateSep = null;

    if (aiConversationId) {
      // Load existing conversation
      const history = await loadConversationHistory(aiConversationId);
      history.forEach(msg => appendAiMessage(msg));
      $('aiChips').classList.add('hidden');
    } else {
      // Fresh conversation — show chips
      $('aiChips').classList.remove('hidden');
    }

    scrollAiChatBottom();
  }

  function appendAiMessage(msg) {
    const dateStr = formatDate(msg.created_at);
    if (dateStr !== lastAiDateSep) {
      lastAiDateSep = dateStr;
      const sep = document.createElement('div');
      sep.className = 'cv-date';
      sep.innerHTML = `<span>${esc(dateStr)}</span>`;
      aiChatMsgs.appendChild(sep);
    }

    const isUser = msg.role === 'user';
    const div = document.createElement('div');
    div.className = `cv-msg ${isUser ? 'out' : 'in'}`;
    div.innerHTML = `
      <div class="cv-bub${isUser ? '' : ' ai-bub'}">${esc(msg.content).replace(/\n/g, '<br>')}</div>
      <div class="cv-time">${formatFullTime(msg.created_at)}</div>
    `;
    aiChatMsgs.appendChild(div);
  }

  async function sendAiMessage(text) {
    if (!text || aiIsStreaming) return;

    const content = text.trim();
    if (!content) return;

    aiIsStreaming = true;
    aiChatInput.value = '';
    aiChatSendBtn.disabled = true;
    $('aiChips').classList.add('hidden');
    adjustAiTextarea();

    // Add user message
    appendAiMessage({
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    });
    scrollAiChatBottom();

    // Show typing indicator
    const typingEl = createTypingIndicator();
    aiChatMsgs.appendChild(typingEl);
    scrollAiChatBottom();

    // Create streaming message element
    let streamMsg = null;

    await streamChatMessage(content, aiConversationId, {
      onText(text) {
        // Replace typing indicator with streaming message on first text
        if (!streamMsg) {
          typingEl.remove();
          streamMsg = createStreamingMessage();
          aiChatMsgs.appendChild(streamMsg.element);
        }
        streamMsg.appendText(text);
        scrollAiChatBottom();
      },
      onDone(event) {
        if (streamMsg) {
          streamMsg.finalize(new Date().toISOString());
        } else {
          typingEl.remove();
        }
        aiConversationId = event.conversation_id;
        aiIsStreaming = false;
        aiChatSendBtn.disabled = !aiChatInput.value.trim();
      },
      onProfileGenerated(event) {
        // Show profile notification in chat
        const notif = document.createElement('div');
        notif.className = 'ai-notification';
        notif.innerHTML = `
          <span class="ai-notif-icon">✨</span>
          <span>יצרתי לך פרופיל אישיות! <button class="ai-notif-link" id="viewProfileBtn">לצפייה</button></span>
        `;
        aiChatMsgs.appendChild(notif);
        scrollAiChatBottom();

        // TODO: Hook up viewProfileBtn to personality viz (Phase 4)
      },
      onSearchStarted(event) {
        // Show search notification in chat
        const notif = document.createElement('div');
        notif.className = 'ai-notification';
        notif.innerHTML = `
          <span class="ai-notif-icon">🔍</span>
          <span>מחפש לך אנשים מתאימים...</span>
        `;
        aiChatMsgs.appendChild(notif);
        scrollAiChatBottom();
      },
      onError(message) {
        typingEl.remove();
        if (streamMsg) streamMsg.finalize(new Date().toISOString());
        toast(message, 'error');
        aiIsStreaming = false;
        aiChatSendBtn.disabled = !aiChatInput.value.trim();
      },
    });
  }

  function scrollAiChatBottom() {
    aiChatMsgs.scrollTop = aiChatMsgs.scrollHeight;
  }

  function adjustAiTextarea() {
    aiChatInput.style.height = 'auto';
    aiChatInput.style.height = Math.min(aiChatInput.scrollHeight, 120) + 'px';
  }

  // Event listeners
  $('aiChatForm').addEventListener('submit', (e) => { e.preventDefault(); sendAiMessage(aiChatInput.value); });
  aiChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage(aiChatInput.value); }
  });
  aiChatInput.addEventListener('input', () => {
    aiChatSendBtn.disabled = !aiChatInput.value.trim() || aiIsStreaming;
    adjustAiTextarea();
  });

  // Suggestion chips
  document.querySelectorAll('.ai-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      sendAiMessage(chip.dataset.msg);
    });
  });

  // Back button
  $('aiChatBackBtn').addEventListener('click', () => {
    showView('welcome');
    document.title = 'בינדר';
  });

  // Welcome AI chat button
  $('welcomeAiChatBtn').addEventListener('click', () => openAiChat());
```

**Verify**: Open discover.html in browser, click "שוחח עם בינדר", type a message, see streaming response.

---

### Task 3.3 — Add AI Chat CSS Styles

**Modify**: `Binder/public/css/styles.css` (append at end)

```css
/* ── AI Chat Styles ──────────────────────────────────────── */
.ai-av {
  width: 34px; height: 34px; border-radius: 50%;
  background: linear-gradient(135deg, var(--accent) 0%, #7B6CB0 100%);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.ai-avatar-icon {
  font-family: var(--font-display);
  color: #fff; font-size: 1.1rem;
}

.ai-bub {
  background: var(--bg-elevated) !important;
  border: 1px solid var(--border-md);
}

/* Typing indicator */
.typing-dots {
  display: flex; gap: 4px; padding: 4px 0;
}
.typing-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-3);
  animation: typingBounce 1.4s infinite ease-in-out;
}
.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes typingBounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-6px); opacity: 1; }
}

/* Suggestion chips */
.ai-chips {
  display: flex; gap: 8px; flex-wrap: wrap;
  padding: 0 0 12px; justify-content: center;
}
.ai-chip {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: var(--r-full); padding: 8px 16px;
  color: var(--text-2); font-size: 0.82rem;
  cursor: pointer; transition: all 0.2s;
  font-family: inherit; white-space: nowrap;
}
.ai-chip:hover {
  background: var(--bg-hover); border-color: var(--border-md);
  color: var(--text-1);
}

/* In-chat notifications */
.ai-notification {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px; margin: 8px 0;
  background: var(--accent-surface);
  border: 1px solid var(--accent-border);
  border-radius: var(--r-md);
  font-size: 0.82rem; color: var(--text-2);
}
.ai-notif-icon { font-size: 1.1rem; flex-shrink: 0; }
.ai-notif-link {
  background: none; border: none;
  color: var(--accent); cursor: pointer;
  font-size: 0.82rem; font-family: inherit;
  text-decoration: underline;
  padding: 0;
}
.ai-notif-link:hover { color: var(--accent-hover); }
```

**Verify**: Check AI chat visually — typing dots animate, chips look right, streaming text appears smoothly.

---

## Phase 4: Personality Visualization (D3.js Bubbles)

### Task 4.1 — Create `personality-viz.js` Module

D3.js force simulation for Apple Music-style bubble visualization.

**Create**: `Binder/public/js/personality-viz.js`

```javascript
// Binder/public/js/personality-viz.js
// D3.js v7 bubble visualization for personality traits

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

const CATEGORY_COLORS = {
  skills:        '#E8654A',  // Coral
  interests:     '#4A90D9',  // Blue
  values:        '#4A8C6F',  // Sage
  communication: '#F0A030',  // Gold
  availability:  '#7B6CB0',  // Lavender
};

const CATEGORY_LABELS = {
  skills:        'מיומנויות',
  interests:     'תחומי עניין',
  values:        'ערכים',
  communication: 'סגנון תקשורת',
  availability:  'זמינות',
};

const MIN_RADIUS = 10;  // diameter 20px per spec
const MAX_RADIUS = 40;  // diameter 80px per spec

/**
 * Render personality bubbles into a container
 * @param {HTMLElement} container - DOM element to render into
 * @param {Array} traits - [{name, weight, category}, ...]
 * @param {object} options - { interactive: boolean, width?: number, height?: number, onTraitClick?: fn, onTraitDelete?: fn }
 * @returns {{ update: (traits) => void, destroy: () => void }}
 */
export function renderBubbles(container, traits, options = {}) {
  const {
    interactive = false,
    width = container.clientWidth || 360,
    height = container.clientHeight || 360,
    onTraitClick = null,
    onTraitDelete = null,
  } = options;

  // Clear container
  container.innerHTML = '';

  if (!traits || traits.length === 0) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:0.88rem;">אין נתוני אישיות עדיין</div>';
    return { update: () => {}, destroy: () => {} };
  }

  // Create SVG
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`)
    .style('overflow', 'visible');

  // Map traits to nodes
  const nodes = traits.map((t, i) => ({
    ...t,
    id: i,
    radius: MIN_RADIUS + t.weight * (MAX_RADIUS - MIN_RADIUS),
    color: CATEGORY_COLORS[t.category] || '#888',
  }));

  // Category cluster centers
  const categories = [...new Set(nodes.map(n => n.category))];
  const clusterCenters = {};
  const angleStep = (2 * Math.PI) / categories.length;
  const clusterRadius = Math.min(width, height) * 0.25;
  categories.forEach((cat, i) => {
    clusterCenters[cat] = {
      x: width / 2 + clusterRadius * Math.cos(angleStep * i - Math.PI / 2),
      y: height / 2 + clusterRadius * Math.sin(angleStep * i - Math.PI / 2),
    };
  });

  // Force simulation
  const simulation = d3.forceSimulation(nodes)
    .force('center', d3.forceCenter(width / 2, height / 2).strength(0.02))
    .force('charge', d3.forceManyBody().strength(-5))
    .force('collide', d3.forceCollide(d => d.radius + 3).strength(0.8))
    .force('cluster', (alpha) => {
      nodes.forEach(d => {
        const center = clusterCenters[d.category];
        if (!center) return;
        d.vx += (center.x - d.x) * alpha * 0.15;
        d.vy += (center.y - d.y) * alpha * 0.15;
      });
    })
    .force('bounds', () => {
      nodes.forEach(d => {
        d.x = Math.max(d.radius, Math.min(width - d.radius, d.x));
        d.y = Math.max(d.radius, Math.min(height - d.radius, d.y));
      });
    })
    .alphaDecay(0.02)
    .velocityDecay(0.3);

  // Draw bubbles
  const bubbleGroups = svg.selectAll('g.bubble')
    .data(nodes)
    .join('g')
    .attr('class', 'bubble')
    .style('cursor', interactive ? 'pointer' : 'default');

  // Circle
  bubbleGroups.append('circle')
    .attr('r', d => d.radius)
    .attr('fill', d => d.color)
    .attr('fill-opacity', 0.2)
    .attr('stroke', d => d.color)
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.6);

  // Text label
  bubbleGroups.append('text')
    .text(d => d.name)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('fill', '#F5F5F7')
    .attr('font-size', d => Math.max(9, d.radius * 0.38))
    .attr('font-family', "'Rubik', sans-serif")
    .attr('pointer-events', 'none')
    .each(function(d) {
      // Truncate text that doesn't fit
      const el = d3.select(this);
      const maxWidth = d.radius * 1.6;
      let text = d.name;
      while (el.node().getComputedTextLength() > maxWidth && text.length > 2) {
        text = text.slice(0, -1);
        el.text(text + '…');
      }
    });

  // Drag behavior (interactive mode)
  if (interactive) {
    bubbleGroups.call(
      d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    );

    // Click handler
    bubbleGroups.on('click', (event, d) => {
      event.stopPropagation();
      onTraitClick?.(d);
    });
  }

  // Tick — update positions
  simulation.on('tick', () => {
    bubbleGroups.attr('transform', d => `translate(${d.x}, ${d.y})`);
  });

  // Category legend
  const legend = svg.append('g')
    .attr('transform', `translate(12, ${height - categories.length * 20 - 8})`);

  categories.forEach((cat, i) => {
    const g = legend.append('g')
      .attr('transform', `translate(0, ${i * 20})`);

    g.append('circle')
      .attr('r', 5)
      .attr('cx', 5)
      .attr('cy', 0)
      .attr('fill', CATEGORY_COLORS[cat] || '#888')
      .attr('fill-opacity', 0.5);

    g.append('text')
      .attr('x', 16)
      .attr('y', 0)
      .attr('dominant-baseline', 'central')
      .attr('fill', '#9A9AA8')
      .attr('font-size', '0.7rem')
      .attr('font-family', "'Rubik', sans-serif")
      .text(CATEGORY_LABELS[cat] || cat);
  });

  // Entrance animation
  bubbleGroups
    .attr('opacity', 0)
    .transition()
    .duration(600)
    .delay((d, i) => i * 50)
    .attr('opacity', 1);

  return {
    update(newTraits) {
      // TODO: Animate trait updates in Phase 6
    },
    destroy() {
      simulation.stop();
      container.innerHTML = '';
    },
  };
}

/**
 * Render a comparison view: two sets of bubbles side-by-side
 * @param {HTMLElement} container
 * @param {Array} myTraits
 * @param {Array} theirTraits
 * @param {string} theirName
 */
export function renderComparison(container, myTraits, theirTraits, theirName) {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'bubble-comparison';
  const uid = Math.random().toString(36).slice(2, 8);
  wrapper.innerHTML = `
    <div class="bubble-col">
      <div class="bubble-col-label">אני</div>
      <div class="bubble-canvas" data-role="my-${uid}"></div>
    </div>
    <div class="bubble-divider"></div>
    <div class="bubble-col">
      <div class="bubble-col-label">${theirName || 'מועמד/ת'}</div>
      <div class="bubble-canvas" data-role="their-${uid}"></div>
    </div>
  `;
  container.appendChild(wrapper);

  const colWidth = (container.clientWidth - 32) / 2;
  const colHeight = container.clientHeight || 300;

  renderBubbles(wrapper.querySelector(`[data-role="my-${uid}"]`), myTraits, {
    width: colWidth, height: colHeight,
  });
  renderBubbles(wrapper.querySelector(`[data-role="their-${uid}"]`), theirTraits, {
    width: colWidth, height: colHeight,
  });
}

export { CATEGORY_COLORS, CATEGORY_LABELS };
```

**Verify**: Import in browser, call `renderBubbles(container, sampleTraits)` with test data.

---

### Task 4.2 — Add Personality Bubble View to `discover.html`

Add a profile bubble view that shows after profile generation, and a calibration slider panel.

**Modify**: `Binder/public/discover.html`

Add after the AI chat view:

```html
      <!-- Profile Bubbles View -->
      <div class="hidden" id="profileBubblesView" style="flex:1;display:flex;flex-direction:column;padding:20px;animation:fadeUp 0.4s ease;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <button class="cv-back" id="bubblesBackBtn" title="חזרה">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </button>
          <span style="font-size:1rem;font-weight:500;color:var(--text-1);">מפת האישיות שלי</span>
        </div>
        <div id="bubbleContainer" style="flex:1;min-height:300px;"></div>
        <!-- Calibration panel (shown on trait click) -->
        <div class="bubble-calibration hidden" id="bubbleCalibration">
          <div class="bubble-cal-header">
            <span class="bubble-cal-name" id="calTraitName"></span>
            <button class="bubble-cal-close" id="calCloseBtn">✕</button>
          </div>
          <input type="range" class="bubble-cal-slider" id="calSlider" min="0" max="100" value="50">
          <div class="bubble-cal-actions">
            <button class="btn btn-ghost btn-sm" id="calDeleteBtn" style="color:var(--red);">מחק תכונה</button>
            <button class="btn btn-primary btn-sm" id="calSaveBtn">שמור</button>
          </div>
        </div>
      </div>
```

Add import and connect personality viz:

```javascript
import { renderBubbles, renderComparison } from '/js/personality-viz.js';
```

Update `showView()` to handle `'profile-bubbles'`:

```javascript
  // In showView, add:
  $('profileBubblesView').classList.add('hidden');
  if (view === 'profile-bubbles') {
    $('profileBubblesView').classList.remove('hidden');
    topTitle.textContent = 'מפת אישיות';
  }
```

Add bubble view logic:

```javascript
  // Profile bubbles
  let bubbleInstance = null;

  async function openProfileBubbles() {
    showView('profile-bubbles');
    const profile = await getUserProfile(ME);
    if (profile && profile.traits) {
      if (bubbleInstance) bubbleInstance.destroy();
      bubbleInstance = renderBubbles($('bubbleContainer'), profile.traits, {
        interactive: true,
        onTraitClick(trait) {
          $('calTraitName').textContent = trait.name;
          $('calSlider').value = Math.round(trait.weight * 100);
          $('bubbleCalibration').classList.remove('hidden');
          $('bubbleCalibration').dataset.traitId = trait.id;
        },
      });
    }
  }

  $('bubblesBackBtn').addEventListener('click', () => {
    if (bubbleInstance) { bubbleInstance.destroy(); bubbleInstance = null; }
    showView('ai-chat');
  });

  $('calCloseBtn').addEventListener('click', () => {
    $('bubbleCalibration').classList.add('hidden');
  });

  $('calSaveBtn').addEventListener('click', async () => {
    const traitId = parseInt($('bubbleCalibration').dataset.traitId);
    const newWeight = parseInt($('calSlider').value) / 100;
    const profile = await getUserProfile(ME);
    if (!profile) return;

    const updatedTraits = profile.traits.map((t, i) =>
      i === traitId ? { ...t, weight: newWeight } : t
    );

    await supabase.from('binder_personality_profiles')
      .update({ traits: updatedTraits, version: (profile.version || 1) + 1, updated_at: new Date().toISOString() })
      .eq('user_id', ME);

    $('bubbleCalibration').classList.add('hidden');
    openProfileBubbles(); // Re-render
    toast('התכונה עודכנה', 'success');
  });

  $('calDeleteBtn').addEventListener('click', async () => {
    const traitId = parseInt($('bubbleCalibration').dataset.traitId);
    const profile = await getUserProfile(ME);
    if (!profile) return;

    const updatedTraits = profile.traits.filter((_, i) => i !== traitId);

    await supabase.from('binder_personality_profiles')
      .update({ traits: updatedTraits, version: (profile.version || 1) + 1, updated_at: new Date().toISOString() })
      .eq('user_id', ME);

    $('bubbleCalibration').classList.add('hidden');
    openProfileBubbles();
    toast('התכונה נמחקה', 'success');
  });
```

**Verify**: After profile generation via AI chat, click "לצפייה" → bubble view renders with interactive traits.

---

### Task 4.3 — Add Bubble CSS Styles

**Modify**: `Binder/public/css/styles.css` (append)

```css
/* ── Personality Bubbles ─────────────────────────────────── */
.bubble-calibration {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: var(--bg-surface);
  border-top: 1px solid var(--border);
  padding: 20px 24px;
  animation: slideUp 0.3s ease;
}
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

.bubble-cal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px;
}
.bubble-cal-name {
  font-size: 1rem; font-weight: 500; color: var(--text-1);
}
.bubble-cal-close {
  background: none; border: none; color: var(--text-3);
  cursor: pointer; font-size: 1.2rem; padding: 4px;
}
.bubble-cal-slider {
  width: 100%; margin: 8px 0 20px;
  accent-color: var(--accent);
}
.bubble-cal-actions {
  display: flex; justify-content: space-between; gap: 12px;
}

/* Comparison view */
.bubble-comparison {
  display: flex; gap: 16px; height: 100%;
}
.bubble-col {
  flex: 1; display: flex; flex-direction: column;
}
.bubble-col-label {
  text-align: center; font-size: 0.85rem; font-weight: 500;
  color: var(--text-2); margin-bottom: 8px;
}
.bubble-canvas {
  flex: 1; min-height: 200px;
}
.bubble-divider {
  width: 1px; background: var(--border); margin: 20px 0;
}
```

---

## Phase 5: Match Search Edge Function

### Task 5.1 — Deploy `match-search` Edge Function

This function fetches all profiles, sends them to Claude Sonnet for ranking, and creates match candidates.

**Save locally**: `supabase/functions/match-search/index.ts`
**Deploy via**: `deploy_edge_function` MCP tool

```typescript
// supabase/functions/match-search/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Validate auth — this function is called internally by claude-chat
    // using the service role key, so we validate against it
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!authHeader || authHeader !== `Bearer ${supabaseServiceKey}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { request_id, criteria, requester_id } = await req.json();

    if (!request_id || !requester_id) {
      return new Response(JSON.stringify({ error: "Missing request_id or requester_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all personality profiles except requester
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from("binder_personality_profiles")
      .select(`
        user_id,
        traits,
        summary,
        embedding_text
      `)
      .neq("user_id", requester_id);

    if (profilesError) throw profilesError;

    if (!profiles || profiles.length === 0) {
      // No candidates — update request status
      await supabaseAdmin
        .from("binder_match_requests")
        .update({ status: "expired" })
        .eq("id", request_id);

      return new Response(JSON.stringify({ candidates: [], message: "No profiles found" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Enrich profiles with user info
    const userIds = profiles.map((p) => p.user_id);
    const { data: userProfiles } = await supabaseAdmin
      .from("binder_profiles")
      .select("id, full_name, age, location, bio")
      .in("id", userIds);

    const userMap = new Map((userProfiles || []).map((u) => [u.id, u]));

    const enrichedProfiles = profiles.map((p) => ({
      user_id: p.user_id,
      name: userMap.get(p.user_id)?.full_name || "Unknown",
      age: userMap.get(p.user_id)?.age,
      location: userMap.get(p.user_id)?.location,
      bio: userMap.get(p.user_id)?.bio,
      traits: p.traits,
      summary: p.summary,
    }));

    // Call Claude Sonnet for ranking
    const anthropic = new Anthropic();

    const searchPrompt = `אתה מנוע התאמה של פלטפורמת בינדר — עזרה הדדית.

הקריטריונים של המחפש:
${JSON.stringify(criteria, null, 2)}

הפרופילים הזמינים:
${enrichedProfiles.map((p, i) => `[${i}] ${p.name}${p.age ? `, ${p.age}` : ""}${p.location ? `, ${p.location}` : ""}
  סיכום: ${p.summary || "לא זמין"}
  תכונות: ${JSON.stringify(p.traits?.slice(0, 8) || [])}
  ביו: ${p.bio || "לא זמין"}`).join("\n\n")}

דרג את המועמדים לפי התאמה לקריטריונים. עבור כל מועמד תן:
- ציון 0-100
- הסבר קצר בעברית למה הוא מתאים

החזר JSON בפורמט:
{
  "rankings": [
    { "index": 0, "score": 85, "explanation": "..." },
    ...
  ]
}

החזר רק את ה-5 הכי מתאימים, ממוינים לפי ציון יורד. אם אין מועמדים מתאימים (ציון < 30), החזר מערך ריק.`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-0",
      max_tokens: 2048,
      messages: [{ role: "user", content: searchPrompt }],
    });

    const responseText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Parse rankings
    let rankings = [];
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        rankings = parsed.rankings || [];
      }
    } catch (e) {
      console.error("Failed to parse rankings:", e);
    }

    if (rankings.length === 0) {
      await supabaseAdmin
        .from("binder_match_requests")
        .update({ status: "expired" })
        .eq("id", request_id);

      return new Response(JSON.stringify({ candidates: [], message: "No suitable matches found" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create match candidates
    const candidates = rankings
      .filter((r) => r.score >= 30 && enrichedProfiles[r.index])
      .slice(0, 5)
      .map((r) => ({
        request_id,
        candidate_id: enrichedProfiles[r.index].user_id,
        compatibility_score: r.score,
        compatibility_explanation: r.explanation,
        notified_at: new Date().toISOString(),
      }));

    if (candidates.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from("binder_match_candidates")
        .insert(candidates);

      if (insertError) throw insertError;

      // Update request status
      await supabaseAdmin
        .from("binder_match_requests")
        .update({ status: "pending_approval" })
        .eq("id", request_id);
    }

    return new Response(
      JSON.stringify({ candidates: candidates.length, message: `Found ${candidates.length} candidates` }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("match-search error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
```

**Verify**: Deploy via `deploy_edge_function`. Test by creating a match request and calling the function directly.

---

## Phase 6: Matching Pipeline UI

### Task 6.1 — Create `matching.js` Module

Frontend module for the matching pipeline: viewing requests, approving candidacies, selecting matches.

**Create**: `Binder/public/js/matching.js`

```javascript
// Binder/public/js/matching.js
// Matching pipeline UI module

import { supabase } from '/js/config.js';
import { esc, toast, formatTime, avatarUrl } from '/js/utils.js';

/**
 * Load pending match candidacies for current user (APPROVE step)
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function loadPendingCandidacies(userId) {
  const { data, error } = await supabase
    .from('binder_match_candidates')
    .select(`
      id, compatibility_score, compatibility_explanation, status, created_at,
      binder_match_requests!inner(id, description, requester_id, extracted_criteria)
    `)
    .eq('candidate_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('loadPendingCandidacies error:', error);
    return [];
  }
  return data || [];
}

/**
 * Respond to a match candidacy (approve / reject)
 * @param {string} candidacyId
 * @param {'approved'|'rejected'} response
 */
export async function respondToCandidacy(candidacyId, response) {
  const { error } = await supabase
    .from('binder_match_candidates')
    .update({
      status: response,
      responded_at: new Date().toISOString(),
    })
    .eq('id', candidacyId);

  if (error) {
    toast('שגיאה בשליחת תגובה', 'error');
    return false;
  }
  return true;
}

/**
 * Load active match requests for current user with their candidates (SELECT step)
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function loadMyRequests(userId) {
  const { data, error } = await supabase
    .from('binder_match_requests')
    .select(`
      id, description, extracted_criteria, status, created_at, expires_at
    `)
    .eq('requester_id', userId)
    .in('status', ['searching', 'pending_approval', 'ready'])
    .order('created_at', { ascending: false });

  if (error) {
    console.error('loadMyRequests error:', error);
    return [];
  }
  return data || [];
}

/**
 * Load approved candidates for a specific request
 * @param {string} requestId
 * @returns {Promise<Array>}
 */
export async function loadApprovedCandidates(requestId) {
  const { data, error } = await supabase
    .from('binder_match_candidates')
    .select('id, candidate_id, compatibility_score, compatibility_explanation, status')
    .eq('request_id', requestId)
    .eq('status', 'approved')
    .order('compatibility_score', { ascending: false });

  if (error) {
    console.error('loadApprovedCandidates error:', error);
    return [];
  }

  // Enrich with profile data
  if (data && data.length > 0) {
    const candidateIds = data.map(c => c.candidate_id);
    const { data: profiles } = await supabase
      .from('binder_profiles')
      .select('id, full_name, avatar_url, location, age')
      .in('id', candidateIds);

    const { data: personalityProfiles } = await supabase
      .from('binder_personality_profiles')
      .select('user_id, traits, summary')
      .in('user_id', candidateIds);

    const profileMap = new Map((profiles || []).map(p => [p.id, p]));
    const personalityMap = new Map((personalityProfiles || []).map(p => [p.user_id, p]));

    return data.map(c => ({
      ...c,
      profile: profileMap.get(c.candidate_id),
      personality: personalityMap.get(c.candidate_id),
    }));
  }

  return data || [];
}

/**
 * Select a candidate — create match and connect
 * @param {string} requestId
 * @param {string} candidateId
 * @param {string} requesterId
 * @returns {Promise<string|null>} matchId or null
 */
export async function selectCandidate(requestId, candidateId, requesterId) {
  // Create match in binder_matches
  const { data: match, error: matchError } = await supabase
    .from('binder_matches')
    .insert({
      user1_id: requesterId,
      user2_id: candidateId,
    })
    .select('id')
    .single();

  if (matchError) {
    // Check if match already exists
    if (matchError.message.includes('duplicate')) {
      const { data: existing } = await supabase
        .from('binder_matches')
        .select('id')
        .or(`and(user1_id.eq.${requesterId},user2_id.eq.${candidateId}),and(user1_id.eq.${candidateId},user2_id.eq.${requesterId})`)
        .maybeSingle();
      if (existing) return existing.id;
    }
    toast('שגיאה ביצירת ההתאמה', 'error');
    return null;
  }

  // Update request status to completed
  await supabase
    .from('binder_match_requests')
    .update({ status: 'completed' })
    .eq('id', requestId);

  return match.id;
}

/**
 * Render a candidacy approval card
 * @param {object} candidacy - From loadPendingCandidacies
 * @returns {HTMLElement}
 */
export function renderCandidacyCard(candidacy) {
  const request = candidacy.binder_match_requests;
  const card = document.createElement('div');
  card.className = 'match-req-card';
  card.dataset.candidacyId = candidacy.id;
  card.innerHTML = `
    <div class="match-req-header">
      <span class="match-req-icon">🎯</span>
      <span class="match-req-title">בקשת עזרה חדשה</span>
      <span class="match-req-time">${formatTime(candidacy.created_at)}</span>
    </div>
    <p class="match-req-desc">${esc(request.description)}</p>
    <div class="match-req-score">
      <span>התאמה: ${Math.round(candidacy.compatibility_score || 0)}%</span>
    </div>
    <p class="match-req-explanation">${esc(candidacy.compatibility_explanation || '')}</p>
    <div class="match-req-actions">
      <button class="btn btn-ghost btn-sm match-reject-btn">לא עכשיו</button>
      <button class="btn btn-ghost btn-sm match-askmore-btn">ספר לי עוד</button>
      <button class="btn btn-primary btn-sm match-approve-btn">אני פתוח/ה לזה</button>
    </div>
  `;
  return card;
}

/**
 * Subscribe to new candidacies for a user
 * @param {string} userId
 * @param {function} callback
 * @returns {object} subscription
 */
export function subscribeToCandidacies(userId, callback) {
  return supabase
    .channel(`candidacies:${userId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'binder_match_candidates',
      filter: `candidate_id=eq.${userId}`,
    }, callback)
    .subscribe();
}
```

**Verify**: File created, imports work.

---

### Task 6.2 — Add Matching Pipeline Views to `discover.html`

Add the matching request/approval/selection views to discover.html and integrate with the sidebar.

**Modify**: `Binder/public/discover.html`

Add new views in the main body area, and add matching sidebar section. Wire up the full pipeline.

This is a large integration task. The key additions:

1. **Match Request View** — shown to candidates who received an approval request
2. **Candidate Selection View** — shown to requester when candidates have approved
3. **Sidebar "Active Requests" section** — notification badges
4. **Realtime subscription** on `binder_match_candidates` for live notifications

Add matching module import:
```javascript
import { loadPendingCandidacies, respondToCandidacy, loadMyRequests, loadApprovedCandidates, selectCandidate, renderCandidacyCard, subscribeToCandidacies } from '/js/matching.js';
```

Add HTML for the match request view:
```html
      <!-- Match Request View (candidate sees this) -->
      <div class="hidden" id="matchRequestView" style="flex:1;display:flex;flex-direction:column;padding:24px;animation:fadeUp 0.4s ease;overflow-y:auto;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
          <button class="cv-back" id="matchReqBackBtn" title="חזרה">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </button>
          <span style="font-size:1rem;font-weight:500;color:var(--text-1);">בקשות ממתינות</span>
        </div>
        <div id="pendingRequestsList"></div>
      </div>

      <!-- Candidate Selection View (requester sees approved candidates) -->
      <div class="hidden" id="candidateSelectView" style="flex:1;display:flex;flex-direction:column;padding:24px;animation:fadeUp 0.4s ease;overflow-y:auto;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
          <button class="cv-back" id="candidateSelectBackBtn" title="חזרה">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </button>
          <span style="font-size:1rem;font-weight:500;color:var(--text-1);">מועמדים מתאימים</span>
        </div>
        <div id="approvedCandidatesList"></div>
      </div>
```

Update `showView()` to handle the new views. Add matching pipeline logic for approval, selection, and connection flow.

Add to sidebar: an "Active Requests" section with notification badges that links to the new views.

**CSS for matching cards** (append to styles.css):

```css
/* ── Matching Pipeline ───────────────────────────────────── */
.match-req-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 20px;
  margin-bottom: 12px;
}
.match-req-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 12px;
}
.match-req-icon { font-size: 1.2rem; }
.match-req-title {
  font-size: 0.9rem; font-weight: 500; color: var(--text-1); flex: 1;
}
.match-req-time { font-size: 0.72rem; color: var(--text-4); }
.match-req-desc {
  color: var(--text-2); font-size: 0.88rem;
  line-height: 1.6; margin: 0 0 12px;
}
.match-req-score {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--accent-surface); border: 1px solid var(--accent-border);
  border-radius: var(--r-full); padding: 4px 12px;
  font-size: 0.78rem; color: var(--accent);
  margin-bottom: 8px;
}
.match-req-explanation {
  color: var(--text-3); font-size: 0.82rem;
  line-height: 1.5; margin: 0 0 16px;
}
.match-req-actions {
  display: flex; gap: 8px; justify-content: flex-end;
}

/* Candidate selection card */
.candidate-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 20px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.candidate-card:hover {
  border-color: var(--border-md);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}
.candidate-card-head {
  display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
}
.candidate-card-av {
  width: 48px; height: 48px; border-radius: 50%;
  overflow: hidden; flex-shrink: 0; background: var(--bg-elevated);
}
.candidate-card-av img { width: 100%; height: 100%; object-fit: cover; }
.candidate-card-name {
  font-size: 0.95rem; font-weight: 500; color: var(--text-1);
}
.candidate-card-location {
  font-size: 0.78rem; color: var(--text-3); margin-top: 2px;
}
.candidate-card-score {
  margin-right: auto;
  background: var(--accent-surface); border: 1px solid var(--accent-border);
  border-radius: var(--r-full); padding: 4px 12px;
  font-size: 0.82rem; color: var(--accent); font-weight: 500;
}
.candidate-card-explanation {
  color: var(--text-2); font-size: 0.85rem; line-height: 1.5; margin-bottom: 12px;
}
.candidate-card-bubbles {
  height: 200px; margin-bottom: 12px;
}
.candidate-card-action {
  display: flex; justify-content: center;
}

/* Sidebar notification badge */
.sb-badge {
  background: var(--accent);
  color: #fff; font-size: 0.65rem; font-weight: 600;
  min-width: 18px; height: 18px;
  border-radius: var(--r-full);
  display: flex; align-items: center; justify-content: center;
  padding: 0 5px; flex-shrink: 0;
}

/* Sidebar section header */
.sb-section {
  padding: 12px 20px 4px;
  font-size: 0.72rem; color: var(--text-4);
  text-transform: uppercase; letter-spacing: 0.05em;
}
```

**Verify**: Full matching pipeline works end-to-end: AI chat → search triggered → candidates found → approval notifications → selection → match created → human chat opens.

---

## Phase 7: Sidebar Updates & Integration

### Task 7.1 — Update Sidebar with Active Requests Section

**Modify**: `Binder/public/discover.html`

Add a section in the sidebar between the header and the match list:

```html
    <!-- In sidebar, after sb-head -->
    <div class="sb-section hidden" id="sbRequestsSection">בקשות פעילות</div>
    <div id="sbRequestsList"></div>
```

Add logic to load and render active requests in sidebar:

```javascript
  async function loadSidebarRequests() {
    const pendingCandidacies = await loadPendingCandidacies(ME);
    const myRequests = await loadMyRequests(ME);

    const requestsList = $('sbRequestsList');
    const section = $('sbRequestsSection');
    requestsList.innerHTML = '';

    const hasItems = pendingCandidacies.length > 0 || myRequests.length > 0;
    section.classList.toggle('hidden', !hasItems);

    // Pending candidacies (someone wants my help)
    pendingCandidacies.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'sb-item';
      btn.innerHTML = `
        <div class="sb-item-av" style="background:var(--accent-surface);display:flex;align-items:center;justify-content:center;">
          <span style="font-size:1.2rem;">🎯</span>
        </div>
        <div class="sb-item-body">
          <div class="sb-item-name">בקשת עזרה</div>
          <div class="sb-item-preview">${esc(c.binder_match_requests.description.slice(0, 40))}...</div>
        </div>
        <span class="sb-badge">חדש</span>
      `;
      btn.addEventListener('click', () => openMatchRequests());
      requestsList.appendChild(btn);
    });

    // My requests with approved candidates (ready for selection)
    for (const req of myRequests.filter(r => r.status === 'ready')) {
      const btn = document.createElement('button');
      btn.className = 'sb-item';
      btn.innerHTML = `
        <div class="sb-item-av" style="background:var(--gold-surface);display:flex;align-items:center;justify-content:center;">
          <span style="font-size:1.2rem;">✨</span>
        </div>
        <div class="sb-item-body">
          <div class="sb-item-name">נמצאו מועמדים!</div>
          <div class="sb-item-preview">${esc(req.description.slice(0, 40))}...</div>
        </div>
        <span class="sb-badge" style="background:var(--gold);">בחר</span>
      `;
      btn.addEventListener('click', () => openCandidateSelection(req.id));
      requestsList.appendChild(btn);
    }
  }
```

Integrate `loadSidebarRequests()` into the init flow and Realtime subscription.

### Task 7.2 — Subscribe to Real-time Matching Updates

```javascript
  // Add after existing realtime subscriptions:
  subscribeToCandidacies(ME, (payload) => {
    loadSidebarRequests();
    toast('יש בקשת עזרה חדשה!', 'default');
  });

  // Also subscribe to match_requests status changes
  supabase.channel('my-requests')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'binder_match_requests',
      filter: `requester_id=eq.${ME}`,
    }, (payload) => {
      if (payload.new.status === 'ready') {
        loadSidebarRequests();
        toast('מועמדים אישרו! בוא לבחור', 'success');
      }
    })
    .subscribe();
```

**Verify**: Full end-to-end flow works: User A searches → candidates notified in real-time → User B approves → User A sees "ready" in sidebar → selects → match created → chat opens.

---

## Self-Review Checklist

- [x] **pgvector**: Task 1.1 enables it before `vector(512)` column in Task 1.4
- [x] **Model IDs**: `claude-haiku-4-5` and `claude-sonnet-4-0` (aliases, confirmed correct)
- [x] **`binder_ai_conversations`**: Task 1.2 creates it (spec amendment: better grouping than `match_id`-only approach)
- [x] **`binder_messages` alterations**: Task 1.3 — `match_id`/`sender_id` nullable, adds `role`, `message_type`, `conversation_id`
- [x] **RLS on all tables**: Tasks 1.2-1.5 include RLS; `binder_personality_profiles` SELECT restricted to own + approved-match profiles
- [x] **Service role key**: Used in Edge Functions for cross-user DB ops (not exposed to frontend)
- [x] **`match-search` auth**: Validates service role key in Authorization header (internal-only endpoint)
- [x] **ANTHROPIC_API_KEY**: User must set as Supabase secret before Task 2.1
- [x] **SSE streaming**: Task 2.2 uses `ReadableStream`; frontend Task 3.1 uses `fetch` + `getReader()`
- [x] **Tool use**: Task 2.3 — `generate_profile` and `trigger_search` tools
- [x] **Rate limiting**: 30 msgs/hour (Task 2.1), max 3 active requests (Task 2.3)
- [x] **Context window**: Last 20 messages (Task 2.1)
- [x] **D3.js v7**: Task 4.1 imports from jsdelivr CDN (already in CSP)
- [x] **5 personality dimensions**: Colors match spec exactly (Task 4.1)
- [x] **Bubble sizes**: Radius 10-40px (diameter 20-80px per spec)
- [x] **Bubble interactions**: Tap/click (slider), drag (cosmetic), delete — Tasks 4.1-4.2
- [x] **5-step pipeline**: REQUEST → SEARCH → APPROVE → SELECT → CONNECT
- [x] **Candidate privacy**: Candidates don't see requester identity (Task 5.1, 6.1)
- [x] **"Ask more" option**: Included in candidacy card (Task 6.1)
- [x] **Realtime publications**: Both `binder_match_candidates` AND `binder_match_requests` added to Realtime
- [x] **Realtime subscriptions**: Task 7.2 subscribes to both tables
- [x] **Existing code preserved**: Swipe model hidden, not deleted; direct chat unchanged
- [x] **Frontend patterns**: ES module imports, `const $ = id => ...`, IIFE, `showView()` — all maintained
- [x] **`config.js` export**: `SUPABASE_URL` exported for use in `ai-chat.js`
- [x] **Prompt caching**: `cache_control: { type: "ephemeral" }` on system prompt (Task 2.1)
- [x] **Edge Function deployment**: Via MCP `deploy_edge_function` tool, NOT filesystem
- [x] **DB migrations**: Via MCP `apply_migration` tool
- [x] **`binder_match_requests` UPDATE policy**: Added for SELECT→CONNECT flow

### Known Deferred Items
- **Request expiry (48h/72h timeouts)**: Requires pg_cron or scheduled Edge Function. Will be added as a post-MVP task — on-access checks sufficient for <100 users.
- **Icebreaker message**: The CONNECT step should generate a Claude icebreaker message. Will be wired up during Phase 6 integration.
- **`conversation_id` vs `match_id`**: Plan uses `conversation_id` (spec amendment) for better AI chat grouping. The `match_id` field remains available for human-to-human chats.

---

## Execution

**Recommended**: Subagent-Driven Development

Tasks are designed to be executed sequentially by phase, with independent tasks within each phase parallelizable:

- **Phase 1** (DB): Tasks 1.1-1.5 should run sequentially (FK dependencies)
- **Phase 2** (Edge Function): Tasks 2.1 → 2.2 → 2.3 sequential (each builds on previous)
- **Phase 3** (Frontend): Tasks 3.1-3.3 can run in parallel (separate files)
- **Phase 4** (D3.js): Tasks 4.1-4.3 can partially parallelize (4.1 || 4.3, then 4.2)
- **Phase 5** (Match Search): Task 5.1 standalone
- **Phase 6** (Matching UI): Tasks 6.1-6.2 sequential
- **Phase 7** (Integration): Tasks 7.1-7.2 sequential

**Total tasks**: ~18 bite-sized tasks across 7 phases
