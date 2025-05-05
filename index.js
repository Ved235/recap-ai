require("dotenv").config();
const axios = require("axios");
const { App, ExpressReceiver } = require("@slack/bolt");

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

receiver.app.post("/slack/events", (req, res, next) => {
  if (req.body?.type === "url_verification") {
    return res.status(200).send(req.body.challenge);
  }
  next();
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.command("/recap", async ({ command, ack, respond, client }) => {
  await ack();

  try {
    const history = await client.conversations.history({
      channel: command.channel_id,
      limit: 50,
    });

    const userNames = await fetchUserNames(client, history.messages);

    const transcript = history.messages
      .reverse()
      .map((msg) => {
        if (!msg.user) return `_system_: ${msg.text || "[no text]"}`;
        const name = userNames[msg.user] || msg.user;
        return `<@${msg.user}> (${name}): ${msg.text || "[no text]"}`;
      })
      .join("\n");

    const prompt = `
      <identity>
      You are an AI assistant that reads Slack channel conversations and produces concise, high-value recaps.
      When asked for your name, you must respond with "ChannelRecapBot".
      Follow the user's requirements carefully & to the letter.
      Avoid content that violates privacy—do not include verbatim sensitive information.
      If asked to generate content unrelated to summarization of Slack channels, respond with "Sorry, I can't assist with that."
      Keep your answers short and impersonal.
      </identity>
      
      <instructions>
      You are a highly sophisticated automated summarization agent with expert-level knowledge of Slack’s conversational context.
      When invoked, fetch only the messages since the user’s last unread.
      • Output exactly 4–6 bullet points as plain text, each starting with "• ".
      • Include only:
         - Key topics discussed
         - Decisions made
         - Action items (with assignees, using <@UID> mentions)
         - Important links or files shared
      • Use Slack mention syntax (<@UID>) so Slack will render display names.
      • Omit trivial chit-chat (greetings, emojis, filler).
      • Use **only** the names in parentheses (e.g. “Vedant Singhal”) when referring to speakers.
      • Do NOT re-emit any raw IDs or try to rename people.
      </instructions>
      
      Here is the conversation transcript:
      ${transcript}
      `.trim();
    console.log(transcript);
    const aiRes = await axios.post("https://ai.hackclub.com/chat/completions", {
      messages: [{ role: "user", content: prompt }],
    });
    const rawSummary = aiRes.data.choices[0].message.content.trim();

    const bullets = rawSummary
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => line.replace(/^[-•\d\.\)]\s*/, ""));

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "📝 Channel Summary" },
      },
      { type: "divider" },
      ...bullets.map((point) => ({
        type: "section",
        text: { type: "mrkdwn", text: `• ${point}` },
      })),
      { type: "divider" },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_Summarized for <@${
              command.user_id
            }> • ${new Date().toLocaleString()}_`,
          },
        ],
      },
    ];

    await respond({
      response_type: "ephemeral",
      blocks,
    });
  } catch (err) {
    console.error("Recap error:", err);
    await respond({
      response_type: "ephemeral",
      text: "Sorry, I couldn't generate a summary right now.",
    });
  }
});

async function fetchUserNames(clients, messages) {
  const userIds = [
    ...new Set(
      messages.map((m) => m.user).filter((u) => typeof u === "string")
    ),
  ];

  const userNames = {};
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const res = await clients.users.info({ user: id });
        const profile = res.user.profile || {};
        userNames[id] =
          profile.display_name_normalized ||
          profile.real_name_normalized ||
          res.user.name;
      } catch (err) {
        console.error(`Error fetching user info for ${id}:`, err);
      }
    })
  );

  return userNames;
}

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}`);
})();
