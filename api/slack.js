const crypto = require('crypto');
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

  const audioFile = event.files.find(function(f) {
    return ['mp3', 'm4a', 'mp4', 'wav', 'webm'].includes(f.filetype);
  });
  if (!audioFile) return res.status(200).send('OK');

  const channel = event.channel;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const asmKey = process.env.ASSEMBLYAI_API_KEY;

  try {
    // 1. Slackから音声ファイルを取得
    const fileResp = await axios.get(audioFile.url_private_download || audioFile.url_private, {
      headers: { Authorization: 'Bearer ' + slackToken },
      responseType: 'arraybuffer',
      maxContentLength: 50 * 1024 * 1024
    });

    // 2. AssemblyAIにアップロード
    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', fileResp.data, {
      headers: {
        authorization: asmKey,
        'content-type': 'application/octet-stream'
      },
      maxContentLength: 50 * 1024 * 1024
    });
    const uploadUrl = uploadResp.data.upload_url;

    // 3. 文字起こし開始
    const transcriptResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadUrl,
      speech_models: ["universal-3-pro", "universal-2"],
      language_detection: true,
      speaker_labels: true,
      speakers_expected: 2
    }, { headers: { authorization: asmKey } });

    const transcriptId = transcriptResp.data.id;

    // 4. Slackに通知
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      text: '🎙️ *' + audioFile.name + '* の文字起こしを開始しました！\n\n文字起こしID: `' + transcriptId + '`\n\n完了までしばらくお待ちください（1〜2分）'
    }, { headers: { Authorization: 'Bearer ' + slackToken } });

    return res.status(200).send('OK');

  } catch(err) {
    console.error('ERROR:', err.message);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      text: '❌ エラーが発生しました: ' + err.message
    }, { headers: { Authorization: 'Bearer ' + slackToken } }).catch(function(){});

    return res.status(200).send('OK');
  }
};
