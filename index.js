require("dotenv").config();
const axios = require("axios");
const { App, ExpressReceiver } = require("@slack/bolt");
const base_prompt = require("./prompt.js");

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
});

app.event("app_mention", async ({ event, client }) => {
  try {
    const text = (event.text || "").toLowerCase();
    if (!text.includes("recap")) {
      console.log("Not a recap request");
      return;
    }

    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;
    const twentyFourHoursAgo = (Date.now() - 24 * 60 * 60 * 1000) / 1000;

    const messages = [];

    if (event.thread_ts) {
      console.log("Thread message");
      const { messages: thread } = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
      });
      messages.push(thread[0]);
      for (const reply of thread.slice(1)) {
        reply.is_reply = true;
        messages.push(reply);
      }
      // Remove the last message because it would be the recap command
      messages.pop(); 
    }

    console.log("messages",messages);
    const userNames = await fetchUserNames(client, messages);
    const transcript = messages
      .map((msg) => {
        const indent = msg.is_reply ? "  ↳ " : "";
        const who = `<@${msg.user}>`;
        const name = userNames[msg.user] || msg.user;
        return `${indent}${who} (${name}): ${msg.text}`;
      })
      .join("\n");
      const prompt = buildYourPrompt(transcript);

      const aiRes = await axios.post(
        "https://ai.hackclub.com/chat/completions",
        {
          messages: [{ role: "user", content: prompt }],
        }
      );

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
          text: { type: "plain_text", text: "📝 thread summary" },
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
                event.user
              }> • ${new Date().toLocaleString()}_`,
            },
          ],
        },
      ];

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: blocks,});
    
  } catch (e) {
    console.log(e);
    await respond({
      response_type: "ephemeral",
      text: "Sorry, I couldn't generate a summary.",
    });
  }
});

app.command("/recap", async ({ command, ack, respond, client }) => {
  await ack();

  try {
    const parsedChannelMentions = Array.from(
      command.text.matchAll(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g),
      (match) => ({ id: match[1], name: match[2] })
    );

    const targets = parsedChannelMentions.length
      ? parsedChannelMentions
      : [{ id: command.channel_id, name: command.channel_name }];

    let allBlocks = [];

    for (const target of targets) {
      const channelId = target.id;
      const channelName = target.name;

      console.log(
        `Recapping channel ${channelId} (${channelName}) for user ${command.user_id}`
      );

      const twentyFourHoursAgo = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
      const history = await client.conversations.history({
        channel: channelId,
        //oldest: twentyFourHoursAgo,
        limit: 200,
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

      const transcript = enriched
        .map((msg) => {
          const indent = msg.is_reply ? "  ↳ " : "";
          const who = `<@${msg.user}>`;
          const name = userNames[msg.user] || msg.user;
          return `${indent}${who} (${name}): ${msg.text}`;
        })
        .join("\n");
      const prompt = buildYourPrompt(transcript);

      const aiRes = await axios.post(
        "https://ai.hackclub.com/chat/completions",
        {
          messages: [{ role: "user", content: prompt }],
        }
      );

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

      allBlocks.push([
        {
          type: "header",
          text: { type: "plain_text", text: "📝 #" + channelName + " summary" },
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
                command.user_id
              }> • ${new Date().toLocaleString()}_`,
            },
          ],
        },
      ]);
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
