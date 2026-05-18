const axios = require('axios');

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

  const { transcriptId, fileName, slackChannel, recordId, receivedAt } = req.body;
  if (!transcriptId) return res.status(400).send('Missing transcriptId');

  const asmKey = process.env.ASSEMBLYAI_API_KEY;
  const slackToken = process.env.SLACK_BOT_TOKEN;

  res.status(200).send('OK');

  try {
    // ポーリング（最大10分）
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

    const record = {
      id: recordId,
      transcriptId,
      fileName,
      transcript: transcript.text,
      utterances: transcript.utterances || [],
      slackChannel,
      receivedAt,
      status: 'pending'
    };

    await redisSet('transcript:' + record.id, record);
    await redisPush('transcripts:pending', record.id);

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: slackChannel,
      text: `✅ *${fileName}* の文字起こしが完了しました！\n\nカウンセリング分析ツールで分析できます👇\nhttps://chiharuf333.github.io/counseling-tool/`
    }, { headers: { Authorization: 'Bearer ' + slackToken } });

  } catch(err) {
    console.error('POLL ERROR:', err.message);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: slackChannel,
      text: '❌ 文字起こし処理でエラーが発生しました: ' + err.message
    }, { headers: { Authorization: 'Bearer ' + slackToken } }).catch(() => {});
  }
};