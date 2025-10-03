require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();

// Parse JSON request bodies
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || 'https://api.perplexity.ai/chat/completions';

if (!TARGET_URL) {
  console.error('Error: TARGET_URL is not set. Please set it in your environment or .env file.');
  process.exit(1);
}

// Basic health check endpoint
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// Helper to sanitize incoming headers before forwarding upstream
function buildUpstreamHeaders(incoming) {
  const headers = { ...incoming };
  const hopByHop = [
    'authorization',
    'content-type',
    'host',
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailers',
    'proxy-authorization',
    'proxy-authenticate',
    'content-length',
  ];
  hopByHop.forEach((h) => delete headers[h]);
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  headers['authorization'] = incoming['authorization'] || '';
  return headers;
}

// POST /perplexity: forwards JSON body and request headers to TARGET_URL
app.post('/proxy', async (req, res) => {
  console.log(`Received request: ${req.method} ${req.originalUrl}`);
  const wantsStream = (req.headers.accept || '').includes('text/event-stream');
  const headers = buildUpstreamHeaders(req.headers);
  console.log(`Forwarding to ${TARGET_URL} with headers:`, headers, req.headers);

  try {
    // If client requests SSE, stream the upstream response
    const axiosConfig = {
      method: 'POST',
      url: TARGET_URL,
      headers,
      data: req.body,
      timeout: 120000,
      validateStatus: () => true, // Pass through non-2xx
      responseType: wantsStream ? 'stream' : 'json',
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    };

    const upstream = await axios(axiosConfig);

    // Forward upstream headers (minus unsafe ones)
    Object.entries(upstream.headers || {}).forEach(([k, v]) => {
      const lower = k.toLowerCase();
      if (['transfer-encoding', 'content-length', 'connection'].includes(lower)) return;
      try { res.setHeader(k, v); } catch (_) { /* ignore invalid headers */ }
    });

    res.status(upstream.status);

    if (wantsStream && upstream.data && typeof upstream.data.pipe === 'function') {
      // Stream SSE or other streaming responses
      upstream.data.pipe(res);
      upstream.data.on('end', () => { try { res.end(); } catch (_) {} });
      upstream.data.on('error', (err) => {
        if (!res.headersSent) res.status(502);
        try { res.end(`stream error: ${err.message}`); } catch (_) {}
      });
    } else {
      // Non-streaming: forward JSON or text
      const payload = upstream.data;
      if (payload && typeof payload === 'object') {
        res.json(payload);
      } else {
        res.send(payload);
      }
    }
  } catch (err) {
    const status = err.response?.status || 502;
    const message = err.response?.data || { error: 'Upstream request failed', detail: err.message };
    res.status(status).json(message);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server listening on http://localhost:${PORT} | POST /perplexity -> ${TARGET_URL}`);
});
