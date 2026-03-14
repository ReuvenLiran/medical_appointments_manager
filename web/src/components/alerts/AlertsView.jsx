import { useState, useEffect } from 'react';
import {
  Box, Typography, Stack, Skeleton, Alert, Button, Snackbar, Chip, Card, CardContent,
} from '@mui/material';
import { api } from '../../api.js';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
const SEVERITY_LABELS = { critical: 'קריטי', warning: 'אזהרה', info: 'מידע' };
const TYPE_LABELS = {
  drug_interaction: 'אינטראקציה תרופתית',
  condition_conflict: 'קונפליקט מצבי',
  unmatched_recommendation: 'המלצה לא מותאמת',
};

export default function AlertsView() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [snackbar, setSnackbar] = useState('');

  useEffect(() => {
    loadAlerts();
  }, []);

  async function loadAlerts() {
    try {
      const data = await api.getAlerts();
      data.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
      setAlerts(data);
    } catch {}
    setLoading(false);
  }

  async function handleResolve(id) {
    try {
      await api.resolveAlert(id);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      setSnackbar('ההתראה סומנה כפתורה');
    } catch {
      setSnackbar('שגיאה בעדכון ההתראה');
    }
  }

  if (loading) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rectangular" height={100} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" height={100} sx={{ borderRadius: 3 }} />
      </Stack>
    );
  }

  const grouped = {
    critical: alerts.filter((a) => a.severity === 'critical'),
    warning: alerts.filter((a) => a.severity === 'warning'),
    info: alerts.filter((a) => a.severity === 'info'),
  };

  return (
    <Stack spacing={3}>
      <Typography variant="h5" fontWeight={700}>התראות</Typography>

      {alerts.length === 0 ? (
        <Alert severity="success" sx={{ borderRadius: 2 }}>
          אין התראות פתוחות
        </Alert>
      ) : (
        Object.entries(grouped).map(([severity, items]) => {
          if (items.length === 0) return null;
          return (
            <Box key={severity}>
              <Typography variant="h6" fontWeight={600} gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {SEVERITY_LABELS[severity]} ({items.length})
                <Chip
                  label={SEVERITY_LABELS[severity]}
                  size="small"
                  color={severity === 'critical' ? 'error' : severity === 'warning' ? 'warning' : 'info'}
                />
              </Typography>
              <Stack spacing={1.5}>
                {items.map((alert) => (
                  <Card
                    key={alert.id}
                    sx={{
                      borderRight: 4,
                      borderColor:
                        severity === 'critical' ? 'error.main' :
                        severity === 'warning' ? 'warning.main' : 'info.main',
                    }}
                  >
                    <CardContent>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Box>
                          <Chip
                            label={TYPE_LABELS[alert.alert_type] || alert.alert_type}
                            size="small"
                            variant="outlined"
                            sx={{ mb: 1 }}
                          />
                          <Typography variant="body1" gutterBottom>
                            {alert.description}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {new Date(alert.created_at).toLocaleDateString('he-IL')}
                          </Typography>
                        </Box>
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={() => handleResolve(alert.id)}
                          sx={{ flexShrink: 0, mr: 2 }}
                        >
                          סמן כפתור
                        </Button>
                      </Box>
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            </Box>
          );
        })
      )}

      <Snackbar
        open={!!snackbar}
        autoHideDuration={3000}
        onClose={() => setSnackbar('')}
        message={snackbar}
      />
    </Stack>
  );
}
