const BASE = 'https://app.360learning.com/api/v2';
const TOKEN_URL = process.env.LEARNING_TOKEN_URL || 'https://app.360learning.com/api/v2/oauth2/token';

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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token request failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  _token = data.access_token;
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`360L API ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function toList(raw) {
  return Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? raw.results ?? []);
}

function getWeekBounds(now) {
  const d = new Date(now);
  const dow = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return { monday, nextMonday };
}

function parseSlotStart(slot) {
  const raw = slot.startDate ?? slot.start ?? slot.date ?? null;
  return raw ? new Date(raw).getTime() : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    const token = await getToken();
    const groupId = process.env.LEARNING_GROUP_ID;

    const qs = groupId ? `?groupId[eq]=${encodeURIComponent(groupId)}` : '';
    const classrooms = toList(await apiFetch(token, `/classrooms${qs}`));

    const now = new Date();
    const { monday, nextMonday } = getWeekBounds(now);

    let nextSlot = null;
    let nextClassroom = null;
    const dayCounts = [0, 0, 0, 0, 0]; // Mon → Fri

    await Promise.all(
      classrooms.slice(0, 30).map(async (classroom) => {
        const id = classroom._id ?? classroom.id;
        let slots;
        try {
          slots = toList(await apiFetch(token, `/classrooms/${id}/slots`));
        } catch {
          return;
        }

        for (const slot of slots) {
          const startMs = parseSlotStart(slot);
          if (!startMs) continue;

          if (startMs >= monday.getTime() && startMs < nextMonday.getTime()) {
            const dow = new Date(startMs).getDay();
            if (dow >= 1 && dow <= 5) dayCounts[dow - 1]++;
          }

          if (startMs > now.getTime()) {
            if (!nextSlot || startMs < parseSlotStart(nextSlot)) {
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
      const slotId = nextSlot._id ?? nextSlot.id;
      const trainerIds = nextSlot.trainerIds ?? [];

      // Fetch trainer profile and registrations count in parallel
      const [trainer, registrationsCount] = await Promise.all([
        (async () => {
          if (!trainerIds.length) return null;
          try {
            const user = await apiFetch(token, `/users/${trainerIds[0]}`);
            const name = user.name
              ?? [user.firstName, user.lastName].filter(Boolean).join(' ')
              ?? '';
            return {
              name,
              role: user.jobTitle ?? user.role ?? user.title ?? '',
              photoUrl: user.picture ?? user.photoUrl ?? user.avatarUrl ?? null,
            };
          } catch {
            return null;
          }
        })(),
        (async () => {
          try {
            const regs = toList(
              await apiFetch(token, `/classroom-slots/${slotId}/registrations`)
            );
            return regs.length;
          } catch {
            return null;
          }
        })(),
      ]);

      payload.nextSession = {
        name: nextClassroom.name ?? nextClassroom.title ?? 'Upcoming Session',
        date: nextSlot.startDate,
        endDate: nextSlot.endDate ?? null,
        location: nextSlot.location ?? null,
        virtual: nextSlot.virtual ?? false,
        url: `https://app.360learning.com/home/content/classrooms/${classroomId}`,
        trainer,
        registrationsCount,
      };
    }

    res.json(payload);
  } catch (err) {
    console.error('[classrooms-api]', err.message);
    res.status(500).json({ error: 'Failed to load classroom data' });
  }
};
