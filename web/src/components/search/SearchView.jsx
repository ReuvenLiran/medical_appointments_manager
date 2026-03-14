import { useState } from 'react';
import {
  Box, Typography, Card, CardContent, Stack, TextField,
  InputAdornment, Paper, CircularProgress, Chip, Divider,
} from '@mui/material';
import {
  Search, SmartToy,
} from '@mui/icons-material';
import { api } from '../../api.js';
import { getSpecialtyColor } from '../../theme.js';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export default function SearchView() {
  const [searchQuery, setSearchQuery] = useState('');
  const [askQuery, setAskQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [searching, setSearching] = useState(false);
  const [asking, setAsking] = useState(false);

  async function handleSearch(e) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults(null);
    try {
      const results = await api.search(searchQuery);
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  }

  async function handleAsk(e) {
    e.preventDefault();
    if (!askQuery.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      const result = await api.ask(askQuery);
      setAnswer(result.answer || result.error || 'No answer');
    } catch (err) {
      setAnswer('שגיאה בשליחת השאלה');
    }
    setAsking(false);
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5" fontWeight={700}>חיפוש ושאלות</Typography>

      {/* FTS5 Search */}
      <Card>
        <CardContent>
          <form onSubmit={handleSearch}>
            <TextField
              fullWidth
              placeholder="חיפוש במסמכים..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <Search />
                    </InputAdornment>
                  ),
                  endAdornment: searching ? (
                    <InputAdornment position="end">
                      <CircularProgress size={20} />
                    </InputAdornment>
                  ) : null,
                },
              }}
            />
          </form>
        </CardContent>
      </Card>

      {/* Search Results */}
      {searchResults !== null && (
        <Box>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {searchResults.length === 0 ? 'לא נמצאו תוצאות' : `${searchResults.length} תוצאות`}
          </Typography>
          <Stack spacing={1.5}>
            {searchResults.map((doc) => (
              <Card key={doc.id}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {formatDate(doc.visit_date)}
                    </Typography>
                    {doc.specialty && (
                      <Chip
                        label={doc.specialty}
                        size="small"
                        sx={{ bgcolor: getSpecialtyColor(doc.specialty), color: '#fff' }}
                      />
                    )}
                  </Box>
                  <Typography variant="body2" fontWeight={600}>{doc.filename}</Typography>
                  {doc.summary && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 1, whiteSpace: 'pre-line' }}
                    >
                      {doc.summary.slice(0, 300)}
                      {doc.summary.length > 300 && '...'}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Box>
      )}

      <Divider />

      {/* Gemini Ask */}
      <Card>
        <CardContent>
          <form onSubmit={handleAsk}>
            <TextField
              fullWidth
              placeholder="שאל שאלה רפואית..."
              value={askQuery}
              onChange={(e) => setAskQuery(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SmartToy />
                    </InputAdornment>
                  ),
                  endAdornment: asking ? (
                    <InputAdornment position="end">
                      <CircularProgress size={20} />
                    </InputAdornment>
                  ) : null,
                },
              }}
            />
          </form>
        </CardContent>
      </Card>

      {/* AI Answer */}
      {answer !== null && (
        <Paper
          elevation={2}
          sx={{
            p: 3,
            borderRadius: 3,
            bgcolor: 'background.paper',
            borderRight: 4,
            borderColor: 'secondary.main',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <SmartToy color="secondary" />
            <Typography variant="h6" fontWeight={600}>תשובה</Typography>
          </Box>
          <Typography variant="body1" sx={{ whiteSpace: 'pre-line', lineHeight: 1.8 }}>
            {answer}
          </Typography>
        </Paper>
      )}
    </Stack>
  );
}
