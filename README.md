# Recap AI
An open-sourced slack bot that turns long conversations in short and high value summaries. 


## Usage

- **Thread Recap**: Right-click any message in a thread and choose **“Recap Thread”** to get an in-thread summary of that conversation
<p align="center">
  <img src="https://github.com/user-attachments/assets/aa8e00c3-36d5-4aff-856e-478d4b37b6d5"/>
</p>

- **Channel Recap**: Run the slash command `/recap [time] [#channels…]` to summarize the last _N_ days of activity across one or more channels. Currently this feature is limited to a maximum of 150 messages in one summary.


## Running it yourself
Currently the bot is only addded to the HackClub slack and worksapce. To use it in some other workspace:

Install the dependencies: 

```bash
npm install
```

Create a `.env` file with the following values:

```env
SLACK_BOT_TOKEN=""
SLACK_SIGNING_SECRET=""
PORT=
```
_The bot token and signing secret can be obtained by creatig a slack app. While creating the slack app you can use the existing `app_manifest.json` to directly load the correct scopes and initial settings, but be sure to change the URLs._

Currently this has been deployed on [NEST](https://www.hackclub.app/) (_thanks to HackClub_). To run this locally:

```bash
node .\api\index.js
```

If you like this project please consiider staring ⭐ it :>

