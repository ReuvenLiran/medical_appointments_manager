import { useState, useEffect } from 'react';
import {
  Box, Typography, Card, CardContent, Chip, Stack, Skeleton,
  Accordion, AccordionSummary, AccordionDetails, Divider,
} from '@mui/material';
import {
  ExpandMore, LocationOn, CheckCircle, Description,
} from '@mui/icons-material';
import { api } from '../../api.js';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function isPast(dateStr) {
  return dateStr < new Date().toISOString().slice(0, 10);
}

function isToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0, 10);
}

export default function AppointmentsView() {
  const [appointments, setAppointments] = useState([]);
  const [matches, setMatches] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAppointments().then(async (apts) => {
      setAppointments(apts);
      // Fetch matches for future appointments
      const matchMap = {};
      const futures = apts.filter((a) => !isPast(a.appointment_date));
      await Promise.all(
        futures.map(async (apt) => {
          try {
            const m = await api.getAppointmentMatches(apt.id);
            if (m.length > 0) matchMap[apt.id] = m;
          } catch {}
        })
      );
      setMatches(matchMap);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rectangular" height={80} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" height={80} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" height={80} sx={{ borderRadius: 3 }} />
      </Stack>
    );
  }

  const future = appointments.filter((a) => !isPast(a.appointment_date));
  const past = appointments.filter((a) => isPast(a.appointment_date)).reverse();

  return (
    <Stack spacing={3}>
      <Typography variant="h5" fontWeight={700}>תורים</Typography>

      {/* Upcoming */}
      <Box>
        <Typography variant="h6" gutterBottom color="primary" fontWeight={600}>
          תורים קרובים ({future.length})
        </Typography>
        {future.length === 0 ? (
          <Typography variant="body2" color="text.secondary">אין תורים קרובים</Typography>
        ) : (
          <Stack spacing={1.5}>
            {future.map((apt) => (
              <AppointmentCard
                key={apt.id}
                apt={apt}
                matches={matches[apt.id]}
                highlight={isToday(apt.appointment_date)}
              />
            ))}
          </Stack>
        )}
      </Box>

      {/* Past */}
      {past.length > 0 && (
        <Box>
          <Typography variant="h6" gutterBottom color="text.secondary" fontWeight={600}>
            תורים קודמים ({past.length})
          </Typography>
          <Stack spacing={1}>
            {past.map((apt) => (
              <Card key={apt.id} sx={{ opacity: 0.6 }}>
                <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="body2" fontWeight={600}>
                      {formatDate(apt.appointment_date)}
                    </Typography>
                    {apt.appointment_time && (
                      <Typography variant="caption" color="text.secondary">
                        {apt.appointment_time}
                      </Typography>
                    )}
                    <Typography variant="body2">{apt.appointment_type}</Typography>
                    {apt.service && (
                      <Typography variant="caption" color="text.secondary">
                        — {apt.service}
                      </Typography>
                    )}
                  </Box>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function AppointmentCard({ apt, matches, highlight }) {
  return (
    <Accordion
      defaultExpanded={highlight}
      sx={{
        borderRight: 4,
        borderColor: highlight ? 'warning.main' : 'primary.main',
        '&:before': { display: 'none' },
      }}
    >
      <AccordionSummary expandIcon={<ExpandMore />}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', width: '100%' }}>
          <Typography variant="body1" fontWeight={700} color="primary">
            {formatDate(apt.appointment_date)}
          </Typography>
          {apt.appointment_time && (
            <Typography variant="body2" color="text.secondary">
              {apt.appointment_time}
            </Typography>
          )}
          <Typography variant="body1">{apt.appointment_type}</Typography>
          {apt.service && (
            <Typography variant="caption" color="text.secondary">
              — {apt.service}
            </Typography>
          )}
          {matches && matches.length > 0 && (
            <Chip
              label={`${matches.length} המלצות`}
              size="small"
              color="success"
              icon={<CheckCircle />}
            />
          )}
          {highlight && (
            <Chip label="היום" size="small" color="warning" />
          )}
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          {apt.location && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <LocationOn fontSize="small" color="action" />
              <Typography variant="body2">{apt.location}</Typography>
            </Box>
          )}

          {matches && matches.length > 0 && (
            <Box>
              <Typography variant="body2" fontWeight={600} gutterBottom>
                המלצות מותאמות:
              </Typography>
              <Stack spacing={0.5}>
                {matches.map((m) => (
                  <Box key={m.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 2 }}>
                    <CheckCircle fontSize="small" color="success" />
                    <Chip label={m.type} size="small" variant="outlined" />
                    <Typography variant="body2">{m.description}</Typography>
                    {m.reason && (
                      <Typography variant="caption" color="text.secondary">
                        ({m.reason})
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            </Box>
          )}

          {apt.invite_pdf_path && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Description fontSize="small" color="action" />
              <Typography variant="body2" color="text.secondary">
                זימון PDF זמין
              </Typography>
            </Box>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
