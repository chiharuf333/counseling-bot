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

  res.status(200).send('OK');

  analyzeAudio(audioFile, channel, token);
};

async function analyzeAudio(audioFile, channel, token) {
  try {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      text: '🎙️ 音声ファイルを受信しました！\n*' + audioFile.name + '*\n\n分析中...少々お待ちください（1〜2分）'
    }, { headers: { Authorization: 'Bearer ' + token } });

    const asmKey = process.env.ASSEMBLYAI_API_KEY;

    const fileResp = await axios.get(audioFile.url_private, {
      headers: { Authorization: 'Bearer ' + token },
      responseType: 'arraybuffer'
    });

    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', fileResp.data, {
      headers: { authorization: asmKey, 'content-type': 'application/octet-stream' }
    });

    const transcriptResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadResp.data.upload_url,
      language_detection: true,
      speaker_labels: true,
      speakers_expected: 2
    }, { headers: { authorization: asmKey } });

    const transcriptId = transcriptResp.data.id;

    var result;
    for (var i = 0; i < 60; i++) {
      await new Promise(function(r) { setTimeout(r, 5000); });
      const poll = await axios.get(
        'https://api.assemblyai.com/v2/transcript/' + transcriptId,
        { headers: { authorization: asmKey } }
      );
      if (poll.data.status === 'completed') { result = poll.data; break; }
      if (poll.data.status === 'error') throw new Error('文字起こし失敗');
    }

    if (!result) throw new Error('タイムアウト');

    const utterances = result.utterances || [];
    const transcript = utterances.map(function(u) {
      return '[話者' + u.speaker + '] ' + u.text;
    }).join('\n');

    const claudeResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: '以下はカウンセリングの文字起こしです。カウンセラーのスキルを分析してください。\n\n【文字起こし】\n' + transcript + '\n\nJSONのみで返してください（コードブロック不要）:\n{"overall":"総合コメント","goods":[{"title":"良い点","body":"説明"}],"improvements":[{"theme":"テーマ","observed":"気づき","suggestion":"提案"}]}'
      }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const analysis = JSON.parse(claudeResp.data.content[0].text);
    const goodsText = analysis.goods.map(function(g) {
      return '✅ *' + g.title + '*\n' + g.body;
    }).join('\n\n');
    const improvText = analysis.improvements.map(function(imp) {
      return '💡 *' + imp.theme + '*\n気づき：' + imp.observed + '\n提案：' + imp.suggestion;
    }).join('\n\n');

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '📊 カウンセリング分析レポート' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*総合コメント*\n' + analysis.overall } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*✨ 素敵なポイント*\n\n' + goodsText } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*🔧 改善ポイント*\n\n' + improvText } }
      ]
    }, { headers: { Authorization: 'Bearer ' + token } });

  } catch(err) {
    console.error(err);
    axios.post('https://slack.com/api/chat.postMessage', {
      channel: channel,
      text: '❌ エラーが発生しました: ' + err.message
    }, { headers: { Authorization: 'Bearer ' + token } }).catch(function() {});
  }
}
