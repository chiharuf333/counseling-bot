const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // 認証チェック
  if (req.headers['x-webhook-secret'] !== 'counseling-secret-2024') {
    return res.status(401).send('Unauthorized');
  }

  const { transcript_id, status } = req.body;
  if (status !== 'completed') return res.status(200).send('OK');

  res.status(200).send('OK');

  const asmKey = process.env.ASSEMBLYAI_API_KEY;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  try {
    // 1. ジョブ情報をRedisから取得
    const jobResp = await axios.get(`${kvUrl}/get/${encodeURIComponent('job:' + transcript_id)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const job = JSON.parse(jobResp.data.result);
    if (!job) return;

    // 2. AssemblyAIから文字起こし結果を取得
    const transcriptResp = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcript_id}`, {
      headers: { authorization: asmKey }
    });
    const transcript = transcriptResp.data;

    // 3. Redisに保存
    const record = {
      id: job.recordId,
      transcriptId: transcript_id,
      fileName: job.fileName,
      transcript: transcript.text,
      utterances: transcript.utterances || [],
      slackChannel: job.channel,
      receivedAt: job.receivedAt,
      status: 'pending'
    };

    await axios.post(`${kvUrl}/set/${encodeURIComponent('transcript:' + record.id)}`,
      JSON.stringify(record),
      { headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' } }
    );

    await axios.post(`${kvUrl}/lpush/${encodeURIComponent('transcripts:pending')}`,
      JSON.stringify(JSON.stringify(record.id)),
      { headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' } }
    );

    // 4. Slackに完了通知
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: job.channel,
      text: `✅ *${job.fileName}* の文字起こしが完了しました！\n\nカウンセリング分析ツールで確認できます👇\nhttps://chiharuf333.github.io/counseling-tool/`
    }, { headers: { Authorization: 'Bearer ' + slackToken } });

  } catch(err) {
    console.error('WEBHOOK ERROR:', err.message);
  }
};