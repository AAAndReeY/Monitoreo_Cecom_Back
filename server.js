require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stream = require('node-rtsp-stream');
const ffmpeg = require('ffmpeg-static');

// Ensure node-rtsp-stream uses our local ffmpeg binary
process.env.PATH = path.dirname(ffmpeg) + path.delimiter + process.env.PATH;

const app = express();
app.use(cors());
app.use(express.json());

const PORT         = process.env.PORT         || 3001;
const BASE_WS_PORT = process.env.BASE_WS_PORT || 9900;

// Load cameras from JSON
const camerasPath = path.join(__dirname, 'cameras.json');
let cameras = [];
try {
  cameras = JSON.parse(fs.readFileSync(camerasPath, 'utf8'));
} catch (e) {
  console.error("Error reading cameras.json", e);
}

// Load probe results (channel discovery)
let probeChannels = {};
try {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'probe-result.json'), 'utf8'));
  for (const r of probe) probeChannels[r.id] = r.channels || [];
} catch {}

// Store active streams keyed as "camId:channel"
const activeStreams = {};

// Get list of cameras (includes available channels from probe)
app.get('/api/cameras', (req, res) => {
  res.json(cameras.map(c => ({
    id: c.id,
    name: c.name,
    zone: c.zone,
    channels: probeChannels[c.id]?.length ? probeChannels[c.id] : [parseInt(c.channel) || 102],
  })));
});

// PTZ Control
const { request } = require('urllib');
app.post('/api/ptz/:id', async (req, res) => {
  const { command } = req.body; // 'up', 'down', 'left', 'right', 'stop'
  const camera = cameras.find(c => c.id === req.params.id);
  
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  let pan = 0, tilt = 0, zoom = 0;
  // Speed goes from 1 to 100. We use 60 for a faster, responsive pan.
  if (command === 'up') tilt = 60;
  if (command === 'down') tilt = -60;
  if (command === 'left') pan = -60;
  if (command === 'right') pan = 60;
  if (command === 'zoomIn') zoom = 60;
  if (command === 'zoomOut') zoom = -60;
  // 'stop' sends 0, 0, 0

  const xmlPayload = `<PTZData><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`;
  
  try {
    const url = `http://${camera.ip}/ISAPI/PTZCtrl/channels/1/continuous`;
    const response = await request(url, {
      method: 'PUT',
      content: xmlPayload,
      headers: { 'Content-Type': 'application/xml' },
      digestAuth: `${camera.user}:${camera.pass}`
    });
    res.json({ success: true, status: response.status });
  } catch (error) {
    console.error(`PTZ Error for ${camera.id}:`, error.message);
    res.status(500).json({ error: 'PTZ command failed' });
  }
});

// Start a stream
app.post('/api/stream/start/:id', (req, res) => {
  const camId = req.params.id;
  const camera = cameras.find(c => c.id === camId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });

  const channel = req.body?.channel || parseInt(camera.channel) || 102;
  const streamKey = `${camId}:${channel}`;
  const rtspUrl = `rtsp://${camera.user}:${camera.pass}@${camera.ip}:554/Streaming/Channels/${channel}`;

  if (activeStreams[streamKey]) {
    return res.json({ wsPort: activeStreams[streamKey].wsPort });
  }

  const usedPorts = Object.values(activeStreams).map(s => s.wsPort);
  let wsPort = BASE_WS_PORT;
  while (usedPorts.includes(wsPort)) wsPort++;

  console.log(`Starting stream for ${streamKey} on port ${wsPort}`);

  try {
    const stream = new Stream({
      name: streamKey,
      streamUrl: rtspUrl,
      wsPort: wsPort,
      ffmpegOptions: channel === 102
        ? { '-stats': '', '-r': 25, '-q:v': 3 }
        : { '-stats': '', '-r': 15, '-q:v': 7, '-vf': 'scale=640:360' }
    });

    activeStreams[streamKey] = { stream, wsPort };
    res.json({ wsPort });
  } catch (error) {
    console.error(`Error starting stream for ${streamKey}:`, error);
    res.status(500).json({ error: 'Failed to start stream' });
  }
});

// Stop a stream
app.post('/api/stream/stop/:id', (req, res) => {
  const camId = req.params.id;
  const channel = req.body?.channel;
  const streamKey = channel ? `${camId}:${channel}` : camId;

  // Try keyed form first, then legacy bare camId
  const key = activeStreams[streamKey] ? streamKey : (activeStreams[camId] ? camId : null);
  if (key) {
    console.log(`Stopping stream for ${key}`);
    activeStreams[key].stream.stop();
    delete activeStreams[key];
  }
  res.json({ success: true });
});

// Start a playback stream
app.post('/api/stream/playback/:id', (req, res) => {
  const camId = req.params.id;
  const { starttime } = req.body; // format: YYYYMMDDTHHMMSSZ
  const camera = cameras.find(c => c.id === camId);
  
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  if (!starttime) return res.status(400).json({ error: 'starttime required' });

  // Stop existing playback stream for this camera if any
  if (activeStreams[`playback_${camId}`]) {
    activeStreams[`playback_${camId}`].stream.stop();
    delete activeStreams[`playback_${camId}`];
  }

  // Parse starttime to add 1 hour for endtime
  const startYear = parseInt(starttime.substring(0, 4));
  const startMonth = parseInt(starttime.substring(4, 6)) - 1;
  const startDate = parseInt(starttime.substring(6, 8));
  const startHour = parseInt(starttime.substring(9, 11));
  const startMin = parseInt(starttime.substring(11, 13));
  const startSec = parseInt(starttime.substring(13, 15));

  const d = new Date(Date.UTC(startYear, startMonth, startDate, startHour, startMin, startSec));
  d.setHours(d.getHours() + 1); // add 1 hour
  
  const endYear = d.getUTCFullYear();
  const endMonth = String(d.getUTCMonth() + 1).padStart(2, '0');
  const endDate = String(d.getUTCDate()).padStart(2, '0');
  const endHour = String(d.getUTCHours()).padStart(2, '0');
  const endMin = String(d.getUTCMinutes()).padStart(2, '0');
  const endSec = String(d.getUTCSeconds()).padStart(2, '0');
  
  const endtime = `${endYear}${endMonth}${endDate}T${endHour}${endMin}${endSec}Z`;

  // Use NVR details if available, otherwise fallback to direct camera details
  const playIp = camera.nvrIp || camera.ip;
  const playUser = camera.nvrUser || camera.user;
  const playPass = camera.nvrPass || camera.pass;
  
  // For NVRs, the channel track is usually (NvrChannel * 100) + 1 for main stream
  // For direct cameras, it's usually 101.
  const playTrack = camera.nvrChannel ? `${camera.nvrChannel}01` : '101';

  // Playback URL
  const rtspUrl = `rtsp://${playUser}:${playPass}@${playIp}:554/Streaming/tracks/${playTrack}?starttime=${starttime}&endtime=${endtime}`;

  // Assign a free port starting from a higher range to avoid conflict with live views
  const usedPorts = Object.values(activeStreams).map(s => s.wsPort);
  let wsPort = BASE_WS_PORT + 100;
  while (usedPorts.includes(wsPort)) {
    wsPort++;
  }

  const maskedUrl = rtspUrl.replace(`:${playPass}@`, ':***@');
  console.log(`[PLAYBACK] camId=${camId} port=${wsPort}`);
  console.log(`[PLAYBACK] URL: ${maskedUrl}`);

  try {
    const stream = new Stream({
      name: `playback_${camId}`,
      streamUrl: rtspUrl,
      wsPort: wsPort,
      ffmpegOptions: {
        '-rtsp_transport': 'tcp',
        '-stats': '', 
        '-r': 30,
        '-q:v': 5
      }
    });

    activeStreams[`playback_${camId}`] = { stream, wsPort };
    res.json({ wsPort });
  } catch (error) {
    console.error(`Error starting playback for ${camId}:`, error);
    res.status(500).json({ error: 'Failed to start playback stream' });
  }
});

// Stop playback stream
app.post('/api/stream/playback/stop/:id', (req, res) => {
  const camId = req.params.id;
  if (activeStreams[`playback_${camId}`]) {
    activeStreams[`playback_${camId}`].stream.stop();
    delete activeStreams[`playback_${camId}`];
    console.log(`Stopped playback for ${camId}`);
  }
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
