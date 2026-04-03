// ── Security: XSS escape ─────────────────────────────────────
export function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Toast Notifications ──────────────────────────────────────
let toastContainer = null;

function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      document.body.appendChild(toastContainer);
    }
  }
  return toastContainer;
}

export function toast(message, type = 'default', duration = 3500) {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const icons = { success: '✓', error: '✕', warning: '⚠', default: 'ℹ' };
  el.innerHTML = `<span>${icons[type] || icons.default}</span><span>${esc(message)}</span>`;

  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    el.style.transition = '0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ── Loading Button helper ────────────────────────────────────
export function setLoading(btn, loading, text = '') {
  if (loading) {
    btn.disabled = true;
    btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = `<div class="spinner"></div>`;
  } else {
    btn.disabled = false;
    btn.innerHTML = text || btn.dataset.originalText || btn.innerHTML;
  }
}

// ── Time formatting (Hebrew) ─────────────────────────────────
export function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;

  if (diff < 60_000)      return 'עכשיו';
  if (diff < 3600_000)    return `לפני ${Math.floor(diff / 60_000)} ד׳`;
  if (diff < 86400_000)   return `לפני ${Math.floor(diff / 3600_000)} ש׳`;
  if (diff < 604800_000)  return `לפני ${Math.floor(diff / 86400_000)} ימים`;

  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
}

export function formatFullTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'היום';

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'אתמול';

  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Avatar URL (initials-based SVG) ─────────────────────────
export function avatarUrl(seed, size = 80) {
  const colors = ['E8685A','D4A853','6B8F71','5B7DB1','9B6B9E','C47A5A','5A9E8F','7B68AE'];
  const hash = String(seed || 'default').split('').reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0), 0);
  const bg = colors[Math.abs(hash) % colors.length];
  const letter = String(seed || '?').charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size/2}" fill="%23${bg}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="white" font-family="sans-serif" font-size="${size*0.4}" font-weight="600">${letter}</text></svg>`;
  return `data:image/svg+xml,${svg}`;
}

// ── Input validation ─────────────────────────────────────────
export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(pw) {
  return pw && pw.length >= 8;
}

// ── Guard: redirect if not logged in ────────────────────────
export async function requireAuth(supabase) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = '/auth.html';
    return null;
  }
  return session;
}

// ── Guard: redirect if not onboarded ────────────────────────
export async function requireOnboarding(supabase) {
  const session = await requireAuth(supabase);
  if (!session) return null;

  const { data: profile } = await supabase
    .from('binder_profiles')
    .select('onboarding_complete')
    .eq('id', session.user.id)
    .single();

  if (!profile?.onboarding_complete) {
    window.location.href = '/onboarding.html';
    return null;
  }
  return session;
}

// ── Skill tag HTML ────────────────────────────────────────────
export function skillTagHtml(skill, removable = false, type = 'primary') {
  if (removable) {
    return `<span class="tag tag-${type} tag-removable" data-skill="${esc(skill)}">
      ${esc(skill)} <span class="tag-x" aria-label="הסר">×</span>
    </span>`;
  }
  return `<span class="tag tag-${type}">${esc(skill)}</span>`;
}
