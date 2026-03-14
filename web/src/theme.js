import { createTheme } from '@mui/material/styles';

const SPECIALTY_COLORS = {
  'נוירולוגיה': '#7C3AED',
  'עיניים': '#2563EB',
  'מעבדה': '#059669',
  'הדמיה': '#D97706',
};

export function getSpecialtyColor(specialty) {
  if (!specialty) return '#6B7280';
  for (const [key, color] of Object.entries(SPECIALTY_COLORS)) {
    if (specialty.includes(key)) return color;
  }
  return '#6B7280';
}

export function createAppTheme(mode) {
  return createTheme({
    direction: 'rtl',
    palette: {
      mode,
      primary: { main: '#0D7377' },
      secondary: { main: '#14B8A6' },
      error: { main: '#DC2626' },
      warning: { main: '#F59E0B' },
      success: { main: '#10B981' },
      info: { main: '#0D7377' },
      background: {
        default: mode === 'light' ? '#FAFAF7' : '#121212',
        paper: mode === 'light' ? '#FFFFFF' : '#1E1E1E',
      },
    },
    typography: {
      fontFamily: '"Heebo", "Roboto", system-ui, sans-serif',
      body1: { lineHeight: 1.6 },
      body2: { lineHeight: 1.6 },
    },
    shape: { borderRadius: 12 },
    components: {
      MuiCard: {
        defaultProps: { elevation: 1 },
        styleOverrides: { root: { borderRadius: 12 } },
      },
      MuiChip: {
        styleOverrides: { root: { borderRadius: 8 } },
      },
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            direction: 'rtl',
          },
        },
      },
    },
  });
}
