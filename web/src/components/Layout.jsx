import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  AppBar, Toolbar, Typography, IconButton, Badge, Box,
  Drawer, List, ListItemButton, ListItemIcon, ListItemText,
  BottomNavigation, BottomNavigationAction, Paper, Alert,
  useMediaQuery, useTheme,
} from '@mui/material';
import {
  Home, CalendarMonth, Medication, NotificationsActive,
  Search, DarkMode, LightMode,
} from '@mui/icons-material';
import { api } from '../api.js';

const NAV_ITEMS = [
  { label: 'ראשי', icon: <Home />, path: '/' },
  { label: 'תורים', icon: <CalendarMonth />, path: '/appointments' },
  { label: 'תרופות', icon: <Medication />, path: '/medications' },
  { label: 'התראות', icon: <NotificationsActive />, path: '/alerts' },
  { label: 'חיפוש', icon: <Search />, path: '/search' },
];

const DRAWER_WIDTH = 200;

export default function Layout({ children, toggleTheme, mode }) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const navigate = useNavigate();
  const location = useLocation();
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    api.getAlerts().then(setAlerts).catch(() => {});
  }, [location.pathname]);

  const criticalAlerts = alerts.filter((a) => a.severity === 'critical');
  const alertCount = alerts.length;
  const currentIndex = NAV_ITEMS.findIndex((item) => item.path === location.pathname);

  const navContent = (
    <List sx={{ pt: 2 }}>
      {NAV_ITEMS.map((item, i) => (
        <ListItemButton
          key={item.path}
          selected={location.pathname === item.path}
          onClick={() => navigate(item.path)}
          sx={{ borderRadius: 2, mx: 1, mb: 0.5 }}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>
            {item.path === '/alerts' ? (
              <Badge badgeContent={alertCount} color="error" max={99}>
                {item.icon}
              </Badge>
            ) : item.icon}
          </ListItemIcon>
          <ListItemText primary={item.label} />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Desktop Drawer */}
      {isDesktop && (
        <Drawer
          variant="permanent"
          anchor="right"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              top: 64,
              borderLeft: 1,
              borderRight: 0,
              borderColor: 'divider',
            },
          }}
        >
          {navContent}
        </Drawer>
      )}

      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', width: '100%' }}>
        {/* AppBar */}
        <AppBar position="sticky" elevation={1} sx={{ zIndex: theme.zIndex.drawer + 1 }}>
          <Toolbar>
            <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>
              ShebaConnect
            </Typography>
            <IconButton color="inherit" onClick={toggleTheme} sx={{ ml: 1 }}>
              {mode === 'dark' ? <LightMode /> : <DarkMode />}
            </IconButton>
          </Toolbar>
        </AppBar>

        {/* Critical Alert Banner */}
        {criticalAlerts.length > 0 && (
          <Box sx={{ px: 2, pt: 1 }}>
            {criticalAlerts.map((alert) => (
              <Alert
                key={alert.id}
                severity="error"
                variant="filled"
                sx={{ mb: 1, borderRadius: 2, cursor: 'pointer' }}
                onClick={() => navigate('/alerts')}
              >
                {alert.description}
              </Alert>
            ))}
          </Box>
        )}

        {/* Main Content */}
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: { xs: 2, md: 3 },
            pb: { xs: 10, md: 3 },
            maxWidth: 1200,
            mx: 'auto',
            width: '100%',
          }}
        >
          {children}
        </Box>
      </Box>

      {/* Mobile Bottom Navigation */}
      {!isDesktop && (
        <Paper
          sx={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1100 }}
          elevation={8}
        >
          <BottomNavigation
            value={currentIndex >= 0 ? currentIndex : 0}
            onChange={(_, newValue) => navigate(NAV_ITEMS[newValue].path)}
            showLabels
          >
            {NAV_ITEMS.map((item) => (
              <BottomNavigationAction
                key={item.path}
                label={item.label}
                icon={
                  item.path === '/alerts' ? (
                    <Badge badgeContent={alertCount} color="error" max={99}>
                      {item.icon}
                    </Badge>
                  ) : item.icon
                }
              />
            ))}
          </BottomNavigation>
        </Paper>
      )}
    </Box>
  );
}
