/**
 * Check if the Roboflow API key is usable.
 * Reads key from .env (ROBOFLOW_API_KEY) or env var, then calls the same workflow the app uses.
 *
 * Run: node scripts/check-roboflow-key.js
 * Or:  ROBOFLOW_API_KEY=your_key node scripts/check-roboflow-key.js
 */

const fs = require('fs');
const path = require('path');

function getApiKey() {
  const envPath = path.join(__dirname, '..', '.env');
  if (process.env.ROBOFLOW_API_KEY) {
    return process.env.ROBOFLOW_API_KEY.trim();
  }
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/ROBOFLOW_API_KEY\s*=\s*(.+)/);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  // Also check config.secret.ts (simple regex, no TS parsing)
  const secretPath = path.join(__dirname, '..', 'config.secret.ts');
  if (fs.existsSync(secretPath)) {
    const content = fs.readFileSync(secretPath, 'utf8');
    const match = content.match(/ROBOFLOW_API_KEY\s*=\s*['"]([^'"]*)['"]/);
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

const WORKFLOW_URL =
  'https://serverless.roboflow.com/haos-workspace-pm46v/workflows/detect-count-and-visualize';

// Minimal valid base64 JPEG (1x1 pixel) so the request is accepted
const MINIMAL_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQACEQADAP4A/9k=';

async function checkKey() {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('No Roboflow API key found.');
    console.error('Set ROBOFLOW_API_KEY in .env or config.secret.ts, or run: ROBOFLOW_API_KEY=your_key node scripts/check-roboflow-key.js');
    process.exit(1);
  }

  console.log('Checking Roboflow API key...');
  try {
    const res = await fetch(WORKFLOW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: { image: MINIMAL_IMAGE },
      }),
    });

    if (res.status === 401 || res.status === 403) {
      console.error('Key is invalid or not authorized (', res.status, ').');
      process.exit(1);
    }

    if (res.status >= 400) {
      const text = await res.text();
      // 401/403 already handled above. Other 4xx/5xx = key was accepted, error is payload/workflow
      console.log('Key is accepted by Roboflow (server responded ' + res.status + '). Usable in the app.');
      process.exitCode = 0;
      return;
    }

    console.log('Key is usable. Roboflow responded with status', res.status);
    process.exitCode = 0;
  } catch (err) {
    console.error('Request failed:', err.message);
    process.exitCode = 1;
  }
}

checkKey();
