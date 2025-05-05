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
    // 1) fetch last 50 messages
    const history = await client.conversations.history({
      channel: command.channel_id,
      limit: 50
    });

    // 2) build userNames map
    const userNames = await fetchUserNames(client, history.messages);

    // 3) build transcript WITH parentheses
    const transcript = history.messages
      .reverse()
      .filter(msg => !msg.subtype && typeof msg.text === "string")
      .map(msg => {
        if (!msg.user) {
          return `_system_: ${msg.text || "[no text]"}`;
        }
        const name = userNames[msg.user] || msg.user;
        return `<@${msg.user}> (${name}): ${msg.text || "[no text]"}`;
      })
      .join("\n");

    // 4) build your prompt (omitted for brevity)
    const prompt = buildYourPrompt(transcript);

    // 5) call the AI
    const aiRes = await axios.post(
      "https://ai.hackclub.com/chat/completions",
      { messages: [{ role: "user", content: prompt }] }
    );
    let rawSummary = aiRes.data.choices[0].message.content.trim();

    // 6) strip ALL parenthesized bits so "(vedantsinghal07)" etc. are gone
    let cleaned = rawSummary.replace(/\s*\([^)]*\)/g, "");

    // 7) map full display‐names back into <@UID>
    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [uid, name] of Object.entries(userNames)) {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`, "g");
      cleaned = cleaned.replace(re, `<@${uid}>`);
    }

    // 8) collapse any accidental duplicate mentions
    cleaned = cleaned.replace(/(<@[^>]+>)(?:\s+\1)+/g, "$1");

    // 9) split into bullets
    const bullets = cleaned
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.startsWith("•"))
      .map(l => l.replace(/^•\s*/, ""));

    // 10) build Block Kit
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "📝 Channel Summary" } },
      { type: "divider" },
      ...bullets.map(pt => ({
        type: "section",
        text: { type: "mrkdwn", text: `• ${pt}` }
      })),
      { type: "divider" },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_Summarized for <@${command.user_id}> • ${new Date().toLocaleString()}_`
          }
        ]
      }
    ];

    await respond({ response_type: "ephemeral", blocks });

  } catch (e) {
    console.error(e);
    await respond({
      response_type: "ephemeral",
      text: "Sorry, I couldn't generate a clean summary just now."
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

function buildYourPrompt(transcript) {
  // Note: The transcript provided to the AI includes user display names in parentheses
  // like <@U123ABC> (Real Name). The AI needs to extract the <@U123ABC> part for mentions.
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
You are a highly sophisticated automated summarization agent analyzing the provided Slack conversation transcript.
Your goal is to extract the most important information and present it clearly.

1.  **Analyze the Provided Transcript:** Read the entire transcript below. Pay close attention to the format: messages often look like \`<@USERID> (DisplayName): message content\`.
2.  **Identify Key Information:** Focus *only* on:
    *   Significant topics discussed.
    *   Decisions made or proposed.
    *   Action items assigned (note who is assigned).
    *   Important links or files shared (if any).
3.  **Ignore Noise:** Explicitly **ignore** the following:
    *   Channel join/leave messages (e.g., "... has joined the channel").
    *   Simple greetings, farewells, or acknowledgments (e.g., "hi", "thanks", "ok", "gg").
    *   Filler messages or chit-chat that doesn't add substance.
    *   Emojis or reactions (unless critical to understanding context, which is rare).
4.  **Format Output:**
    *   Produce exactly 4–6 concise bullet points.
    *   Start each bullet point with "• ".
    *   **Crucially:** When mentioning a user, use **only** the Slack mention syntax (\`<@USERID>\`) extracted from the transcript. **Do not** use the display name from the parentheses or any other format like '@username'. For example, if the transcript shows \`<@U08QK2PPAAJ> (vedantsinghal07): Hi\`, your summary should use \`<@U08QK2PPAAJ>\` if you need to mention that user. (Use <@UID> only if have a clear UID else just use partial name)
5.  **Be Concise:** Avoid redundancy. Combine related points into a single bullet if possible. Do not describe the conversation itself; state the outcomes.
</instructions>

Here is the conversation transcript:
${transcript}
`.trim();
  console.log(transcript)
  return prompt;
}

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}`);
})();
