const axios = require('axios');

// Upstash Redis REST API helper
async function redisSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  await axios.post(`${url}/set/${encodeURIComponent(key)}`, 
    JSON.stringify(value),
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

async function redisPush(listKey, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  await axios.post(`${url}/lpush/${encodeURIComponent(listKey)}`,
    JSON.stringify(JSON.stringify(value)),
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

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

  // Slackに即座に返答（タイムアウト防止）
  res.status(200).send('OK');

  try {
    // 1. Slackから音声ファイルを取得
    const fileResp = await axios.get(audioFile.url_private_download || audioFile.url_private, {
      headers: { Authorization: 'Bearer ' + slackToken },
      responseType: 'arraybuffer',
      maxContentLength: 50 * 1024 * 1024
    });

    // 2. AssemblyAIにアップロード
    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', fileResp.data, {
      headers: { authorization: asmKey, 'content-type': 'application/octet-stream' },
      maxContentLength: 50 * 1024 * 1024
    });

    // 3. 文字起こし開始
    const transcriptResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadResp.data.upload_url,
      speech_models: ["universal-3-pro", "universal-2"],
      language_detection: true,
      speaker_labels: true,
      speakers_expected: 2
    }, { headers: { authorization: asmKey } });

    const transcriptId = transcriptResp.data.id;

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: `🎙️ *${audioFile.name}* の文字起こしを開始しました！\n完了までしばらくお待ちください（1〜2分）`
    }, { headers: { Authorization: 'Bearer ' + slackToken } });

    // 4. 完了までポーリング（最大10分）
    let transcript = null;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: asmKey }
      });
      if (poll.data.status === 'completed') { transcript = poll.data; break; }
      if (poll.data.status === 'error') throw new Error('文字起こしエラー: ' + poll.data.error);
    }
    if (!transcript) throw new Error('タイムアウト');

    // 5. Redisに保存
    const record = {
      id: 'rec_' + Date.now(),
      transcriptId,
      fileName: audioFile.name,
      transcript: transcript.text,
      utterances: transcript.utterances || [],
      slackChannel: channel,
      receivedAt: new Date().toISOString(),
      status: 'pending' // 未分析
    };

    await redisSet('transcript:' + record.id, record);
    await redisPush('transcripts:pending', record.id);

    // 6. Slackに完了通知
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: `✅ *${audioFile.name}* の文字起こしが完了しました！\n\nカウンセリング分析ツールで分析できます👇\nhttps://chiharuf333.github.io/counseling-tool/`
    }, { headers: { Authorization: 'Bearer ' + slackToken } });

  } catch(err) {
    console.error('ERROR:', err.message);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: '❌ エラーが発生しました: ' + err.message
    }, { headers: { Authorization: 'Bearer ' + slackToken } }).catch(() => {});
  }
};