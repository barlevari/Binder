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
