require('dotenv').config();
const axios = require('axios');
const { App, ExpressReceiver } = require('@slack/bolt');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

receiver.app.post('/slack/events', (req, res, next) => {
  if (req.body?.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }
  next();
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.command('/recap', async ({ command, ack, respond, client }) => {
  await ack();

  try {
    const history = await client.conversations.history({
      channel: command.channel_id,
      limit: 10,
    });

    const transcript = history.messages
      .reverse()
      .map(msg => {
        const who = msg.user ? `<@${msg.user}>` : '_system_';
        return `${who}: ${msg.text || '[no text]'}`;
      })
      .join('\n');

    const prompt = `
Please provide a concise bullet-point summary of this Slack conversation:

${transcript}
`.trim();

    const aiRes = await axios.post(
      'https://ai.hackclub.com/chat/completions',
      { messages: [{ role: 'user', content: prompt }] }
    );

    const summary = aiRes.data.choices[0].message.content.trim();

    await respond({
      response_type: 'ephemeral', 
      text: `*Here’s your summary:*\n${summary}`,
    });
  } catch (err) {
    console.error('Recap error:', err);
    await respond({
      response_type: 'ephemeral',
      text: "Sorry, I couldn't generate a summary right now.",
    });
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}`);
})();
