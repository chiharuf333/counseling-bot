const crypto = require('crypto');
const axios = require('axios');

// Slack署名検証
function verifySlackSignature(req, body) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 60 * 5) return false;
  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBasestring, 'utf8')
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // bodyを文字列で取得
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();
  const body = JSON.parse(rawBody);

  // URL検証（Slack初回確認）
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 署名検証
  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).send('Unauthorized');
  }

  // 音声ファイルのメッセージを検知
  const event = body.event;
  if (!event || event.type !== 'message' || !event.files) {
    return res.status(200).send('OK');
  }

  const audioFile = event.files.find(f =>
    ['mp3', 'm4a', 'mp4', 'wav', 'webm'].includes(f.filetype)
  );
  if (!audioFile) return res.status(200).send('OK');

  const channel = event.channel;
  const token = process.env.SLACK_BOT_TOKEN;

  // 受信メッセージ
  await axios.post('https://slack.com/api/chat.postMessage', {
    channel,
    text: `🎙️ 音声ファイルを受信しました！\n*${audioFile.name}*\n\n分析を開始します...少々お待ちください（1〜2分）`
  }, { headers: { Authorization: `Bearer ${token}` } });

  // 非同期で分析実行
  analyzeAudio(audioFile, channel, token);

  return res.status(200).send('OK');
};

async function analyzeAudio(audioFile, channel, token) {
  try {
    const asmKey = process.env.ASSEMBLYAI_API_KEY;

    // Step1: ファイルURLをSlackから取得してAssemblyAIにアップロード
    const fileResp = await axios.get(audioFile.url_private, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', fileResp.data, {
      headers: { authorization: asmKey, 'content-type': 'application/octet-stream' }
    });
    const audioUrl = uploadResp.data.upload_url;

    // Step2: 文字起こしジョブ投稿
    const transcriptResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: audioUrl,
      language_detection: true,
      speaker_labels: true,
      speakers_expected: 2
    }, { headers: { authorization: asmKey } });

    const transcriptId = transcriptResp.data.id;

    // Step3: 完了待ち
    let result;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: asmKey }
      });
      if (poll.data.status === 'completed') { result = poll.data; break; }
      if (poll.data.status === 'error') throw new Error('文字起こし失敗');
    }

    if (!result) throw new Error('タイムアウト');

    // 話者ラベル付きテキスト生成
    const utterances = result.utterances || [];
    const transcript = utterances.map(u => `[話者${u.speaker}] ${u.text}`).join('\n');

    // Step4: Claude分析
    const claudeResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `以下はカウンセリングの文字起こしです。カウンセラーのスキルを分析してください。

【文字起こし】
${transcript}

以下の形式でJSON（コードブロックなし）で返してください：
{
  "overall": "総合コメント（2文）",
  "goods": [{"title": "良い点1", "body": "説明"}, {"title": "良い点2", "body": "説明"}],
  "improvements": [{"theme": "改善テーマ", "observed": "気づいたこと", "suggestion": "提案"}]
}`
      }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const analysis = JSON.parse(claudeResp.data.content[0].text);

    // Step5: 結果をSlackに投稿
    const goodsText = analysis.goods.map((g, i) => `✅ *${g.title}*\n${g.body}`).join('\n\n');
    const improvText = analysis.improvements.map((imp, i) =>
      `💡 *${imp.theme}*\n気づき：${imp.observed}\n提案：${imp.suggestion}`
    ).join('\n\n');

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '📊 カウンセリング分析レポート' } },
        { type: 'section', text: { type: 'mrkdwn', text: `*総合コメント*\n${analysis.overall}` } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: `*✨ 素敵なポイント*\n\n${goodsText}` }
