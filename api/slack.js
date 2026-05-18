const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return res.status(400).send('Bad Request'); }

  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event || !event.files) return res.status(200).send('OK');

  const audioFile = event.files.find(f =>
    ['mp3', 'm4a', 'mp4', 'wav', 'webm'].includes(f.filetype)
  );
  if (!audioFile) return res.status(200).send('OK');

  const channel = event.channel;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const asmKey = process.env.ASSEMBLYAI_API_KEY;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  try {
    const fileResp = await axios.get(audioFile.url_private_download || audioFile.url_private, {
      headers: { Authorization: 'Bearer ' + slackToken },
      responseType: 'arraybuffer',
      maxContentLength: 50 * 1024 * 1024
    });

    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', fileResp.data, {
      headers: { authorization: asmKey, 'content-type': 'application/octet-stream' },
      maxContentLength: 50 * 1024 * 1024
    });

    const webhookUrl = 'https://counseling-bot-eight.vercel.app/api/webhook';
    const transcriptResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadResp.data.upload_url,
      language_detection: true,
      speaker_labels: true,
      speakers_expected: 2,
      webhook_url: webhookUrl,
      webhook_auth_header_name: 'x-webhook-secret',
      webhook_auth_header_value: 'counseling-secret-2024'
    }, { headers: { authorization: asmKey } });

    const transcriptId = transcriptResp.data.id;
    const recordId = 'rec_' + Date.now();

    await axios.post(`${kvUrl}/set/${encodeURIComponent('job:' + transcriptId)}`,
      JSON.stringify({ channel, fileName: audioFile.name, recordId, receivedAt: new Date().toISOString() }),
      { headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' } }
    );

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: `🎙️ *${audioFile.name}* の文字起こしを開始しました！\n完了したらここに通知します。`
    }, { headers: { Authorization: 'Bearer ' + slackToken } });

    console.log('Started:', transcriptId);
    return res.status(200).send('OK');

  } catch(err) {
    console.error('ERROR:', err.message);
    console.error('DETAIL:', JSON.stringify(err.response?.data));
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: '❌ エラーが発生しました: ' + err.message
    }, { headers: { Authorization: 'Bearer ' + slackToken } }).catch(() => {});
    return res.status(200).send('OK');
  }
};