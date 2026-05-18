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
  console.log('EVENT TYPE:', event && event.type);
  console.log('SUBTYPE:', event && event.subtype);
  console.log('HAS FILES:', event && event.files && event.files.length);
  console.log('BOT ID:', event && event.bot_id);

  if (!event || !event.files) {
    return res.status(200).send('OK');
  }

  const audioFile = event.files.find(function(f) {
    return ['mp3', 'm4a', 'mp4', 'wav', 'webm'].includes(f.filetype);
  });

  console.log('AUDIO FILE:', audioFile && audioFile.name);

  if (!audioFile) return res.status(200).send('OK');

  const channel = event.channel;
  const token = process.env.SLACK_BOT_TOKEN;

  const toolUrl = 'https://chiharuf333.github.io/counseling-tool/?audio='
    + encodeURIComponent(audioFile.url_private)
    + '&token=' + encodeURIComponent(token);

  await axios.post('https://slack.com/api/chat.postMessage', {
    channel: channel,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '🎙️ 音声ファイルを受信しました！\n*' + audioFile.name + '*\n\n以下のリンクから分析できます👇'
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📊 分析ツールで開く' },
            url: toolUrl,
            style: 'primary'
          }
        ]
      }
    ]
  }, { headers: { Authorization: 'Bearer ' + token } });

  return res.status(200).send('OK');
};
