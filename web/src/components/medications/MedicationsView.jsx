import { useState, useEffect } from 'react';
import {
  Box, Typography, Card, CardContent, Chip, Stack, Skeleton,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Accordion, AccordionSummary, AccordionDetails, Paper,
} from '@mui/material';
import {
  ExpandMore, Circle, Warning,
} from '@mui/icons-material';
import { api } from '../../api.js';
import { getSpecialtyColor } from '../../theme.js';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export default function MedicationsView() {
  const [allMeds, setAllMeds] = useState([]);
  const [conditions, setConditions] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getAllMedications(),
      api.getConditions(),
      api.getAlerts(),
    ]).then(([meds, conds, alts]) => {
      setAllMeds(meds);
      setConditions(conds);
      setAlerts(alts.filter((a) => a.alert_type === 'drug_interaction'));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rectangular" height={200} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" height={200} sx={{ borderRadius: 3 }} />
      </Stack>
    );
  }

  const active = allMeds.filter((m) => m.status === 'active');
  const discontinued = allMeds.filter((m) => m.status !== 'active');

  // Build interaction map from alerts
  const interactionMap = new Map();
  for (const alert of alerts) {
    try {
      const ids = JSON.parse(alert.related_entity_ids || '[]');
      for (const id of ids) {
        if (!interactionMap.has(id)) interactionMap.set(id, []);
        interactionMap.get(id).push(alert.description);
      }
    } catch {}
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5" fontWeight={700}>תרופות ומצבים</Typography>

      {/* Active Medications */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom fontWeight={600}>
            תרופות פעילות ({active.length})
          </Typography>
          {active.length === 0 ? (
            <Typography variant="body2" color="text.secondary">אין תרופות פעילות</Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell></TableCell>
                    <TableCell>שם</TableCell>
                    <TableCell>מינון</TableCell>
                    <TableCell>מתמחות</TableCell>
                    <TableCell>מאז</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {active.map((m) => {
                    const interactions = interactionMap.get(m.id);
                    return (
                      <TableRow key={m.id}>
                        <TableCell sx={{ width: 24, p: 0.5 }}>
                          <Circle sx={{ fontSize: 10, color: 'success.main' }} />
                        </TableCell>
                        <TableCell>
                          <bdi>{m.name}</bdi>
                          {interactions && (
                            <Box sx={{ mt: 0.5 }}>
                              {interactions.map((desc, i) => (
                                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Warning sx={{ fontSize: 14, color: 'error.main' }} />
                                  <Typography variant="caption" color="error.main">
                                    {desc}
                                  </Typography>
                                </Box>
                              ))}
                            </Box>
                          )}
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {m.dosage || '—'}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={m.prescriber_specialty}
                            size="small"
                            sx={{
                              bgcolor: getSpecialtyColor(m.prescriber_specialty),
                              color: '#fff',
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">
                            {formatDate(m.started_date)}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      {/* Discontinued Medications */}
      {discontinued.length > 0 && (
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography variant="h6" fontWeight={600}>
              תרופות שהופסקו ({discontinued.length})
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell></TableCell>
                    <TableCell>שם</TableCell>
                    <TableCell>מינון</TableCell>
                    <TableCell>מתמחות</TableCell>
                    <TableCell>סטטוס</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {discontinued.map((m) => (
                    <TableRow key={m.id} sx={{ opacity: 0.6 }}>
                      <TableCell sx={{ width: 24, p: 0.5 }}>
                        <Circle sx={{ fontSize: 10, color: 'text.disabled' }} />
                      </TableCell>
                      <TableCell><bdi>{m.name}</bdi></TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {m.dosage || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {m.prescriber_specialty}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={m.status === 'discontinued' ? 'הופסק' : 'שונה'}
                          size="small"
                          color="default"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </AccordionDetails>
        </Accordion>
      )}

      {/* Conditions */}
      <Typography variant="h6" fontWeight={600}>מצבים רפואיים ({conditions.length})</Typography>
      {conditions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">אין מצבים פעילים</Typography>
      ) : (
        <Stack spacing={2}>
          {conditions.map((c) => (
            <Card
              key={c.id}
              sx={{
                borderRight: 4,
                borderColor: getSpecialtyColor(c.diagnosing_specialty),
              }}
            >
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <Chip
                    label={c.status === 'monitoring' ? 'מעקב' : 'פעיל'}
                    size="small"
                    color={c.status === 'monitoring' ? 'warning' : 'error'}
                  />
                  <Typography variant="h6" fontWeight={600}>{c.name}</Typography>
                </Box>
                {c.diagnosing_specialty && (
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    מנוהל ע&quot;י: {c.diagnosing_specialty}
                  </Typography>
                )}
                {c.first_seen_date && (
                  <Typography variant="caption" color="text.secondary">
                    מאז: {formatDate(c.first_seen_date)}
                  </Typography>
                )}
                {c.notes && (
                  <Typography variant="body2" sx={{ mt: 1 }}>{c.notes}</Typography>
                )}
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
