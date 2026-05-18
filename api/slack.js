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

  // URL検証（Slack初回確認）
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 署名検証
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (timestamp && signature) {
    const sigBase = 'v0:' + timestamp + ':' + rawBody;
    const mySig = 'v0=' + crypto
      .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
      .update(sigBase, 'utf8')
      .digest('hex');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(signature))) {
        return res.status(401).send('Unauthorized');
      }
    } catch(e) { return res.status(401).send('Unauthorized'); }
  }

  const event = body.event;
  if (!event || event.type !== 'message' || event.bot_id || !event.files) {
    return res.status(200).send('OK');
  }

  const audioFile = event.files.find(function(f) {
    return ['mp3', 'm4a', 'mp4', 'wav', 'webm'].includes(f.filetype);
  });
  if (!audioFile) return res.status(200).send('OK');

  const channel = event.channel;
  const token = process.env.SLACK_BOT_TOKEN;

  // ツールのURLを生成（音声URLとtokenをパラメータで渡す）
  const toolUrl = 'https://chiharuf333.github.io/counseling-tool/?audio='
    + encodeURIComponent(audioFile.url_private)
    + '&token=' + encodeURIComponent(token);

  // SlackにツールのURLを送信
  await axios.post('https://slack.com/api/chat.postMessage', {
    channel: channel,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '🎙️ 音声ファイルを受信しました！\n*' + audioFile.name + '*\n\n以下のリンクからカウンセリング分析ツールで分析できます👇'
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
