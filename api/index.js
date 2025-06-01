require("dotenv").config();
const axios = require("axios");
const { App, ExpressReceiver } = require("@slack/bolt");
const base_prompt = require("./prompt.js");
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
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

receiver.app.post("/api/cron", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("Cron job triggered");

  try {
    const channelsToSummarize = process.env.CRON_CHANNELS?.split(",");
    const summaryChannelId = process.env.SUMMARY_CHANNEL_ID;

    if (channelsToSummarize.length === 0) {
      return res
        .status(200)
        .json({ message: "No channels configured for summary" });
    }

    if (!summaryChannelId) {
      return res
        .status(400)
        .json({ error: "SUMMARY_CHANNEL_ID not configured" });
    }
    
    const oldest = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    for (const channelId of channelsToSummarize) {
      try {
        await app.client.conversations.join({ channel: channelId });
        await app.client.conversations.join({ channel: summaryChannelId });
        
        const channelInfo = await app.client.conversations.info({
          channel: channelId,
        });
        const channelName = channelInfo.channel.name;

        const history = await app.client.conversations.history({
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

        if (topLevel.length === 0) {
          console.log(
            `No messages found in ${channelName} for the last 24 hours`
          );
          continue;
        }

        const userNames = await fetchUserNames(app.client, topLevel);

        const enriched = [];
        for (const msg of topLevel) {
          enriched.push(msg);

          if (msg.reply_count && msg.thread_ts === msg.ts) {
            const { messages: thread } = await app.client.conversations.replies(
              {
                channel: channelId,
                ts: msg.ts,
              }
            );

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

        const mockEvent = {
          user_id: "CRON_JOB",
          user: "CRON_JOB",
        };

        const blocks = await summarise(
          mockEvent,
          enriched,
          userNames,
          "#" + channelName
        );

        const finalBlocks = [...blocks];
        if (wasTruncated) {
          finalBlocks.push({
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*Note:* The summary was truncated to the most recent 150 messages.`,
              },
            ],
          });
        }

        const threadTs = await findOrCreateChannelThread(
          summaryChannelId,
          channelName
        );

        await app.client.chat.postMessage({
          channel: summaryChannelId,
          thread_ts: threadTs,
          text: `📝 Daily Summary for #${channelName} - ${new Date().toLocaleDateString()}`,
          blocks: finalBlocks,
        });

        console.log(
          `Posted daily summary for #${channelName} in thread ${threadTs}`
        );
      } catch (error) {
        console.error(`Error processing channel ${channelId}:`, error);
      }
    }

    res.status(200).json({ message: "Cron job completed successfully" });
  } catch (e) {}
});

async function findOrCreateChannelThread(summaryChannelId, channelName) {
  try {
    const history = await app.client.conversations.history({
      channel: summaryChannelId,
      limit: 100,
    });

    const threadStarter = history.messages.find(msg => 
      msg.text && 
      msg.text === `Daily summaries for #${channelName}` &&
      (!msg.thread_ts || msg.thread_ts === msg.ts)
    );

    if (threadStarter) {
      return threadStarter.ts;
    }

    const response = await app.client.chat.postMessage({
      channel: summaryChannelId,
      text: `Daily summaries for #${channelName}`,
      blocks: [
        {
          type: "header",
          text: { 
            type: "plain_text", 
            text: `Daily summaries for #${channelName}` 
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `This thread contains daily summaries for <#${channelName}>. Each summary covers the previous 24 hours of activity.`,
            },
          ],
        },
      ],
    });

    return response.ts;

  } catch (error) {
    console.error(`Error managing thread for ${channelName}:`, error);
    throw error;
  }
}

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

// app.command("/add", async ({ command, ack, respond, client }) => {
//   await ack();
//   console.log("Add command triggered");
//   try {
//     const parsedChannelMentions = Array.from(
//       command.text.matchAll(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g),
//       (match) => ({ id: match[1], name: match[2] })
//     );

//     const targets = parsedChannelMentions.length
//       ? parsedChannelMentions
//       : [{ id: command.channel_id, name: command.channel_name }];

//     console.log(targets.map(t => t.id).join(','));

//   } catch (e) {
//     console.log(e);
//   }
// });

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
            channel: target.id,
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
      if (wasTruncated) {
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
  cleaned = cleaned.replace(/^\s*\*\s/gm, "• ");
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

// (async () => {
//   const port = process.env.PORT;
//   await app.start(port);
//   console.log(`Bolt app is running on port ${port}`);
// })();  

module.exports = receiver.app;
