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
    // Auth: only accept internal calls with service role key
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!authHeader || authHeader !== `Bearer ${supabaseServiceKey}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { request_id, criteria, requester_id } = await req.json();

    if (!request_id || !requester_id) {
      return new Response(JSON.stringify({ error: "Missing request_id or requester_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all personality profiles except requester
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from("binder_personality_profiles")
      .select("user_id, traits, summary, embedding_text")
      .neq("user_id", requester_id);

    if (profilesError) throw profilesError;

    if (!profiles || profiles.length === 0) {
      await supabaseAdmin.from("binder_match_requests")
        .update({ status: "expired" }).eq("id", request_id);
      return new Response(JSON.stringify({ candidates: 0, message: "No profiles found" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Enrich with user info
    const userIds = profiles.map(p => p.user_id);
    const { data: userProfiles } = await supabaseAdmin
      .from("binder_profiles")
      .select("id, full_name, age, location, bio")
      .in("id", userIds);

    const userMap = new Map((userProfiles || []).map(u => [u.id, u]));

    const enrichedProfiles = profiles.map(p => ({
      user_id: p.user_id,
      name: userMap.get(p.user_id)?.full_name || "Unknown",
      age: userMap.get(p.user_id)?.age,
      location: userMap.get(p.user_id)?.location,
      bio: userMap.get(p.user_id)?.bio,
      traits: p.traits,
      summary: p.summary,
    }));

    // Claude Sonnet ranking
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
    { "index": 0, "score": 85, "explanation": "..." }
  ]
}

החזר רק את ה-5 הכי מתאימים, ממוינים לפי ציון יורד. אם אין מועמדים מתאימים (ציון < 30), החזר מערך ריק.`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-0",
      max_tokens: 2048,
      messages: [{ role: "user", content: searchPrompt }],
    });

    const responseText = response.content
      .filter(b => b.type === "text").map(b => b.text).join("");

    let rankings: Array<{ index: number; score: number; explanation: string }> = [];
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
      await supabaseAdmin.from("binder_match_requests")
        .update({ status: "expired" }).eq("id", request_id);
      return new Response(JSON.stringify({ candidates: 0, message: "No suitable matches found" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create match candidates
    const candidates = rankings
      .filter(r => r.score >= 30 && enrichedProfiles[r.index])
      .slice(0, 5)
      .map(r => ({
        request_id,
        candidate_id: enrichedProfiles[r.index].user_id,
        compatibility_score: r.score,
        compatibility_explanation: r.explanation,
        notified_at: new Date().toISOString(),
      }));

    if (candidates.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from("binder_match_candidates").insert(candidates);
      if (insertError) throw insertError;

      await supabaseAdmin.from("binder_match_requests")
        .update({ status: "pending_approval" }).eq("id", request_id);
    }

    return new Response(
      JSON.stringify({ candidates: candidates.length, message: `Found ${candidates.length} candidates` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("match-search error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
