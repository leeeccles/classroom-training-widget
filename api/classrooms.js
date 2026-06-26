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

function slotStartTime(slot) {
  const ms = parseSlotStart(slot);
  if (!ms) return null;
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function slotDuration(slot) {
  const start = parseSlotStart(slot);
  const end = slot.endDate ? new Date(slot.endDate).getTime() : null;
  if (!start || !end) return null;
  return Math.round((end - start) / 60000);
}

function classroomCategory(classroom) {
  return classroom.category
    ?? (Array.isArray(classroom.tags) && classroom.tags[0])
    ?? (Array.isArray(classroom.labels) && classroom.labels[0])
    ?? null;
}

const FILLING_FAST_THRESHOLD = 0.70;

// Fetches all paths and returns a map of classroomId → path URL.
// Path steps with type "classroom" carry the classroom _id directly.
async function buildPathMap(token) {
  const paths = toList(await apiFetch(token, '/paths'));
  const map = {};
  for (const path of paths) {
    const pathId = path._id ?? path.id;
    if (!pathId) continue;
    for (const step of (path.steps || [])) {
      if (step.type === 'classroom' && step._id) {
        map[step._id] = `https://app.360learning.com/paths/${pathId}/home`;
      }
    }
  }
  return map;
}

function sessionUrl(classroomId, pathMap) {
  return pathMap[classroomId] || `https://app.360learning.com/home/content/classrooms/${classroomId}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    const token = await getToken();
    const groupId = process.env.LEARNING_GROUP_ID;
    const qs = groupId ? `?groupId[eq]=${encodeURIComponent(groupId)}` : '';

    // Fetch classrooms and path map in parallel — path map is used to resolve
    // "Book now" URLs: each path step with type "classroom" maps classroomId → path URL
    const [classrooms, pathMap] = await Promise.all([
      apiFetch(token, `/classrooms${qs}`).then(toList),
      buildPathMap(token).catch(() => ({})),
    ]);

    const now = new Date();
    const { monday, nextMonday } = getWeekBounds(now);

    // Collect all slots for this week + track the single next upcoming slot
    const weekSlots = [];
    let nextSlot = null;
    let nextClassroom = null;
    const dayCounts = [0, 0, 0, 0, 0];

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

          const startDate = new Date(startMs);
          const dow = startDate.getDay();

          if (startMs >= monday.getTime() && startMs < nextMonday.getTime() && dow >= 1 && dow <= 5) {
            const dayIndex = dow - 1;
            dayCounts[dayIndex]++;
            weekSlots.push({ classroom, slot, dayIndex, startMs, dayNum: startDate.getDate() });
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

    weekSlots.sort((a, b) => a.startMs - b.startMs);

    // Enrich each week slot with trainer + registrations/capacity
    const enriched = await Promise.all(
      weekSlots.slice(0, 25).map(async ({ classroom, slot, dayIndex, startMs, dayNum }) => {
        const slotId = slot._id ?? slot.id;
        const classroomId = classroom._id ?? classroom.id;
        const trainerIds = slot.trainerIds ?? [];

        const [trainer, registrationsCount] = await Promise.all([
          (async () => {
            if (!trainerIds.length) return null;
            try {
              const user = await apiFetch(token, `/users/${trainerIds[0]}`);
              return {
                name: user.name ?? [user.firstName, user.lastName].filter(Boolean).join(' ') ?? '',
                role: user.jobTitle ?? user.role ?? user.title ?? '',
                photoUrl: user.picture ?? user.photoUrl ?? user.avatarUrl ?? null,
              };
            } catch { return null; }
          })(),
          (async () => {
            try {
              const regs = toList(await apiFetch(token, `/classroom-slots/${slotId}/registrations`));
              return regs.length;
            } catch { return null; }
          })(),
        ]);

        const totalCapacity = slot.maxAttendees ?? slot.maxRegistrations ?? slot.capacity ?? null;
        const seatsLeft = (totalCapacity != null && registrationsCount != null)
          ? Math.max(0, totalCapacity - registrationsCount)
          : null;
        const fillingFast = (totalCapacity && registrationsCount != null && seatsLeft != null && seatsLeft > 0)
          ? (registrationsCount / totalCapacity) >= FILLING_FAST_THRESHOLD
          : false;

        return {
          dayIndex,
          dayNum,
          name: classroom.name ?? classroom.title ?? 'Upcoming Session',
          startTime: slotStartTime(slot),
          duration: slotDuration(slot),
          category: classroomCategory(classroom),
          url: sessionUrl(classroomId, pathMap),
          trainer,
          registrationsCount,
          totalCapacity,
          seatsLeft,
          fillingFast,
        };
      })
    );

    // Group by day
    const byDay = {};
    enriched.forEach(s => {
      if (!byDay[s.dayNum]) byDay[s.dayNum] = { dayNum: s.dayNum, dayIndex: s.dayIndex, sessions: [] };
      byDay[s.dayNum].sessions.push(s);
    });
    const weekDays = Object.values(byDay);

    // Build nextSession payload (kept for backward compatibility)
    let nextSession = null;
    if (nextSlot && nextClassroom) {
      const classroomId = nextClassroom._id ?? nextClassroom.id;
      const slotId = nextSlot._id ?? nextSlot.id;
      const trainerIds = nextSlot.trainerIds ?? [];

      const [trainer, registrationsCount] = await Promise.all([
        (async () => {
          if (!trainerIds.length) return null;
          try {
            const user = await apiFetch(token, `/users/${trainerIds[0]}`);
            const name = user.name ?? [user.firstName, user.lastName].filter(Boolean).join(' ') ?? '';
            return { name, role: user.jobTitle ?? user.role ?? user.title ?? '', photoUrl: user.picture ?? user.photoUrl ?? user.avatarUrl ?? null };
          } catch { return null; }
        })(),
        (async () => {
          try {
            const regs = toList(await apiFetch(token, `/classroom-slots/${slotId}/registrations`));
            return regs.length;
          } catch { return null; }
        })(),
      ]);

      nextSession = {
        name: nextClassroom.name ?? nextClassroom.title ?? 'Upcoming Session',
        date: nextSlot.startDate,
        endDate: nextSlot.endDate ?? null,
        url: sessionUrl(classroomId, pathMap),
        trainer,
        registrationsCount,
      };
    }

    res.json({
      weekDays,
      weekSessions: dayCounts,
      total: dayCounts.reduce((a, b) => a + b, 0),
      nextSession,
    });
  } catch (err) {
    console.error('[classrooms-api]', err.message);
    res.status(500).json({ error: 'Failed to load classroom data' });
  }
};
