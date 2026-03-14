import { useState, useMemo, useEffect } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { CacheProvider } from '@emotion/react';
import createCache from '@emotion/cache';
import rtlPlugin from 'stylis-plugin-rtl';
import { prefixer } from 'stylis';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { createAppTheme } from './theme.js';
import Layout from './components/Layout.jsx';
import Dashboard from './components/dashboard/Dashboard.jsx';
import AppointmentsView from './components/appointments/AppointmentsView.jsx';
import MedicationsView from './components/medications/MedicationsView.jsx';
import AlertsView from './components/alerts/AlertsView.jsx';
import SearchView from './components/search/SearchView.jsx';

const rtlCache = createCache({
  key: 'muirtl',
  stylisPlugins: [prefixer, rtlPlugin],
});

function App() {
  const [mode, setMode] = useState(() => localStorage.getItem('themeMode') || 'light');

  useEffect(() => {
    localStorage.setItem('themeMode', mode);
  }, [mode]);

  const theme = useMemo(() => createAppTheme(mode), [mode]);

  const toggleTheme = () => setMode((prev) => (prev === 'light' ? 'dark' : 'light'));

  return (
    <CacheProvider value={rtlCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <HashRouter>
          <Layout toggleTheme={toggleTheme} mode={mode}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/appointments" element={<AppointmentsView />} />
              <Route path="/medications" element={<MedicationsView />} />
              <Route path="/alerts" element={<AlertsView />} />
              <Route path="/search" element={<SearchView />} />
            </Routes>
          </Layout>
        </HashRouter>
      </ThemeProvider>
    </CacheProvider>
  );
}

export default App;
