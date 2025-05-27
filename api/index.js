require("dotenv").config();
const axios = require("axios");
const { App, ExpressReceiver } = require("@slack/bolt");
const base_prompt = {
  identity: `You are an AI assistant that reads Slack channel conversations and produces concise, high-value summaries. Avoid content that includes sensitive information.`,

  instructions: `Your goal is to extract the most important information and present it clearly.
  1. Analyze the Provided Transcript: Read the entire transcript below. Pay close attention to the formats:
      * Regular messages look like \`<@ USERID> (DisplayName): message content\`.
      * Threaded replies are indented with a leading arrow and space, e.g.  
          \`  ↳ <@USERID> (DisplayName): reply content\`.
        Treat each parent message and its replies as a single conversational unit when identifying key points.
  2. Identify Key Information and focus only on:
      * Significant topics discussed.
      * Decisions made or proposed.
      * Action items assigned (note who is assigned).
      * Important links or files shared (if any).
  3. Ignore Noise: Explicitly ignore the following:
      * Channel join/leave messages (e.g. "... has joined the channel").
      * Simple greetings and farewells (e.g. "hi", "thanks", "gg" , "bye").
      * Filler messages or chit-chat that doesn't add substance.
      * Emojis or reactions (unless critical to understanding context).
  4. Format Output:
      * Produce concise bullet points.
      * Start each bullet point with "•".
      * Crucially: When mentioning a user, use only the Slack mention syntax (\`<@USERID>\`) extracted from the transcript. Do not use the display name from the parentheses or any other format like '@username'. For example, if the transcript shows \`<@U08QK2PPAAJ> (vedantsinghal07): Hi\`, your summary should use \`<@U08QK2PPAAJ>\` if you need to mention that user. (Use <@UID> only if have a clear UID).
      * If you dont have a clear UID or identity of the user, use the name they are being referred to in the conversation, but do not @ this name.
      * Any Slack date-format tokens (<!date^…^…|…>) in the transcript should be preserved in your summary. Feel free to use those tokens directly in your bullets to show when things happened.

  5. Be Concise: Avoid redundancy by combining related points into a single bullet if possible.
     Do not describe the workflow of the conversation itself; state only the final outcomes or decisions.
     In your recap, do not introduce any new names, actions or facts that do not appear in the transcript.
     YSWS stands for "You Ship We Ship". It is a Hack Club term`,
};
const serverless = require("serverless-http");
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

receiver.app.post("/slack/events", (req, res, next) => {
  if (req.body?.type === "url_verification") {
    return res.send(req.body.challenge);
  }
  next();
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: "DEBUG",
});

app.shortcut("app_shortcut", async ({ shortcut, ack, client }) => {
  await ack();
  console.log("Shortcut triggered");
  try {
    const channelId = shortcut.channel.id;
    const threadTs = shortcut.message.thread_ts;
    const messages = [];

    try {
      await client.conversations.join({
        channel: channelId,
      });
    } catch (e) {
      await client.chat.postMessage({
        channel: shortcut.user.id,
        text: "Please make sure I am a member of the channel you want to recap.",
      });
    }

    if (threadTs) {
      let { messages: thread } = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
      });

      thread = thread.filter(
        (msg) => !msg.subtype && msg.user && typeof msg.text === "string"
      );

      if (thread.length > 0) {
        messages.push(thread[0]);
        for (const reply of thread.slice(1)) {
          reply.is_reply = true;
          messages.push(reply);
        }
      }

      const userNames = await fetchUserNames(client, messages);
      const blocks = await summarise(shortcut, messages, userNames, "thread");

      await client.chat.postMessage({
        channel: shortcut.user.id,
        text: "Generating summary...",
        blocks: blocks,
      });
    }
  } catch (e) {
    console.log(e);
    await client.chat.postMessage({
      channel: shortcut.user.id,
      text: "Sorry, I couldn't generate a summary.",
    });
  }
});

app.command("/recap", async ({ command, ack, respond, client }) => {
  await ack();
  console.log("Recap command triggered");
  try {
    const parsedChannelMentions = Array.from(
      command.text.matchAll(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g),
      (match) => ({ id: match[1], name: match[2] })
    );

    const targets = parsedChannelMentions.length
      ? parsedChannelMentions
      : [{ id: command.channel_id, name: command.channel_name }];

    try {
      for (const target of targets) {
        await client.conversations.join({
          channel: target.id,
        });
      }
    } catch (e) {
      await client.chat.postMessage({
        channel: command.user_id,
        text: "Please make sure I am a member of the channels you want to recap.",
      });
    }

    let allBlocks = [];
    const timeRegex = /\b(\d+)([d])\b/i;
    const timeMatch = command.text.match(timeRegex);
    let oldest;

    if (timeMatch) {
      oldest =
        (Date.now() - parseInt(timeMatch[1], 10) * 24 * 60 * 60 * 1000) / 1000;
    } else {
      oldest = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    }

    for (const target of targets) {
      const channelId = target.id;
      const channelName = target.name;
      const history = await client.conversations.history({
        channel: channelId,
        oldest: oldest,
        limit: 100,
      });

      const topLevel = history.messages
        .filter(
          (msg) =>
            !msg.subtype &&
            msg.user &&
            typeof msg.text === "string" &&
            (!msg.thread_ts || msg.thread_ts === msg.ts)
        )
        .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

      const userNames = await fetchUserNames(client, topLevel);

      const enriched = [];
      for (const msg of topLevel) {
        enriched.push(msg);

        if (msg.reply_count && msg.thread_ts === msg.ts) {
          const { messages: thread } = await client.conversations.replies({
            channel: command.channel_id,
            ts: msg.ts,
          });

          for (const reply of thread.slice(1)) {
            reply.is_reply = true;
            enriched.push(reply);
          }
        }
      }

      let wasTruncated = false;
      if (enriched.length > 150) {
        enriched.splice(150);
        wasTruncated = true;
      }
      blocks = await summarise(command, enriched, userNames, "#" + channelName);
      allBlocks.push(blocks);
      if(wasTruncated){
        allBlocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*Note:* The summary was truncated to the most recent 150 messages in this channel.`,
            },
          ],
        });
      }
    }

    allBlocks = allBlocks.flat();

    await respond({
      response_type: "ephemeral",
      blocks: allBlocks,
    });
  } catch (e) {
    console.error(e);
    await respond({
      response_type: "ephemeral",
      text: "Sorry, I couldn't generate a summary. Usage: `/recap [#channel-1] [#channel-2] ...`",
    });
  }
});

async function summarise(event, messages, userNames, channelName) {
  console.log("Summarising messages");
  const transcript = messages
    .map((msg) => {
      const indent = msg.is_reply ? "  ↳ " : "";
      const who = `<@${msg.user}>`;
      const name = userNames[msg.user] || msg.user;
      const tsSeconds = Math.floor(parseFloat(msg.ts));
      const dateToken = `<!date^${tsSeconds}^{date_num} {time}|${new Date(
        tsSeconds * 1000
      ).toLocaleString()}>`;
      return `${indent}${dateToken} ${who} (${name}): ${msg.text}`;
    })
    .join("\n");

  const prompt = buildYourPrompt(transcript);
  const aiRes = await axios
    .post("https://ai.hackclub.com/chat/completions", {
      messages: [{ role: "user", content: prompt }],
    })
    .catch((err) => {
      console.error("Error in API call:", err);
      throw err;
    });

  let rawSummary = aiRes.data.choices[0].message.content.trim();

  let cleaned = rawSummary.replace(/\s*\([^)]*\)/g, "");

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [uid, name] of Object.entries(userNames)) {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, "g");
    cleaned = cleaned.replace(re, `<@${uid}>`);
  }

  cleaned = cleaned.replace(/(<@[^>]+>)(?:\s+\1)+/g, "$1");

  const bullets = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("•"))
    .map((l) => l.replace(/^•\s*/, ""));

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "📝 " + channelName + " summary" },
    },
    { type: "divider" },
    ...bullets.map((pt) => ({
      type: "section",
      text: { type: "mrkdwn", text: `• ${pt}` },
    })),
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Summarized for <@${
            event.user_id || event.user || event.user.id
          }> • ${new Date().toLocaleString()}_`,
        },
      ],
    },
  ];

  return blocks;
}

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
  const prompt =
    "<identity>\n" +
    base_prompt.identity +
    "</identity>\n" +
    "<instructions>\n" +
    base_prompt.instructions +
    "</instructions>\n" +
    `Here is the conversation transcript:
  ${transcript}
  `.trim();
  return prompt;
}

(async () => {
  const port = process.env.PORT;
  await app.start(port);
  console.log(`Bolt app is running on port ${port}`);
})();
