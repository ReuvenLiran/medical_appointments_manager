const BASE = '/api';

async function fetchJson(url) {
  const res = await fetch(`${BASE}${url}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getMedications: () => fetchJson('/medications'),
  getAllMedications: () => fetchJson('/medications/all'),
  getMedicationHistory: (name) => fetchJson(`/medications/history/${encodeURIComponent(name)}`),
  getConditions: () => fetchJson('/conditions'),
  getRecommendations: () => fetchJson('/recommendations'),
  getRecommendationMatches: (id) => fetchJson(`/recommendations/${id}/matches`),
  getAppointments: () => fetchJson('/appointments'),
  getFutureAppointments: () => fetchJson('/appointments/future'),
  getAppointmentMatches: (id) => fetchJson(`/appointments/${id}/matches`),
  getAlerts: () => fetchJson('/alerts'),
  getDocuments: () => fetchJson('/documents'),
  search: (q) => fetchJson(`/search?q=${encodeURIComponent(q)}`),

  resolveAlert: async (id) => {
    const res = await fetch(`${BASE}/alerts/${id}/resolve`, { method: 'POST' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },

  ask: async (question) => {
    const res = await fetch(`${BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },

  sync: async () => {
    const res = await fetch(`${BASE}/sync`, { method: 'POST' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },
};
