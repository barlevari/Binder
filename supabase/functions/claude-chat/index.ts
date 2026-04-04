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

const TOOLS: Anthropic.Messages.Tool[] = [
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { conversation_id, message } = await req.json();
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Message is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get or create conversation
    let convId = conversation_id;
    if (!convId) {
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

    // Fetch conversation history (last 20)
    const { data: history } = await supabaseAdmin
      .from("binder_messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(20);

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

    // SSE streaming response
    const anthropic = new Anthropic();
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
            tools: TOOLS,
          });

          let fullText = "";

          messageStream.on("text", (text) => {
            fullText += text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text_delta", text })}\n\n`));
          });

          const finalMessage = await messageStream.finalMessage();

          // Store assistant text response
          if (fullText) {
            await supabaseAdmin.from("binder_messages").insert({
              conversation_id: convId,
              role: "assistant",
              message_type: "chat",
              content: fullText,
            });
          }

          // Handle tool use
          for (const block of finalMessage.content) {
            if (block.type !== "tool_use") continue;

            if (block.name === "generate_profile") {
              const input = block.input as any;

              // Refine with Sonnet
              let profileData = input;
              try {
                const profileResponse = await anthropic.messages.create({
                  model: "claude-sonnet-4-0",
                  max_tokens: 2048,
                  system: "You are a personality profiler. Given extracted traits, refine the profile. Return valid JSON only with keys: traits, summary, embedding_text.",
                  messages: [{
                    role: "user",
                    content: `Refine this personality profile:\n${JSON.stringify(input)}\n\nReturn same structure with refined weights and any additional inferred traits.`,
                  }],
                });
                const text = profileResponse.content.filter(b => b.type === "text").map(b => b.text).join("");
                const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
                if (parsed.traits) profileData = parsed;
              } catch { /* fallback to original */ }

              await supabaseAdmin.from("binder_personality_profiles").upsert({
                user_id: user.id,
                traits: profileData.traits || input.traits,
                summary: profileData.summary || input.summary,
                embedding_text: profileData.embedding_text || input.embedding_text,
                raw_conversation_id: convId,
              }, { onConflict: "user_id" });

              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: "profile_generated",
                traits: profileData.traits || input.traits,
                summary: profileData.summary || input.summary,
              })}\n\n`));

            } else if (block.name === "trigger_search") {
              const input = block.input as any;

              // Check max 3 active requests
              const { count: activeRequests } = await supabaseAdmin
                .from("binder_match_requests")
                .select("id", { count: "exact", head: true })
                .eq("requester_id", user.id)
                .in("status", ["searching", "pending_approval", "ready"]);

              if ((activeRequests ?? 0) >= 3) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  type: "search_limit",
                  message: "יש לך כבר 3 חיפושים פעילים. חכה שהם יסתיימו.",
                })}\n\n`));
              } else {
                const { data: matchRequest, error: reqError } = await supabaseAdmin
                  .from("binder_match_requests")
                  .insert({
                    requester_id: user.id,
                    conversation_id: convId,
                    description: input.description,
                    extracted_criteria: {
                      required_skills: input.required_skills || [],
                      preferred_traits: input.preferred_traits || [],
                      purpose: input.purpose || "other",
                    },
                  })
                  .select("id")
                  .single();

                if (!reqError && matchRequest) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    type: "search_started",
                    request_id: matchRequest.id,
                    description: input.description,
                  })}\n\n`));

                  // Fire-and-forget match-search
                  fetch(`${supabaseUrl}/functions/v1/match-search`, {
                    method: "POST",
                    headers: {
                      "Authorization": `Bearer ${supabaseServiceKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      request_id: matchRequest.id,
                      criteria: input,
                      requester_id: user.id,
                    }),
                  }).catch(e => console.error("match-search trigger error:", e));
                }
              }
            }
          }

          // Done event
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "done",
            conversation_id: convId,
            full_response: fullText,
            usage: finalMessage.usage,
          })}\n\n`));
          controller.close();
        } catch (err) {
          console.error("Stream error:", err);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`));
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
  } catch (err) {
    console.error("claude-chat error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
