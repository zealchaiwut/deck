// Mock UlanziStudio host: launch the real app.js, send an `add` for the
// antigravity action with a projectPath, capture the icon it pushes back.
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';

const PORT = 39187;
const PROJECT = process.argv[2] ?? '~/dev/commander/prd';
const wss = new WebSocketServer({ port: PORT });
const captured = [];

wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    captured.push(m);
    if (m.cmd === 'connected') {
      ws.send(JSON.stringify({
        cmd: 'add',
        uuid: 'com.ulanzi.ulanzistudio.deckstatus.antigravity',
        key: '2_3',
        actionid: 'aid-1',
        param: PROJECT ? { projectPath: PROJECT } : {},
      }));
    }
  });
});

const child = spawn(process.execPath, ['plugin/app.js', '127.0.0.1', String(PORT), 'en'], { stdio: 'inherit' });

setTimeout(() => {
  const all = JSON.stringify(captured);
  const m = all.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/);
  console.log(`\n=== project="${PROJECT}" ===`);
  console.log('icon push captured:', !!m);
  if (m) {
    const svg = Buffer.from(m[0].split(',')[1], 'base64').toString();
    const texts = (svg.match(/>([^<]*)<\/text>/g) || []).map((t) => t.replace(/<[^>]+>|>/g, ''));
    console.log('tile texts:', JSON.stringify(texts.filter(Boolean)));
  }
  child.kill(); wss.close(); process.exit(0);
}, 2500);
