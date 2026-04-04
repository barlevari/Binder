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
