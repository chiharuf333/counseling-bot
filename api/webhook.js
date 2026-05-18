const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  if (req.headers['x-webhook-secret'] !== 'counseling-secret-2024') {
    return res.status(401).send('Unauthorized');
  }

  const { transcript_id, status } = req.body;
  
  if (status !== 'completed') return res.status(200).send('OK');

  const asmKey = process.env.ASSEMBLYAI_API_KEY;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  try {
    console.log('Webhook received:', transcript_id);

    const jobResp = await axios.get(`${kvUrl}/get/${encodeURIComponent('job:' + transcript_id)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const job = JSON.parse(jobResp.data.result);
    if (!job) return res.status(200).send('OK');

    const transcriptResp = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcript_id}`, {
      headers: { authorization: asmKey }
    });
    const transcript = transcriptResp.data;

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
      JSON.stringify(record.id),
      { headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' } }
    );

    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: job.channel,
      text: `✅ *${job.fileName}* の文字起こしが完了しました！\n\nカウンセリング分析ツールで確認できます👇\nhttps://chiharuf333.github.io/counseling-tool/`
    }, { headers: { Authorization: 'Bearer ' + slackToken } });

    console.log('Saved to Redis:', record.id);
    return res.status(200).send('OK');

  } catch(err) {
    console.error('WEBHOOK ERROR:', err.message);
    console.error('DETAIL:', JSON.stringify(err.response?.data));
    return res.status(200).send('OK');
  }
};