const BASE = 'https://app.360learning.com/api/v2';
const TOKEN_URL = process.env.LEARNING_TOKEN_URL || 'https://app.360learning.com/api/v2/oauth2/token';

// In-memory token cache (lives for the duration of the function instance)
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.LEARNING_CLIENT_ID,
      client_secret: process.env.LEARNING_CLIENT_SECRET,
    }),
  });

  const rawBody = await res.text();
  console.log(`[token] status=${res.status} url=${TOKEN_URL} body=${rawBody.slice(0, 300)}`);

  if (!res.ok) {
    throw new Error(`Token request failed ${res.status}: ${rawBody.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    throw new Error(`Token response not JSON (status ${res.status}): ${rawBody.slice(0, 200)}`);
  }
  _token = data.access_token;
  // Expire 60 s before the server says so
  _tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _token;
}

async function apiFetch(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      '360-api-version': 'v2.0',
    },
  });
  const text = await res.text();
  console.log(`[api] ${path} status=${res.status} body=${text.slice(0, 400)}`);
  if (!res.ok) throw new Error(`360L API ${path} → ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`360L API ${path} non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

function getWeekBounds(now) {
  const d = new Date(now);
  const dow = d.getDay(); // 0 = Sun
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return { monday, nextMonday };
}

// Normalise a raw slot object to { startMs, endMs }
function parseSlotDate(slot) {
  const raw = slot.startDate ?? slot.start ?? slot.date ?? slot.startTime ?? null;
  return raw ? new Date(raw).getTime() : null;
}

// Extract trainer info from a slot, handling various field shapes the API might return
function parseTrainer(slot) {
  const t = slot.trainer ?? slot.instructor ?? slot.facilitator ?? null;
  if (!t) return null;
  return {
    name: t.name ?? t.fullName ?? [t.firstName, t.lastName].filter(Boolean).join(' ') ?? '',
    role: t.role ?? t.jobTitle ?? t.title ?? '',
    photoUrl: t.photoUrl ?? t.avatarUrl ?? t.picture ?? t.avatar ?? null,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache 5 min at CDN; serve stale for up to 10 min while revalidating
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    const token = await getToken();
    const groupId = process.env.LEARNING_GROUP_ID;

    const qs = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
    const raw = await apiFetch(token, `/classrooms${qs}`);

    // The API may return an array directly or wrap it in .data / .items
    const classrooms = Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? []);

    const now = new Date();
    const { monday, nextMonday } = getWeekBounds(now);

    let nextSlot = null;
    let nextClassroom = null;
    const dayCounts = [0, 0, 0, 0, 0]; // Mon → Fri

    // Fetch slots in parallel; cap at 30 classrooms to avoid excessive calls
    await Promise.all(
      classrooms.slice(0, 30).map(async (classroom) => {
        const id = classroom._id ?? classroom.id;
        let slotRaw;
        try {
          slotRaw = await apiFetch(token, `/classrooms/${id}/slots`);
        } catch {
          return; // skip classrooms whose slots we can't read
        }
        const slots = Array.isArray(slotRaw) ? slotRaw : (slotRaw.data ?? slotRaw.items ?? []);

        for (const slot of slots) {
          const startMs = parseSlotDate(slot);
          if (!startMs) continue;

          // Count towards this week
          if (startMs >= monday.getTime() && startMs < nextMonday.getTime()) {
            const dow = new Date(startMs).getDay(); // 1=Mon … 5=Fri
            if (dow >= 1 && dow <= 5) dayCounts[dow - 1]++;
          }

          // Track the single next upcoming slot
          if (startMs > now.getTime()) {
            if (!nextSlot || startMs < parseSlotDate(nextSlot)) {
              nextSlot = slot;
              nextClassroom = classroom;
            }
          }
        }
      })
    );

    const payload = {
      weekSessions: dayCounts,
      total: dayCounts.reduce((a, b) => a + b, 0),
      nextSession: null,
    };

    if (nextSlot && nextClassroom) {
      const classroomId = nextClassroom._id ?? nextClassroom.id;
      payload.nextSession = {
        name: nextClassroom.name ?? nextClassroom.title ?? 'Upcoming Session',
        date: nextSlot.startDate ?? nextSlot.start ?? nextSlot.date,
        classroomId,
        url: `https://app.360learning.com/home/content/classrooms/${classroomId}`,
        trainer: parseTrainer(nextSlot),
        registrationsCount: nextSlot.registrationsCount ?? nextSlot.attendees ?? nextSlot.registrations ?? null,
      };
    }

    res.json(payload);
  } catch (err) {
    console.error('[classrooms-api]', err.message);
    res.status(500).json({ error: err.message });
  }
};
