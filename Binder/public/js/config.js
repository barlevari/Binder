// ── Supabase Client ─────────────────────────────────────────
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL  = 'https://tiizdtmjygneptxeplnm.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpaXpkdG1qeWduZXB0eGVwbG5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTQ5NzgsImV4cCI6MjA5MDczMDk3OH0.uUsivRNOp3r6KAf6vAmXENU7l6bsT0qjpxni7buR4YU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// ── App Routes ──────────────────────────────────────────────
export const ROUTES = {
  home:        '/',
  auth:        '/auth.html',
  onboarding:  '/onboarding.html',
  discover:    '/discover.html',
  matches:     '/matches.html',
  chat:        '/chat.html',
  profile:     '/profile.html',
};

// ── Skill suggestions ────────────────────────────────────────
export const SKILL_SUGGESTIONS = [
  'JavaScript', 'Python', 'React', 'Node.js', 'TypeScript',
  'עיצוב גרפי', 'UI/UX', 'Figma', 'Photoshop',
  'אנגלית', 'ספרדית', 'צרפתית', 'ערבית',
  'מתמטיקה', 'פיזיקה', 'כימיה', 'ביולוגיה',
  'גיטרה', 'פסנתר', 'שירה',
  'צילום', 'וידאו', 'עריכה',
  'כושר', 'יוגה', 'תזונה',
  'ניהול פרויקטים', 'Excel', 'Word',
  'בישול', 'אפייה',
  'נגרות', 'חשמל', 'אינסטלציה',
];
