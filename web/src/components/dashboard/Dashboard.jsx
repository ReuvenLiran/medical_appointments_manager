import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Card, CardContent, Chip, Stack, Skeleton,
  Divider, Grid,
} from '@mui/material';
import {
  CheckCircle, Warning, Circle,
} from '@mui/icons-material';
import { api } from '../../api.js';
import { getSpecialtyColor } from '../../theme.js';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getFutureAppointments(),
      api.getMedications(),
      api.getConditions(),
      api.getRecommendations(),
      api.getDocuments(),
    ]).then(([appointments, medications, conditions, recommendations, documents]) => {
      setData({ appointments, medications, conditions, recommendations, documents });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" height={200} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" height={200} sx={{ borderRadius: 3 }} />
      </Stack>
    );
  }

  if (!data) return <Typography>Failed to load data</Typography>;

  const { appointments, medications, conditions, recommendations, documents } = data;

  // Group medications by specialty
  const medsBySpecialty = new Map();
  for (const m of medications) {
    const sp = m.prescriber_specialty || 'לא ידוע';
    if (!medsBySpecialty.has(sp)) medsBySpecialty.set(sp, []);
    medsBySpecialty.get(sp).push(m);
  }

  return (
    <Stack spacing={3}>
      {/* Section: Upcoming Appointments */}
      <Box>
        <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
          תורים קרובים
        </Typography>
        {appointments.length === 0 ? (
          <Typography variant="body2" color="text.secondary">אין תורים קרובים</Typography>
        ) : (
          <Box sx={{ display: 'flex', gap: 2, overflowX: 'auto', pb: 1 }}>
            {appointments.slice(0, 8).map((apt) => (
              <Card
                key={apt.id}
                sx={{
                  minWidth: 160,
                  cursor: 'pointer',
                  flexShrink: 0,
                  borderRight: 4,
                  borderColor: 'primary.main',
                  '&:hover': { elevation: 4, transform: 'translateY(-2px)' },
                  transition: 'transform 0.2s',
                }}
                onClick={() => navigate('/appointments')}
              >
                <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                  <Typography variant="body2" fontWeight={700} color="primary">
                    {formatDate(apt.appointment_date)}
                  </Typography>
                  {apt.appointment_time && (
                    <Typography variant="caption" color="text.secondary">
                      {apt.appointment_time}
                    </Typography>
                  )}
                  <Typography variant="body2" sx={{ mt: 0.5 }} noWrap>
                    {apt.appointment_type}
                  </Typography>
                  {apt.location && (
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {apt.location}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            ))}
          </Box>
        )}
      </Box>

      {/* Two-column: Medications + Conditions */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                תרופות פעילות ({medications.length})
              </Typography>
              {medications.length === 0 ? (
                <Typography variant="body2" color="text.secondary">אין תרופות פעילות</Typography>
              ) : (
                <Stack spacing={1.5}>
                  {[...medsBySpecialty.entries()].map(([specialty, meds]) => (
                    <Box key={specialty}>
                      <Typography
                        variant="body2"
                        fontWeight={600}
                        sx={{ color: getSpecialtyColor(specialty), mb: 0.5 }}
                      >
                        {specialty}
                      </Typography>
                      {meds.map((m) => (
                        <Box key={m.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.3, pr: 2 }}>
                          <Circle sx={{ fontSize: 8, color: 'success.main' }} />
                          <Typography variant="body2">
                            <bdi>{m.name}</bdi>
                            {m.dosage && (
                              <Typography component="span" variant="body2" color="text.secondary" sx={{ mr: 1 }}>
                                {' '}{m.dosage}
                              </Typography>
                            )}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                מצבים רפואיים ({conditions.length})
              </Typography>
              {conditions.length === 0 ? (
                <Typography variant="body2" color="text.secondary">אין מצבים פעילים</Typography>
              ) : (
                <Stack spacing={1}>
                  {conditions.map((c) => (
                    <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Chip
                        label={c.status === 'monitoring' ? 'מעקב' : 'פעיל'}
                        size="small"
                        color={c.status === 'monitoring' ? 'warning' : 'error'}
                        variant="outlined"
                      />
                      <Typography variant="body2">{c.name}</Typography>
                      {c.diagnosing_specialty && (
                        <Typography variant="caption" color="text.secondary">
                          ({c.diagnosing_specialty})
                        </Typography>
                      )}
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Pending Recommendations */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
            המלצות בהמתנה ({recommendations.length})
          </Typography>
          {recommendations.length === 0 ? (
            <Typography variant="body2" color="text.secondary">אין המלצות בהמתנה</Typography>
          ) : (
            <Stack spacing={1}>
              {recommendations.map((r) => (
                <Box key={r.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Chip label={r.type} size="small" color="info" variant="outlined" />
                  <Typography variant="body2">{r.description}</Typography>
                  <Chip
                    label={r.status === 'matched' ? 'מותאם' : 'לא מותאם'}
                    size="small"
                    color={r.status === 'matched' ? 'success' : 'warning'}
                    icon={r.status === 'matched' ? <CheckCircle /> : <Warning />}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {r.requesting_specialty}
                    {r.target_specialty && ` → ${r.target_specialty}`}
                  </Typography>
                </Box>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>

      {/* Recent Documents */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
            מסמכים אחרונים
          </Typography>
          {documents.length === 0 ? (
            <Typography variant="body2" color="text.secondary">אין מסמכים</Typography>
          ) : (
            <Stack spacing={0.5} divider={<Divider />}>
              {documents.slice(0, 5).map((d) => (
                <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatDate(d.visit_date || d.processed_at?.slice(0, 10))}
                  </Typography>
                  <Typography variant="body2" noWrap>{d.filename}</Typography>
                  {d.specialty && (
                    <Chip label={d.specialty} size="small" sx={{ bgcolor: getSpecialtyColor(d.specialty), color: '#fff' }} />
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
